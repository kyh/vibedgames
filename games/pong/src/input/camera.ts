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

import { CLICK_DRAG_TOLERANCE_PX, HAND_TIMEOUT_MS } from "../shared/constants";
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

type CameraAttempt = { start(): Promise<void>; stop(): void };

export function createHandCamera(onWristX: (x: number) => void, onFist?: () => void): HandCamera {
  const panel = document.createElement("button");
  panel.type = "button";
  panel.id = "camera-panel";
  panel.dataset.min = COARSE_INPUT ? "1" : "0";
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  const canvas = document.createElement("canvas");
  const status = document.createElement("span");
  status.id = "camera-status";
  panel.append(video, canvas, status);
  document.body.appendChild(panel);

  let stopped = false;
  let current: CameraAttempt | null = null;
  let tracking: "waiting" | "tracked" | "lost" = "waiting";

  function syncPanel(): void {
    panel.dataset.state = state;
    panel.dataset.tracking = tracking;
    const minimized = panel.dataset.min === "1";
    const label =
      state === "off"
        ? "Enable hand control"
        : state === "error"
          ? "Retry hand control camera"
          : state === "loading"
            ? "Starting hand control camera"
            : `${minimized ? "Show" : "Minimize"} camera preview · ${tracking === "tracked" ? "hand tracked" : "show one hand"}`;
    panel.setAttribute("aria-label", label);
    panel.setAttribute("aria-busy", String(state === "loading"));
    panel.dataset.label =
      state === "off"
        ? "ENABLE HAND CONTROL"
        : state === "error"
          ? "RETRY CAMERA"
          : state === "loading"
            ? "STARTING CAMERA"
            : minimized
              ? tracking === "tracked"
                ? "HAND TRACKED"
                : "SHOW ONE HAND"
              : "CAMERA ON";
    status.textContent =
      state === "off"
        ? "Show one hand to steer"
        : state === "error"
          ? "Camera unavailable. Tap to retry."
          : state === "loading"
            ? "Starting camera…"
            : tracking === "tracked"
              ? "Hand tracked"
              : tracking === "lost"
                ? "Hand lost · show one hand"
                : "Show one hand to steer";
  }

  function setState(next: HandCameraState): void {
    const changed = next !== state;
    state = next;
    syncPanel();
    if (changed) for (const watcher of watchers) watcher(next);
  }
  setState("off");

  // Native keyboard activation and screen-reader clicks use the same action.
  // Both pointer edges stay out of the court; hover still steers across it.
  let downAt: { x: number; y: number } | null = null;
  let tapped = false;
  panel.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    downAt = { x: event.clientX, y: event.clientY };
    tapped = false;
  });
  panel.addEventListener("pointerup", (event) => {
    event.stopPropagation();
    tapped =
      downAt !== null &&
      Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) <= CLICK_DRAG_TOLERANCE_PX;
    downAt = null;
  });
  panel.addEventListener("pointercancel", () => {
    downAt = null;
    tapped = false;
  });
  for (const type of ["keydown", "keyup"]) {
    panel.addEventListener(type, (event) => {
      if (event instanceof KeyboardEvent && (event.key === "Enter" || event.key === " ")) {
        event.stopPropagation();
      }
    });
  }
  panel.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.detail !== 0 && !tapped) return;
    tapped = false;
    if (state === "off" || state === "error") enable();
    else if (state === "live") {
      panel.dataset.min = panel.dataset.min === "1" ? "0" : "1";
      syncPanel();
    }
  });

  function fail(attempt: CameraAttempt, cause: unknown): void {
    if (stopped || current !== attempt) return;
    attempt.stop();
    current = null;
    console.error("Error starting hand tracking:", cause);
    setState("error");
  }

  // Every startup owns its stream, model and RAF. A late result can only
  // release its own resources; it cannot revive a failed or disposed panel.
  function createAttempt(): CameraAttempt {
    let released = false;
    let rafId: number | null = null;
    let stream: MediaStream | null = null;
    let recognizer: GestureRecognizer | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let drawingUtils: DrawingUtils | null = null;
    let vision: typeof import("@mediapipe/tasks-vision") | null = null;
    let lastVideoTime = -1;
    let lastTimestamp = 0;
    let lastHandAt: number | null = null;
    let fistHeld = false;
    let lastFistAt = 0;
    const recognizeEvery = COARSE_INPUT ? 2 : 1;
    let videoFrame = 0;

    function predictWebcam(): void {
      if (released) return;
      if (!recognizer || !ctx || !drawingUtils || !vision) return;
      try {
        const now = performance.now();
        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          videoFrame += 1;
          if (videoFrame % recognizeEvery === 0) {
            // Keep the original cadence, gesture threshold and fist edge.
            const timestamp = now > lastTimestamp ? now : lastTimestamp + 1;
            lastTimestamp = timestamp;
            const results = recognizer.recognizeForVideo(video, timestamp);
            ctx.save();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const hand = results.landmarks[0];
            if (hand) {
              drawingUtils.drawConnectors(hand, vision.GestureRecognizer.HAND_CONNECTIONS, {
                color: "#00FF00",
                lineWidth: 5,
              });
              drawingUtils.drawLandmarks(hand, { color: "#FF0000", lineWidth: 2 });
              const wrist = hand[0];
              if (wrist) {
                lastHandAt = now;
                onWristX(wrist.x);
              }
              const isFist = results.gestures[0]?.[0]?.categoryName === "Closed_Fist";
              if (isFist && !fistHeld && now - lastFistAt > FIST_COOLDOWN_MS) {
                lastFistAt = now;
                onFist?.();
              }
              fistHeld = isFist;
            } else fistHeld = false;
            ctx.restore();
          }
        }
        const next =
          lastHandAt === null
            ? "waiting"
            : now - lastHandAt <= HAND_TIMEOUT_MS
              ? "tracked"
              : "lost";
        if (next !== tracking) {
          tracking = next;
          syncPanel();
        }
        rafId = requestAnimationFrame(predictWebcam);
      } catch (cause) {
        fail(attempt, cause);
      }
    }

    const attempt: CameraAttempt = {
      async start(): Promise<void> {
        const mp = await import("@mediapipe/tasks-vision");
        if (released) return;
        vision = mp;
        const fileset = await mp.FilesetResolver.forVisionTasks(WASM_BASE);
        if (released) return;
        const created = await mp.GestureRecognizer.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 1,
        });
        if (released) {
          created.close();
          return;
        }
        recognizer = created;
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
        if (released) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        video.srcObject = media;
        await video.play();
        if (released) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas 2d context unavailable");
        drawingUtils = new mp.DrawingUtils(ctx);
        setState("live");
        predictWebcam();
      },
      stop(): void {
        if (released) return;
        released = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        recognizer?.close();
        recognizer = null;
        drawingUtils?.close();
        drawingUtils = null;
        video.pause();
        video.srcObject = null;
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
        ctx = null;
        vision = null;
      },
    };
    return attempt;
  }

  function enable(): void {
    if (stopped || state === "loading" || state === "live") return;
    current?.stop();
    tracking = "waiting";
    panel.dataset.min = "0";
    const attempt = createAttempt();
    current = attempt;
    setState("loading");
    void attempt.start().catch((cause: unknown) => fail(attempt, cause));
  }

  return {
    enable,
    stop(): void {
      if (stopped) return;
      stopped = true;
      current?.stop();
      current = null;
      panel.remove();
      setState("off");
    },
  };
}
