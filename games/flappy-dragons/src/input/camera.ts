/**
 * Webcam pose-jump input — faithful port of the legacy React <Camera> component
 * (src/app/camera.tsx in the original build; see git history) into a plain-TS module.
 *
 * A physical jump in front of the webcam flaps the bird. MediaPipe
 * PoseLandmarker (lite) tracks the nose (landmark 0, visibility > 0.3) through
 * a 5-frame moving average. There is no manual calibration — the resting
 * nose-Y baseline is captured with zero clicks:
 *   - Between runs (menu / game-over) it rolls: a slow EMA that continuously
 *     follows wherever you settle.
 *   - The instant a run starts it LOCKS to that resting value (via
 *     setPoseLocked(true), driven by the game's ready→playing transition) and
 *     holds fixed for the whole run, so the jump threshold stays stable and
 *     predictable. Dying unlocks it and rolling resumes.
 * It is also frozen while a jump is in progress so a jump can't drag its own
 * reference upward. A rise of more than 10% of baseline fires a jump whose
 * strength scales 0..1 across 2× that threshold. While airborne, every new
 * minimum Y re-fires with the updated strength; landing is detected once the
 * nose settles back within half the threshold of baseline.
 *
 * The module owns its DOM: a 384×288 rounded panel (bottom-right) with live
 * video, a skeleton overlay (red landmark dots r=3, blue connectors lw=2), and
 * a status line. Normal play is button-free — a Start button surfaces only if
 * camera/model startup fails, to retry. Camera + model startup begins
 * automatically on init — the legacy app mounted the component on page load,
 * which kicked off getUserMedia immediately. If permission is denied or
 * loading fails, the panel shows the error and the game stays fully playable
 * with keyboard/tap.
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

// ---- adaptive baseline (replaces manual calibration) ---------------------------

/** Nose samples averaged to seed the rolling baseline before jumps arm (~0.5s at 30fps). */
const WARMUP_SAMPLES = 15;
/**
 * Per-frame EMA rate the resting baseline adapts at while not jumping
 * (τ≈1.6s at 30fps): fast enough to follow repositioning within a few seconds,
 * slow enough that a brief undetected bob barely moves it. Frozen mid-jump.
 */
const BASELINE_ADAPT_RATE = 0.02;

/** Exact CDN URLs the legacy build loaded wasm + model from. */
const WASM_BASE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// ---- types ---------------------------------------------------------------------

