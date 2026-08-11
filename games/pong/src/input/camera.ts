// Webcam hand tracking — MediaPipe GestureRecognizer: one hand, VIDEO running
// mode, GPU delegate, wasm + model fetched from a CDN. Shows the camera feed
// with a green-connector / red-landmark hand skeleton overlay in a rounded
// panel bottom-right, and reports the wrist landmark (index 0) x ∈ [0,1]
// whenever a hand is in frame. It reports nothing when no hand is visible —
// the caller decides when the hand is "lost" (see HAND_TIMEOUT_MS).
//
// Cost-gated, because the recognizer is ~17 MB of third-party wasm + model AND
// a camera-permission prompt: none of that is on the boot path. The library
// itself is a dynamic import so it stays out of the main chunk, and starting is
// the caller's call (see main.ts — fine pointers auto-enable after load, a
// phone taps the panel rather than spending cellular data on an input it can
// already do with a finger).
//
// Failure (no camera, permission denied, wasm/model fetch error) shows a
// status line in the panel and leaves pointer control untouched.

import type { DrawingUtils, GestureRecognizer } from "@mediapipe/tasks-vision";

import { CLICK_DRAG_TOLERANCE_PX } from "../shared/constants";
import { COARSE_INPUT } from "../shared/input-mode";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

/** `off` — never asked for; `loading` — fetching the model / opening the
 *  camera; `live` — a feed is running; `error` — unavailable on this device. */
export type HandCameraState = "off" | "loading" | "live" | "error";

export type HandCamera = {
  /** Start tracking. Idempotent — ignored once loading or live. */
  enable(): void;
  stop(): void;
};

// One panel per page, so the state a control surface asks about is module
// state: instruction copy is rendered from anywhere (banner, pause card) and
// must not have to be handed a tracker reference to know if hands work.
let state: HandCameraState = "off";
const watchers = new Set<(state: HandCameraState) => void>();

export function handCameraState(): HandCameraState {
  return state;
}

/** Fires when tracking becomes available or unavailable, so instruction
 *  surfaces can stop advertising ✋/✊ on a device where they do nothing. */
