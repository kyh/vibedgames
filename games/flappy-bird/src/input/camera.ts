/**
 * Webcam pose-jump input — faithful port of the legacy React <Camera> component
 * (git HEAD: games/flappy-bird/src/app/camera.tsx) into a plain-TS module.
 *
 * A physical jump in front of the webcam flaps the bird. MediaPipe
 * PoseLandmarker (lite) tracks the nose (landmark 0, visibility > 0.3) through
 * a 5-frame moving average; calibration averages 30 samples at 66ms (~2s of
 * standing still) into a baseline. A rise of more than 10% of baseline fires a
 * jump whose strength scales 0..1 across 2× that threshold. While airborne,
 * every new minimum Y re-fires with the updated strength; landing is detected
 * once the nose settles back within half the threshold of baseline.
 *
 * The module owns its DOM: a 384×288 rounded panel (bottom-right) with live
 * video, a skeleton overlay (red landmark dots r=3, blue connectors lw=2), a
 * Start/Calibrate/Reset action button, and a status line. Camera + model
 * startup begins automatically on init — the legacy app mounted the component
 * on page load, which kicked off getUserMedia immediately. If permission is
 * denied or loading fails, the panel shows the error and the game stays fully
 * playable with keyboard/tap.
 */

import {
  DrawingUtils,
  FilesetResolver,
  PoseLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

// ---- legacy tuning (recovered from git — do not retune) ------------------------

/** Jump fires when the smoothed nose rises above baseline by this fraction of baseline. */
const JUMP_THRESHOLD = 0.1;
/** Moving-average window over nose pixel-Y, in frames. */
const SMOOTHING_WINDOW = 5;
/** Strength reaches 1.0 at a rise of threshold × this factor. */
const MAX_JUMP_HEIGHT_FACTOR = 2;
/** MediaPipe pose landmark index for the nose. */
const NOSE_INDEX = 0;
/** Nose samples at or below this visibility are discarded. */
const MIN_VISIBILITY = 0.3;
/** Baseline = average of 30 samples taken every 66ms (~2s standing still). */
const CALIBRATION_SAMPLES = 30;
const CALIBRATION_INTERVAL_MS = 66;

/** Exact CDN URLs the legacy build loaded wasm + model from. */
const WASM_BASE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// ---- types ---------------------------------------------------------------------

type PoseState = "idle" | "loading" | "ready" | "calibrating" | "detecting" | "jumping";

/**
 * strength ∈ [0,1]. refire=false on the initial threshold-cross; true for the
 * airborne min-Y updates of the same physical jump (velocity-only refreshes —
 * the legacy game set bird velocity on every callback).
 */
export type PoseJumpHandler = (strength: number, refire: boolean) => void;

type Panel = {
  video: HTMLVideoElement;
  overlay: HTMLCanvasElement;
  button: HTMLButtonElement;
  status: HTMLSpanElement;
};

// ---- state machine ---------------------------------------------------------------

class PoseCamera {
  private state: PoseState = "idle";
  private baselineY = 0;
  private minY = Infinity;
  private yPositions: number[] = [];
  private hasBeenCalibrated = false;
  private landmarker: PoseLandmarker | null = null;
  private stream: MediaStream | null = null;
  private calibrationTimer: number | null = null;
  private detectionStarted = false;

  constructor(
    private readonly ui: Panel,
    private onJump: PoseJumpHandler,
  ) {
    this.setStatus("Click 'Start' to begin");
    this.ui.button.addEventListener("click", () => {
      // Drop focus so Space (a game input) can't re-activate the button.
      this.ui.button.blur();
      this.handleMainAction();
    });
    // Legacy mounted the component on page load and auto-started immediately.
    this.start();
  }

  setHandler(onJump: PoseJumpHandler): void {
    this.onJump = onJump;
  }

  // ---- UI plumbing ---------------------------------------------------------------

  private setState(state: PoseState): void {
    this.state = state;
    this.ui.button.textContent = buttonLabel(state);
    this.ui.button.disabled = state === "loading" || state === "calibrating";
  }

  private setStatus(text: string): void {
    this.ui.status.textContent = text;
  }

  /** Legacy button: Start (idle) / Calibrate (ready) / Reset (detecting|jumping). */
  private handleMainAction(): void {
    switch (this.state) {
      case "idle":
        // Reachable after a permission denial / load failure — retry startup.
        this.start();
        break;
      case "ready":
        this.startCalibration();
        break;
      case "detecting":
      case "jumping":
        this.resetCalibration();
        break;
      case "loading":
      case "calibrating":
        break;
    }
  }

  // ---- startup --------------------------------------------------------------------

  private start(): void {
    if (this.state !== "idle") return;
    this.setState("loading");
    this.setStatus("Starting camera and loading model...");
    void this.startCamera();
  }

  private async startCamera(): Promise<void> {
    try {
      // A retry after a partial failure replaces any previous stream.
      if (this.stream) {
        for (const track of this.stream.getTracks()) track.stop();
        this.stream = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      this.stream = stream;

      const video = this.ui.video;
      video.srcObject = stream;
      void video.play();
      video.addEventListener(
        "loadedmetadata",
        () => {
          this.ui.overlay.width = video.videoWidth;
          this.ui.overlay.height = video.videoHeight;
          void this.loadModel();
        },
        { once: true },
      );
    } catch (error) {
      // Graceful degradation: show why, fall back to keyboard/tap input.
      this.setStatus(`Error: ${errorMessage(error)}`);
      this.setState("idle");
    }
  }

  private async loadModel(): Promise<void> {
    try {
      this.setStatus("Loading pose detection model...");

      const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
      this.landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });

      this.setState("ready");
      this.setStatus("Ready for calibration. Stand still and click 'Calibrate'");
      this.startDetection();
    } catch (error) {
      this.setStatus(`Error loading model: ${errorMessage(error)}`);
      this.setState("idle");
    }
  }

  // ---- detection loop ----------------------------------------------------------------

  private startDetection(): void {
    if (this.detectionStarted) return;
    this.detectionStarted = true;

    let lastVideoTime = -1;
    let lastTimestamp = 0;

    const detectFrame = (): void => {
      const video = this.ui.video;
      const landmarker = this.landmarker;

      if (video.readyState !== 4 || landmarker === null) {
        requestAnimationFrame(detectFrame);
        return;
      }

      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        // MediaPipe requires strictly increasing timestamps.
        const now = performance.now();
        const timestamp = now > lastTimestamp ? now : lastTimestamp + 1;
        lastTimestamp = timestamp;

        try {
          const result = landmarker.detectForVideo(video, timestamp);
          const landmarks = result.landmarks[0];
          if (landmarks) {
            drawSkeleton(landmarks, this.ui.overlay);

            // Nose coordinates are normalized (0-1) — convert to pixel Y so the
            // calibrated baseline matches the legacy numbers.
            const nose = landmarks[NOSE_INDEX];
            if (nose && nose.visibility > MIN_VISIBILITY) {
              const noseY = nose.y * (video.videoHeight || 1);
              this.yPositions.unshift(noseY);
              if (this.yPositions.length > SMOOTHING_WINDOW) this.yPositions.pop();

              if (this.state === "detecting" || this.state === "jumping") {
                this.detectJump();
              }
            }
          }
        } catch (error) {
          this.setStatus(`Error: ${errorMessage(error)}`);
        }
      }

      requestAnimationFrame(detectFrame);
    };

    detectFrame();
  }

  // ---- calibration ---------------------------------------------------------------------

  private startCalibration(): void {
    this.setState("calibrating");
    this.setStatus("Calibrating... Stand still");

    this.baselineY = 0;
    let calibrationFrames = 0;
    let totalY = 0;

    this.calibrationTimer = window.setInterval(() => {
      if (this.yPositions.length > 0) {
        totalY += getSmoothedY(this.yPositions);
        calibrationFrames++;
        this.setStatus(
          `Calibrating... ${Math.min(100, Math.round((calibrationFrames / CALIBRATION_SAMPLES) * 100))}%`,
        );
      }

      if (calibrationFrames >= CALIBRATION_SAMPLES) {
        if (this.calibrationTimer !== null) window.clearInterval(this.calibrationTimer);
        this.calibrationTimer = null;
        this.baselineY = totalY / calibrationFrames;
        this.hasBeenCalibrated = true;
        this.setState("detecting");
        this.setStatus("Calibrated! Jump now (or click 'Reset' to recalibrate)");
      }
    }, CALIBRATION_INTERVAL_MS);
  }

  private resetCalibration(): void {
    this.setState("ready");
    this.setStatus("Ready for calibration. Stand still and click 'Calibrate'");
    this.baselineY = 0;
    this.hasBeenCalibrated = false;
  }

  // ---- jump detection (exact legacy port) -------------------------------------------------

  private detectJump(): void {
    if (!this.hasBeenCalibrated) return;

    const currentY = getSmoothedY(this.yPositions);
    const heightDiff = this.baselineY - currentY;
    const jumpThreshold = this.baselineY * JUMP_THRESHOLD;

    if (heightDiff > jumpThreshold && this.state === "detecting") {
      this.setState("jumping");
      this.setStatus("Jumping!");
      this.minY = currentY;

      const jumpStrength = Math.min(
        heightDiff / (this.baselineY * JUMP_THRESHOLD * MAX_JUMP_HEIGHT_FACTOR),
        1,
      );
      this.onJump(jumpStrength, false);
    } else if (this.state === "jumping" && currentY < this.minY) {
      this.minY = currentY;

      const updatedHeightDiff = this.baselineY - currentY;
      const updatedJumpStrength = Math.min(
        updatedHeightDiff / (this.baselineY * JUMP_THRESHOLD * MAX_JUMP_HEIGHT_FACTOR),
        1,
      );
      this.onJump(updatedJumpStrength, true);
    } else if (
      this.state === "jumping" &&
      Math.abs(currentY - this.baselineY) < jumpThreshold / 2
    ) {
      this.setState("detecting");
      this.setStatus("Landed!");
    }
  }
}

