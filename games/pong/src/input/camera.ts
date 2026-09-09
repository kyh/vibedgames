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
// Failure (no camera, permission denied, wasm/model fetch error, a stream that
// ends mid-game) shows a status line in the panel, leaves pointer control
// untouched, and lets the player tap the panel to retry.

import type { DrawingUtils, GestureRecognizer } from "@mediapipe/tasks-vision";

import { CLICK_DRAG_TOLERANCE_PX, HAND_TIMEOUT_MS } from "../shared/constants";
import { COARSE_INPUT } from "../shared/input-mode";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

/** `off` — never asked for; `loading` — fetching the model / opening the
 *  camera; `live` — a feed is running; `error` — unavailable on this device. */
export type HandCameraState = "off" | "loading" | "live" | "error";
type Tracking = "waiting" | "tracked" | "lost";

export type HandCamera = {
  /** Start tracking. Idempotent — ignored once loading or live. */
  enable(): void;
};

// One panel per page, so the state a control surface asks about is module
// state: instruction copy is rendered from anywhere (pause card) and must not
// have to be handed a tracker reference to know if hands work.
let state: HandCameraState = "off";

export function handCameraState(): HandCameraState {
  return state;
}

// A held fist should confirm once, not re-fire every recognition frame.
const FIST_COOLDOWN_MS = 800;