export function watchHandCamera(onChange: (state: HandCameraState) => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

// A held fist should confirm once, not re-fire every recognition frame.
const FIST_COOLDOWN_MS = 800;

export function createHandCamera(onWristX: (x: number) => void, onFist?: () => void): HandCamera {
  // ---- panel DOM (styles in index.html) -----------------------------------
  const panel = document.createElement("div");
  panel.id = "camera-panel";
  panel.dataset.state = "off";
  // A phone opts in, so the panel starts as the compact pill: an unasked-for
  // 4:3 preview over the court would be pure occlusion before it can show
  // anything.
  panel.dataset.min = COARSE_INPUT ? "1" : "0";
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  const canvas = document.createElement("canvas");
  const status = document.createElement("div");
  status.id = "camera-status";
  panel.append(video, canvas, status);
  panel.setAttribute("role", "button");
  panel.setAttribute("aria-label", "turn on hand control");
  document.body.appendChild(panel);

  const setState = (next: HandCameraState): void => {
    if (next === state) return;
    state = next;
    panel.dataset.state = next;
    panel.setAttribute(
      "aria-label",
      next === "off" ? "turn on hand control" : "toggle hand-control camera panel",
    );
    for (const watcher of watchers) watcher(next);
  };

  // The panel sits over the court, whose only touch control is a drag on the
  // play area. Swallowing pointerdown/up keeps a tap on the panel from also
  // serving; pointermove is deliberately NOT swallowed, or the panel becomes a
  // steering dead zone (in landscape it sits right in the right-thumb arc).
  for (const type of ["pointerdown", "pointerup"] as const) {
    panel.addEventListener(type, (e) => e.stopPropagation());
  }
  // Tap turns tracking on, then toggles between the live feed and a compact
  // "HAND CONTROL" pill. Tracking keeps running while minimized; only the
  // preview is hidden. A drag that merely crosses the panel is not a tap.
  let downAt: { x: number; y: number } | null = null;
  panel.addEventListener("pointerdown", (e) => {
    downAt = { x: e.clientX, y: e.clientY };
  });
  panel.addEventListener("pointerup", (e) => {
    const from = downAt;
    downAt = null;
    if (from === null) return;
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > CLICK_DRAG_TOLERANCE_PX) return;
    if (state === "off") {
      enable();
      return;
    }
    panel.dataset.min = panel.dataset.min === "1" ? "0" : "1";
  });

  let stopped = false;
  let rafId: number | null = null;
  let stream: MediaStream | null = null;
  let recognizer: GestureRecognizer | null = null;
  let videoPlaying = false;
  // Created once in the loadeddata handler (after the canvas is sized) and
  // reused every frame — no per-frame getContext / DrawingUtils churn.
  let ctx: CanvasRenderingContext2D | null = null;
  let drawingUtils: DrawingUtils | null = null;
  let vision: typeof import("@mediapipe/tasks-vision") | null = null;

  const fail = (error: unknown): void => {
    console.error("Error starting hand tracking:", error);
    status.textContent = COARSE_INPUT
      ? "no signal — drag a finger to steer"
      : "no signal — the mouse controls the paddle";
    setState("error");
  };

  // ---- prediction loop ----------------------------------------------------
  let lastVideoTime = -1;
  let lastTimestamp = 0;
  let fistHeld = false;
  let lastFistAt = 0;
  // Phone-class GPUs can't hold 60fps running the recognizer on every camera
  // frame alongside the game render — on coarse-pointer devices recognize
  // every 2nd video frame (the skeleton overlay just holds for one frame;
  // the paddle's adaptive lerp smooths over the halved sample rate).
  const recognizeEvery = COARSE_INPUT ? 2 : 1;
  let videoFrame = 0;
  const predictWebcam = (): void => {
    if (stopped) return;
    if (!videoPlaying || !recognizer || !ctx || !drawingUtils || !vision) {
      rafId = requestAnimationFrame(predictWebcam);
      return;
    }

    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      videoFrame += 1;
      if (videoFrame % recognizeEvery !== 0) {
        rafId = requestAnimationFrame(predictWebcam);
        return;
      }
      // MediaPipe requires strictly increasing timestamps
      const now = performance.now();
      const timestamp = now > lastTimestamp ? now : lastTimestamp + 1;
      lastTimestamp = timestamp;
      const results = recognizer.recognizeForVideo(video, timestamp);

      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // numHands is 1, so the first hand is the only hand.
      const hand = results.landmarks[0];
      if (hand) {
        drawingUtils.drawConnectors(hand, vision.GestureRecognizer.HAND_CONNECTIONS, {
          color: "#00FF00",
          lineWidth: 5,
        });
        drawingUtils.drawLandmarks(hand, {
          color: "#FF0000",
          lineWidth: 2,
        });

        const wrist = hand[0];
        if (wrist) onWristX(wrist.x);

        // Closed-fist edge = a cam-only serve/rematch confirm ("grab the ball").
        const isFist = results.gestures[0]?.[0]?.categoryName === "Closed_Fist";
        if (isFist && !fistHeld && now - lastFistAt > FIST_COOLDOWN_MS) {
          lastFistAt = now;
          onFist?.();
        }
        fistHeld = isFist;
      } else {
        fistHeld = false;
      }
      ctx.restore();
    }

    rafId = requestAnimationFrame(predictWebcam);
  };

  const startWebcam = async (): Promise<void> => {
    const media = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
    if (stopped) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = media;
    video.srcObject = media;
    video.addEventListener("loadeddata", () => {
      if (stopped) return;
      videoPlaying = true;
      void video.play();
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx = canvas.getContext("2d");
      if (!ctx || !vision) {
        fail(new Error("canvas 2d context unavailable"));
        return;
      }
      drawingUtils = new vision.DrawingUtils(ctx);
      status.textContent = "";
      setState("live");
      predictWebcam();
    });
  };

  const create = async (): Promise<void> => {
    const mp = await import("@mediapipe/tasks-vision");
    vision = mp;
    const fileset = await mp.FilesetResolver.forVisionTasks(WASM_BASE);
    const created = await mp.GestureRecognizer.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 1, // Only detect one hand for the paddle
    });
    if (stopped) {
      created.close();
      return;
    }
    recognizer = created;
    await startWebcam();
  };

  function enable(): void {
    if (stopped || state !== "off") return;
    status.textContent = "starting camera…";
    setState("loading");
    panel.dataset.min = "0";
    create().catch(fail);
  }

  return {
    enable,
    stop(): void {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      recognizer?.close();
      panel.remove();
      setState("off");
    },
  };
}
