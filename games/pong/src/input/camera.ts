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

export interface HandCamera {
  /** Start tracking. Idempotent — ignored once loading or live. */
  enable: () => void;
}

let state: HandCameraState = "off";

export const handCameraState = () => state;

const FIST_COOLDOWN_MS = 800;

const PANEL_ARIA = {
  error: "Retry hand control camera",
  loading: "Starting hand control camera",
  off: "Enable hand control",
} satisfies Partial<Record<HandCameraState, string>>;

const PANEL_LABEL = {
  error: "RETRY CAMERA",
  loading: "STARTING CAMERA",
  off: "ENABLE HAND CONTROL",
} satisfies Partial<Record<HandCameraState, string>>;

const panelAria = (minimized: boolean, tracked: boolean) => {
  if (state !== "live") {
    return PANEL_ARIA[state];
  }

  return `${minimized ? "Show" : "Minimize"} camera preview · ${tracked ? "hand tracked" : "show one hand"}`;
};

const panelLabel = (minimized: boolean, tracked: boolean) => {
  if (state !== "live") {
    return PANEL_LABEL[state];
  }

  if (!minimized) {
    return "CAMERA ON";
  }

  return tracked ? "HAND TRACKED" : "SHOW ONE HAND";
};

const statusText = (tracking: Tracking) => {
  if (state === "error") {
    return "Camera unavailable. Tap to retry.";
  }

  if (state === "loading") {
    return "Starting camera…";
  }

  if (state === "live" && tracking === "tracked") {
    return "Hand tracked";
  }

  if (state === "live" && tracking === "lost") {
    return "Hand lost · show one hand";
  }

  return "Show one hand to steer";
};

const trackingAt: (now: number, lastHandAt: number | null) => Tracking = (now, lastHandAt) => {
  if (lastHandAt === null) {
    return "waiting";
  }

  return now - lastHandAt <= HAND_TIMEOUT_MS ? "tracked" : "lost";
};

export const createHandCamera = (onWristX: (x: number) => void, onFist?: () => void) => {
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
  document.body.append(panel);

  let tracking: Tracking = "waiting";

  const syncPanel = () => {
    panel.dataset.state = state;
    const minimized = panel.dataset.min === "1";
    const tracked = tracking === "tracked";
    panel.setAttribute("aria-label", panelAria(minimized, tracked));
    panel.setAttribute("aria-busy", String(state === "loading"));
    panel.dataset.label = panelLabel(minimized, tracked);
    status.textContent = statusText(tracking);
  };

  const setState = (next: HandCameraState) => {
    state = next;
    syncPanel();
  };

  setState("off");

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
  let attempt = 0;
  let rafId: number | null = null;
  let stream: MediaStream | null = null;
  let recognizer: GestureRecognizer | null = null;
  let drawingUtils: DrawingUtils | null = null;
  let listeners = new AbortController();

  const release = () => {
    attempt += 1;

    if (rafId !== null) {
      cancelAnimationFrame(rafId);
    }

    rafId = null;
    listeners.abort();
    listeners = new AbortController();

    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }

    stream = null;
    video.pause();
    video.srcObject = null;
    recognizer?.close();
    recognizer = null;
    drawingUtils?.close();
    drawingUtils = null;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  };

  const fail = (cause: unknown) => {
    console.error("Error starting hand tracking:", cause);
    release();
    setState("error");
  };

  const onStreamEnded = () => {
    fail(new Error("Camera stream ended"));
  };

  const onVideoError = () => {
    if (video.error) {
      fail(video.error);
    }
  };

  const start = async (id: number) => {
    const vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);

    if (id !== attempt) {
      return;
    }

    const created = await vision.GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { delegate: "GPU", modelAssetPath: MODEL_URL },
      numHands: 1,
      runningMode: "VIDEO",
    });

    if (id !== attempt) {
      created.close();

      return;
    }

    recognizer = created;

    const media = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user" },
    });

    if (id !== attempt) {
      for (const track of media.getTracks()) {
        track.stop();
      }

      return;
    }

    stream = media;

    for (const track of media.getTracks()) {
      track.addEventListener("ended", onStreamEnded, { signal: listeners.signal });
    }

    video.addEventListener("error", onVideoError, { signal: listeners.signal });
    video.srcObject = media;
    await video.play();

    if (id !== attempt) {
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      throw new Error("canvas 2d context unavailable");
    }

    const drawing = new vision.DrawingUtils(ctx);
    drawingUtils = drawing;
    setState("live");

    let lastVideoTime = -1;
    let lastTimestamp = 0;
    let lastHandAt: number | null = null;
    let fistHeld = false;
    let lastFistAt = 0;
    const recognizeEvery = COARSE_INPUT ? 2 : 1;
    let videoFrame = 0;

    const predictWebcam = () => {
      if (id !== attempt) {
        return;
      }

      try {
        const now = performance.now();

        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          videoFrame += 1;

          if (videoFrame % recognizeEvery === 0) {
            const timestamp = now > lastTimestamp ? now : lastTimestamp + 1;
            lastTimestamp = timestamp;
            const results = created.recognizeForVideo(video, timestamp);
            ctx.save();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const [hand] = results.landmarks;

            if (hand) {
              drawing.drawConnectors(hand, vision.GestureRecognizer.HAND_CONNECTIONS, {
                color: "#00FF00",
                lineWidth: 5,
              });
              drawing.drawLandmarks(hand, { color: "#FF0000", lineWidth: 2 });
              const [wrist] = hand;

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
            } else {
              fistHeld = false;
            }

            ctx.restore();
          }
        }

        const next = trackingAt(now, lastHandAt);

        if (next !== tracking) {
          tracking = next;
          syncPanel();
        }

        rafId = requestAnimationFrame(predictWebcam);
      } catch (error) {
        fail(error);
      }
    };

    predictWebcam();
  };

  const run = async (id: number) => {
    try {
      await start(id);
    } catch (error) {
      if (id === attempt) {
        fail(error);
      }
    }
  };

  const enable = () => {
    if (state === "loading" || state === "live") {
      return;
    }

    release();
    tracking = "waiting";
    panel.dataset.min = "0";
    const id = attempt;
    setState("loading");
    void run(id);
  };

  panel.addEventListener("click", (e) => {
    if (e.detail !== 0 && !tapped) {
      return;
    }

    tapped = false;

    if (state === "off" || state === "error") {
      enable();
    } else if (state === "live") {
      panel.dataset.min = panel.dataset.min === "1" ? "0" : "1";
      syncPanel();
    }
  });

  return { enable };
};