// ---- module API ------------------------------------------------------------------------

let active: PoseCamera | null = null;

/**
 * Create the bottom-right webcam panel and begin camera + model startup
 * (idempotent — repeat calls just swap the jump handler). Failures degrade to
 * a visible status message while keyboard/tap input keeps working.
 */
export function initPoseCamera(onJump: PoseJumpHandler): void {
  if (active !== null) {
    active.setHandler(onJump);
    return;
  }
  active = new PoseCamera(buildPanel(document.body), onJump);
}

// ---- DOM (legacy panel, Tailwind classes translated to inline styles) --------------------

function buildPanel(parent: HTMLElement): Panel {
  // Legacy: absolute right-1 bottom-1 h-[288px] w-sm rounded-lg bg-black/10
  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.right = "4px";
  root.style.bottom = "4px";
  root.style.width = "384px";
  root.style.height = "288px";
  root.style.borderRadius = "8px";
  root.style.background = "rgba(0, 0, 0, 0.1)";
  root.style.zIndex = "20";

  // Legacy: <video class="rounded-lg" playsInline /> (preflight: block, max-w-full, h-auto)
  const video = document.createElement("video");
  video.playsInline = true;
  video.style.display = "block";
  video.style.maxWidth = "100%";
  video.style.width = "100%";
  video.style.height = "auto";
  video.style.borderRadius = "8px";

  // Legacy: <canvas class="absolute top-0 left-0 h-full w-full" />
  const overlay = document.createElement("canvas");
  overlay.style.position = "absolute";
  overlay.style.top = "0";
  overlay.style.left = "0";
  overlay.style.width = "100%";
  overlay.style.height = "100%";

  // Legacy: absolute bottom-2 left-2 flex items-center gap-2 text-xs
  const controls = document.createElement("div");
  controls.style.position = "absolute";
  controls.style.bottom = "8px";
  controls.style.left = "8px";
  controls.style.display = "flex";
  controls.style.alignItems = "center";
  controls.style.gap = "8px";
  controls.style.font = "12px/1.33 system-ui, sans-serif";

  // Legacy: rounded-md bg-white px-2 py-1 text-xs
  const button = document.createElement("button");
  button.type = "button";
  button.style.borderRadius = "6px";
  button.style.background = "#fff";
  button.style.color = "#000";
  button.style.border = "none";
  button.style.padding = "4px 8px";
  button.style.font = "inherit";
  button.style.cursor = "pointer";
  button.textContent = "Start";

  const status = document.createElement("span");

  controls.append(button, status);
  root.append(video, overlay, controls);
  parent.appendChild(root);

  return { video, overlay, button, status };
}

// ---- pure helpers --------------------------------------------------------------------------

/** Skeleton overlay: red landmark dots (r=3) + blue connectors (lineWidth=2). */
function drawSkeleton(landmarks: NormalizedLandmark[], canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const drawingUtils = new DrawingUtils(ctx);
  drawingUtils.drawLandmarks(landmarks, {
    radius: 3,
    color: "red",
    fillColor: "red",
  });
  drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
    color: "blue",
    lineWidth: 2,
  });
}

function getSmoothedY(positions: number[]): number {
  if (positions.length === 0) return 0;
  return positions.reduce((sum, val) => sum + val, 0) / positions.length;
}

function buttonLabel(state: PoseState): string {
  switch (state) {
    case "idle":
      return "Start";
    case "loading":
      return "Loading...";
    case "ready":
      return "Calibrate";
    case "calibrating":
      return "Calibrating...";
    case "detecting":
    case "jumping":
      return "Reset";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