type PoseState = "idle" | "loading" | "warming" | "detecting" | "jumping";

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
  private warmupSamples = 0;
  private warmupTotal = 0;
  /** While true the baseline is frozen — set for the duration of a game run. */
  private locked = false;
  private landmarker: PoseLandmarker | null = null;
  private stream: MediaStream | null = null;
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
    // The button exists only to retry after a startup failure; normal play is
    // clickless (the baseline locks itself at game-start).
    this.ui.button.style.display = state === "idle" ? "" : "none";
  }

  /** Freeze the baseline for a run (true) / resume rolling between runs (false). */
  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  private setStatus(text: string): void {
    this.ui.status.textContent = text;
  }

  /** The button is only shown in "idle" — a retry after a startup failure. */
  private handleMainAction(): void {
    if (this.state === "idle") this.start();
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

      this.beginWarmup();
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

              this.processSample();
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

  // ---- adaptive baseline ---------------------------------------------------------------

  /** Enter warm-up: collect samples to seed the baseline, then arm jumps automatically. */
  private beginWarmup(): void {
    this.setState("warming");
    this.setStatus("Centering... stand naturally");
    this.warmupSamples = 0;
    this.warmupTotal = 0;
    this.baselineY = 0;
  }

  /**
   * Per valid nose sample: seed the baseline during warm-up, then keep a rolling
   * EMA of the resting position and run jump detection.
   */
  private processSample(): void {
    const currentY = getSmoothedY(this.yPositions);

    if (this.state === "warming") {
      this.warmupTotal += currentY;
      this.warmupSamples++;
      if (this.warmupSamples >= WARMUP_SAMPLES) {
        this.baselineY = this.warmupTotal / this.warmupSamples;
        this.setState("detecting");
        this.setStatus("Jump to flap!");
      }
      return;
    }

    // Track the resting head between runs; hold it fixed once a run locks in
    // (this.locked) and while mid-jump, so the jump can't pull its own
    // reference upward.
    if (this.state === "detecting" && !this.locked) {
      this.baselineY =
        this.baselineY * (1 - BASELINE_ADAPT_RATE) + currentY * BASELINE_ADAPT_RATE;
    }

    this.detectJump(currentY);
  }

  // ---- jump detection (exact legacy port; baseline now adaptive) --------------------------

  private detectJump(currentY: number): void {
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
      this.setStatus("Jump to flap!");
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

/**
 * Lock the resting baseline for a run (true) or let it roll between runs
 * (false). The game calls this on its ready→playing / →gameover transitions so
 * the baseline "locks in place" the moment you start and re-tracks while idle.
 * No-op if the camera never initialised (permission denied / not started).
 */
export function setPoseLocked(locked: boolean): void {
  active?.setLocked(locked);
}

// ---- DOM (styled to match the app's dark "glass pill" HUD) --------------------------------

const PANEL_STYLE_ID = "fd-pose-cam-style";

/**
 * Inject the panel stylesheet once. Mirrors the HUD pills in index.html
 * (dark translucent glass, hairline light border, monospace, #eef2ff, blur).
 * Video + overlay are flipped horizontally for a natural selfie view — both get
 * the same transform so the skeleton stays registered on the face. (Jump
 * detection is vertical-only, so the mirror is purely cosmetic.)
 */
function injectStyles(): void {
  if (document.getElementById(PANEL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PANEL_STYLE_ID;
  style.textContent = `
    .fd-cam {
      position: fixed; right: 12px; bottom: 12px; z-index: 20;
      width: 384px; max-width: calc(100vw - 24px); padding: 6px;
      border-radius: 14px;
      background: rgba(10, 12, 28, 0.62);
      border: 1px solid rgba(255, 255, 255, 0.22);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      font: 11px/1.3 ui-monospace, "SF Mono", Menlo, monospace;
      color: #eef2ff;
    }
    .fd-cam__screen {
      position: relative; overflow: hidden; border-radius: 8px;
      /* Holds the frame's shape before the stream loads / if permission is
         denied (video is height:auto → 0 until it has dimensions). Kept below
         the loaded video height (≈216–288px at 384px wide) so it never
         letterboxes the overlay once live. */
      min-height: 180px;
      background: rgba(0, 0, 0, 0.35);
    }
    .fd-cam__video, .fd-cam__overlay { transform: scaleX(-1); }
    .fd-cam__video { display: block; width: 100%; height: auto; }
    .fd-cam__overlay { position: absolute; inset: 0; width: 100%; height: 100%; }
    .fd-cam__controls {
      position: absolute; left: 8px; right: 8px; bottom: 8px;
      display: flex; align-items: center; gap: 8px;
    }
    .fd-cam__btn {
      flex: none; padding: 5px 12px; border-radius: 8px;
      background: rgba(255, 255, 255, 0.14);
      border: 1px solid rgba(255, 255, 255, 0.32);
      color: #eef2ff; font: inherit; letter-spacing: 1px;
      text-transform: uppercase; cursor: pointer;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      transition: background 0.15s ease, opacity 0.15s ease;
    }
    .fd-cam__btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.26); }
    .fd-cam__btn:disabled { opacity: 0.5; cursor: default; }
    .fd-cam__status {
      min-width: 0; letter-spacing: 0.5px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75);
    }
  `;
  document.head.appendChild(style);
}

function buildPanel(parent: HTMLElement): Panel {
  injectStyles();

  const root = document.createElement("div");
  root.className = "fd-cam";

  const screen = document.createElement("div");
  screen.className = "fd-cam__screen";

  const video = document.createElement("video");
  video.className = "fd-cam__video";
  video.playsInline = true;

  const overlay = document.createElement("canvas");
  overlay.className = "fd-cam__overlay";

  const controls = document.createElement("div");
  controls.className = "fd-cam__controls";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "fd-cam__btn";
  button.textContent = "Start";

  const status = document.createElement("span");
  status.className = "fd-cam__status";

  controls.append(button, status);
  screen.append(video, overlay, controls);
  root.append(screen);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