export function createHandCamera(onWristX: (x: number) => void, onFist?: () => void): HandCamera {
  const panel = document.createElement("button");
  panel.type = "button";
  panel.id = "camera-panel";
  // A phone opts in, so the panel starts as the compact pill: an unasked-for
  // 4:3 preview over the court would be pure occlusion before it can show anything.
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

  let tracking: Tracking = "waiting";

  function syncPanel(): void {
    panel.dataset.state = state;
    const minimized = panel.dataset.min === "1";
    const tracked = tracking === "tracked";
    panel.setAttribute(
      "aria-label",
      state === "off"
        ? "Enable hand control"
        : state === "error"
          ? "Retry hand control camera"
          : state === "loading"
            ? "Starting hand control camera"
            : `${minimized ? "Show" : "Minimize"} camera preview · ${tracked ? "hand tracked" : "show one hand"}`,
    );
    panel.setAttribute("aria-busy", String(state === "loading"));
    panel.dataset.label =
      state === "off"
        ? "ENABLE HAND CONTROL"
        : state === "error"
          ? "RETRY CAMERA"
          : state === "loading"
            ? "STARTING CAMERA"
            : !minimized
              ? "CAMERA ON"
              : tracked
                ? "HAND TRACKED"
                : "SHOW ONE HAND";
    status.textContent =
      state === "error"
        ? "Camera unavailable. Tap to retry."
        : state === "loading"
          ? "Starting camera…"
          : state === "live" && tracked
            ? "Hand tracked"
            : state === "live" && tracking === "lost"
              ? "Hand lost · show one hand"
              : "Show one hand to steer";
  }

  function setState(next: HandCameraState): void {
    state = next;
    syncPanel();
  }
  setState("off");

  // The panel sits over the court, whose only touch control is a drag on the
  // play area. Swallowing pointerdown/up keeps a tap on the panel from also
  // serving; pointermove is deliberately NOT swallowed, or the panel becomes a
  // steering dead zone (in landscape it sits right in the right-thumb arc).
  // A drag that merely crosses the panel is not a tap; keyboard activation
  // (click with detail 0) always counts.
  let downAt: { x: number; y: number } | null = null;
  let tapped = false;
  panel.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    downAt = { x: e.clientX, y: e.clientY };
    tapped = false;
  });
  panel.addEventListener("pointerup", (e) => {
    e.stopPropagation();
    tapped =
      downAt !== null &&
      Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) <= CLICK_DRAG_TOLERANCE_PX;
    downAt = null;
  });
  panel.addEventListener("pointercancel", () => {
    downAt = null;
    tapped = false;
  });
  // Tap turns tracking on (or retries), then toggles between the live feed and
  // the compact pill. Tracking keeps running while minimized; only the preview hides.
  panel.addEventListener("click", (e) => {
    if (e.detail !== 0 && !tapped) return;
    tapped = false;
    if (state === "off" || state === "error") enable();
    else if (state === "live") {
      panel.dataset.min = panel.dataset.min === "1" ? "0" : "1";
      syncPanel();
    }
  });

  // Resources of the running attempt. `release()` bumps `attempt`, so a start()
  // still awaiting the model or the camera cannot revive a failed/retried panel.
  let attempt = 0;
  let rafId: number | null = null;
  let stream: MediaStream | null = null;
  let recognizer: GestureRecognizer | null = null;
  let drawingUtils: DrawingUtils | null = null;

  function release(): void {
    attempt += 1;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    for (const track of stream?.getTracks() ?? []) {
      track.removeEventListener("ended", onStreamEnded);
      track.stop();
    }
    stream = null;
    video.removeEventListener("error", onVideoError);
    video.pause();
    video.srcObject = null;
    recognizer?.close();
    recognizer = null;
    drawingUtils?.close();
    drawingUtils = null;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }

  function fail(cause: unknown): void {
    console.error("Error starting hand tracking:", cause);
    release();
    setState("error");
  }
  function onStreamEnded(): void {
    fail(new Error("Camera stream ended"));
  }
  function onVideoError(): void {
    if (video.error) fail(video.error);
  }

  async function start(id: number): Promise<void> {
    const vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
    if (id !== attempt) return;
    const created = await vision.GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 1,
    });
    if (id !== attempt) {
      created.close();
      return;
    }
    recognizer = created;
    const media = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
    if (id !== attempt) {
      for (const track of media.getTracks()) track.stop();
      return;
    }
    stream = media;
    for (const track of media.getTracks()) track.addEventListener("ended", onStreamEnded);
    video.addEventListener("error", onVideoError);
    video.srcObject = media;
    await video.play();
    if (id !== attempt) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    const drawing = new vision.DrawingUtils(ctx);
    drawingUtils = drawing;
    setState("live");

    // ---- prediction loop --------------------------------------------------
    let lastVideoTime = -1;
    let lastTimestamp = 0;
    let lastHandAt: number | null = null;
    let fistHeld = false;
    let lastFistAt = 0;
    // Phone-class GPUs can't hold 60fps running the recognizer on every camera
    // frame alongside the game render — on coarse-pointer devices recognize
    // every 2nd video frame (the skeleton overlay just holds for one frame;
    // the paddle's adaptive lerp smooths over the halved sample rate).
    const recognizeEvery = COARSE_INPUT ? 2 : 1;
    let videoFrame = 0;
    const predictWebcam = (): void => {
      if (id !== attempt) return;
      try {
        const now = performance.now();
        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          videoFrame += 1;
          if (videoFrame % recognizeEvery === 0) {
            // MediaPipe requires strictly increasing timestamps
            const timestamp = now > lastTimestamp ? now : lastTimestamp + 1;
            lastTimestamp = timestamp;
            const results = created.recognizeForVideo(video, timestamp);
            ctx.save();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            // numHands is 1, so the first hand is the only hand.
            const hand = results.landmarks[0];
            if (hand) {
              drawing.drawConnectors(hand, vision.GestureRecognizer.HAND_CONNECTIONS, {
                color: "#00FF00",
                lineWidth: 5,
              });
              drawing.drawLandmarks(hand, { color: "#FF0000", lineWidth: 2 });
              const wrist = hand[0];
              if (wrist) {
                lastHandAt = now;
                onWristX(wrist.x);
              }
              // Closed-fist edge = a cam-only confirm ("grab the ball").
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
        const next: Tracking =
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
        fail(cause);
      }
    };
    predictWebcam();
  }

  function enable(): void {
    if (state === "loading" || state === "live") return;
    release();
    tracking = "waiting";
    panel.dataset.min = "0";
    const id = attempt;
    setState("loading");
    start(id).catch((cause: unknown) => {
      if (id === attempt) fail(cause);
    });
  }

  return { enable };
}
