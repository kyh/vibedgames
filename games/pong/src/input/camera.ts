// Webcam hand tracking — restored from the legacy React <Camera> component
// (pre-rebuild src/app/camera.tsx). MediaPipe GestureRecognizer: one hand,
// VIDEO running mode, GPU delegate, wasm + model fetched from the same CDN
// URLs the legacy code used. Auto-starts on load (legacy mounted the
// component immediately — no start button), shows the camera feed with a
// green-connector / red-landmark hand skeleton overlay in a 384×288 rounded
// panel bottom-right, and reports the wrist landmark (index 0) x ∈ [0,1]
// whenever a hand is in frame. It reports nothing when no hand is visible —
// the caller decides when the hand is "lost" (see HAND_TIMEOUT_MS).
//
// Failure (no camera, permission denied, wasm/model fetch error) shows a
// status line in the panel and leaves pointer control untouched.

import { DrawingUtils, FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";

import { COARSE_INPUT } from "../shared/input-mode";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

export type HandTracker = { stop(): void };

// A held fist should confirm once, not re-fire every recognition frame.
const FIST_COOLDOWN_MS = 800;

export function startHandTracking(onWristX: (x: number) => void, onFist?: () => void): HandTracker {
  // ---- panel DOM (styles in index.html; legacy: bottom-right 384×288) ------
  const panel = document.createElement("div");
  panel.id = "camera-panel";
  panel.dataset.state = "init"; // init | live | error — drives the panel styling
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  const canvas = document.createElement("canvas");
  const status = document.createElement("div");
  status.id = "camera-status";
  status.textContent = "starting camera…";
  panel.append(video, canvas, status);
  // The legacy panel sat on top of the r3f canvas, so pointer events over it
  // never reached the game. The rebuild listens on window — stop propagation
  // to keep the panel area inert for game input, as before. The listeners
  // live on the panel element itself, so when it minimizes to the pill the
  // swallowed area shrinks with it (no invisible touch dead zone).
  for (const type of ["pointerdown", "pointermove", "pointerup"] as const) {
    panel.addEventListener(type, (e) => e.stopPropagation());
  }
  // Tap toggles between the live feed and a compact "HAND CONTROL" pill — on
  // a phone the full panel would cover a big slice of the lower court.
  // Tracking keeps running while minimized; only the preview is hidden.
  panel.addEventListener("pointerup", () => {
    panel.dataset.min = panel.dataset.min === "1" ? "0" : "1";
  });
  panel.setAttribute("role", "button");
  panel.setAttribute("aria-label", "toggle hand-control camera panel");
  document.body.appendChild(panel);

  let stopped = false;
  let rafId: number | null = null;
  let stream: MediaStream | null = null;
  let recognizer: GestureRecognizer | null = null;
  let videoPlaying = false;
  // Created once in the loadeddata handler (after the canvas is sized) and
  // reused every frame — no per-frame getContext / DrawingUtils churn.
  let ctx: CanvasRenderingContext2D | null = null;
  let drawingUtils: DrawingUtils | null = null;

  const fail = (error: unknown): void => {
    console.error("Error starting hand tracking:", error);
    status.textContent = COARSE_INPUT
      ? "no signal — drag a finger to steer"
      : "no signal — the mouse controls the paddle";
    panel.dataset.state = "error";
  };

  // ---- prediction loop (logic identical to the legacy predictWebcam) -------
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
    if (!videoPlaying || !recognizer || !ctx || !drawingUtils) {
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
        drawingUtils.drawConnectors(hand, GestureRecognizer.HAND_CONNECTIONS, {
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
      if (!ctx) {
        fail(new Error("canvas 2d context unavailable"));
        return;
      }
      drawingUtils = new DrawingUtils(ctx);
      status.textContent = "";
      panel.dataset.state = "live";
      predictWebcam();
    });
  };

  const create = async (): Promise<void> => {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    const created = await GestureRecognizer.createFromOptions(vision, {
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

  create().catch(fail);

  return {
    stop(): void {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      recognizer?.close();
      panel.remove();
    },
  };
}
