import { DrawingUtils, FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { isPlaytestRequested } from "@vibedgames/playtest";

const JUMP_THRESHOLD = 0.1;
const SMOOTHING_WINDOW = 5;
const MAX_JUMP_HEIGHT_FACTOR = 2;
const NOSE_INDEX = 0;
const MIN_VISIBILITY = 0.3;

const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;
const FLAP_STROKE = 0.55;
const FLAP_REARM = 0.3;
const MAX_FLAP_FACTOR = 2;
const FLAP_SMOOTHING_WINDOW = 3;
const MIN_SHOULDER_WIDTH = 0.06;
const JUMP_STUCK_MS = 2500;

const WARMUP_SAMPLES = 15;
const BASELINE_ADAPT_RATE = 0.02;

const WASM_BASE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

type PoseState = "idle" | "loading" | "warming" | "detecting" | "jumping";

/**
 * strength ∈ [0,1]. refire=false on the initial threshold-cross; true for the
 * airborne min-Y updates of the same physical jump (velocity-only refreshes —
 * the legacy game set bird velocity on every callback).
 */
export type PoseJumpHandler = (strength: number, refire: boolean) => void;

interface Panel {
  root: HTMLDivElement;
  screen: HTMLDivElement;
  video: HTMLVideoElement;
  overlay: HTMLCanvasElement;
  button: HTMLButtonElement;
  recal: HTMLButtonElement;
  status: HTMLSpanElement;
  cap: HTMLDivElement;
}

const getSmoothedY = (positions: number[]) => {
  if (positions.length === 0) {
    return 0;
  }

  return positions.reduce((sum, val) => sum + val, 0) / positions.length;
};

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

class PoseCamera {
  private attempt = 0;
  private raf: number | null = null;
  private releaseMediaEvents: (() => void) | null = null;
  private state: PoseState = "idle";
  private baselineY = 0;
  private minY = Infinity;
  private jumpStartedAt = 0;
  private yPositions: number[] = [];
  private warmupSamples = 0;
  private warmupTotal = 0;
  private locked = false;
  private wristYs: number[] = [];
  private flapArmed = false;
  private strokeTopY = Infinity;
  private strokeBottomY = -Infinity;
  private landmarker: PoseLandmarker | null = null;
  private stream: MediaStream | null = null;
  private detectionStarted = false;
  private noseVisible = false;
  private armsVisible = false;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private drawingUtils: DrawingUtils | null = null;

  private readonly ui: Panel;
  private onJump: PoseJumpHandler;
  private readonly autoStart: boolean;
  private userSized = false;

  constructor(ui: Panel, onJump: PoseJumpHandler, autoStart: boolean) {
    this.ui = ui;
    this.autoStart = autoStart;
    this.onJump = onJump;
    this.setStatus(autoStart ? "Click 'Start' to begin" : "Tap to enable the pose cam");
    this.ui.button.addEventListener("click", (e) => {
      e.stopPropagation();
      this.ui.button.blur();
      this.handleMainAction();
    });
    this.ui.recal.addEventListener("click", (e) => {
      e.stopPropagation();
      this.ui.recal.blur();
      this.recalibrate();
    });
    this.ui.screen.addEventListener("click", () => {
      const expanding = this.collapsed;
      this.userSized = true;
      this.setCollapsed(!this.collapsed);

      if (expanding && this.state === "idle") {
        this.start();
      }
    });

    const isActivationKey = (event: KeyboardEvent) =>
      event.target === this.ui.screen && (event.key === "Enter" || event.key === " ");

    this.ui.screen.addEventListener("keydown", (event) => {
      if (!isActivationKey(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (!event.repeat) {
        this.ui.screen.click();
      }
    });
    this.ui.screen.addEventListener("keyup", (event) => {
      if (!isActivationKey(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    });

    if (autoStart) {
      this.start();
    }
  }

  setHandler(onJump: PoseJumpHandler) {
    this.onJump = onJump;
  }

  private setState(state: PoseState) {
    this.state = state;
    this.ui.button.classList.toggle("fd-cam__btn--off", state !== "idle");
    const tracking = state === "detecting" || state === "jumping";
    this.ui.recal.classList.toggle("fd-cam__btn--off", !tracking);
  }

  setLocked(locked: boolean) {
    this.locked = locked;
  }

  recalibrate() {
    if (this.state !== "detecting" && this.state !== "jumping") {
      return;
    }

    this.yPositions = [];
    this.minY = Infinity;
    this.wristYs = [];
    this.flapArmed = false;
    this.strokeTopY = Infinity;
    this.strokeBottomY = -Infinity;
    this.beginWarmup();
  }

  private get collapsed() {
    return this.ui.root.classList.contains("fd-cam--collapsed");
  }

  private setCollapsed(collapsed: boolean) {
    this.ui.root.classList.toggle("fd-cam--collapsed", collapsed);
    this.ui.screen.setAttribute("aria-expanded", String(!collapsed));
  }

  private setStatus(text: string) {
    if (this.ui.status.textContent !== text) {
      this.ui.status.textContent = text;
    }
  }

  private handleMainAction() {
    if (this.state === "idle") {
      this.start();
    }
  }

  private start() {
    if (this.state !== "idle") {
      return;
    }

    this.attempt += 1;
    const { attempt } = this;
    this.setState("loading");
    this.ui.cap.textContent = "📷 LOADING";
    this.ui.screen.setAttribute("aria-label", "Pose camera preview");
    this.ui.screen.title = "";
    this.setStatus("Starting camera and loading model...");
    void this.startCamera(attempt);
  }

  private current(attempt: number) {
    return attempt === this.attempt;
  }

  private releaseCapture() {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
    }

    this.raf = null;
    this.detectionStarted = false;
    this.releaseMediaEvents?.();
    this.releaseMediaEvents = null;
    this.ui.video.pause();
    this.ui.video.srcObject = null;

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
    }

    this.stream = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.drawingUtils?.close();
    this.drawingUtils = null;
    this.overlayCtx = null;
  }

  private failStart(attempt: number, message: string) {
    if (!this.current(attempt)) {
      return;
    }

    this.attempt += 1;
    this.releaseCapture();
    this.ui.root.classList.remove("fd-cam--live");
    this.setStatus(message);
    this.setState("idle");
    this.ui.cap.textContent = "📷 RETRY";
    this.ui.screen.setAttribute("aria-label", "Camera unavailable. Retry pose camera");
    this.ui.screen.title = `${message}. Click to retry.`;
    this.setCollapsed(true);
  }

  private async startCamera(attempt: number) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user" },
      });

      if (!this.current(attempt)) {
        for (const track of stream.getTracks()) {
          track.stop();
        }

        return;
      }

      this.stream = stream;

      const { video } = this.ui;
      const tracks = stream.getTracks();

      const onEnded = () => {
        this.failStart(attempt, "Camera stream ended");
      };

      const onVideoError = () => {
        if (video.srcObject !== stream || video.error === null) {
          return;
        }

        this.failStart(
          attempt,
          `Camera interrupted: ${video.error.message || "Video playback failed"}`,
        );
      };

      const onMetadata = () => {
        if (!this.current(attempt) || this.overlayCtx !== null) {
          return;
        }

        try {
          this.ui.root.classList.add("fd-cam--live");

          if (
            this.autoStart &&
            !this.userSized &&
            Math.min(window.innerWidth, window.innerHeight) >= 560
          ) {
            this.setCollapsed(false);
          }

          this.ui.overlay.width = video.videoWidth;
          this.ui.overlay.height = video.videoHeight;
          const ctx = this.ui.overlay.getContext("2d");

          if (!ctx) {
            this.failStart(attempt, "Error: overlay canvas has no 2d context");

            return;
          }

          this.overlayCtx = ctx;
          this.drawingUtils = new DrawingUtils(ctx);
          void this.loadModel(attempt);
        } catch (error) {
          this.failStart(attempt, `Error: ${errorMessage(error)}`);
        }
      };

      for (const track of tracks) {
        track.addEventListener("ended", onEnded);
      }

      video.addEventListener("error", onVideoError);
      video.addEventListener("loadedmetadata", onMetadata, { once: true });
      this.releaseMediaEvents = () => {
        for (const track of tracks) {
          track.removeEventListener("ended", onEnded);
        }

        video.removeEventListener("error", onVideoError);
        video.removeEventListener("loadedmetadata", onMetadata);
      };

      video.srcObject = stream;

      if (tracks.some((track) => track.readyState === "ended")) {
        onEnded();

        return;
      }

      if (video.readyState >= 1 && video.videoWidth > 0) {
        onMetadata();
      }

      if (!this.current(attempt)) {
        return;
      }

      await video.play();
    } catch (error) {
      this.failStart(attempt, `Error: ${errorMessage(error)}`);
    }
  }

  private async loadModel(attempt: number) {
    try {
      this.setStatus("Loading pose detection model...");

      const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL);

      if (!this.current(attempt)) {
        return;
      }

      const landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          delegate: "GPU",
          modelAssetPath: MODEL_URL,
        },
        numPoses: 1,
        runningMode: "VIDEO",
      });

      if (!this.current(attempt)) {
        landmarker.close();

        return;
      }

      this.landmarker = landmarker;

      this.beginWarmup();
      this.startDetection(attempt);
    } catch (error) {
      this.failStart(attempt, `Error loading model: ${errorMessage(error)}`);
    }
  }

  private startDetection(attempt: number) {
    if (!this.current(attempt) || this.detectionStarted) {
      return;
    }

    this.detectionStarted = true;

    let lastVideoTime = -1;
    let lastTimestamp = 0;

    const detectFrame = () => {
      if (!this.current(attempt)) {
        return;
      }

      this.raf = null;
      const { video } = this.ui;
      const { landmarker } = this;

      if (video.readyState !== 4 || landmarker === null) {
        this.raf = requestAnimationFrame(detectFrame);

        return;
      }

      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const now = performance.now();
        const timestamp = now > lastTimestamp ? now : lastTimestamp + 1;
        lastTimestamp = timestamp;

        try {
          const result = landmarker.detectForVideo(video, timestamp);
          const [landmarks] = result.landmarks;
          this.noseVisible = false;
          this.armsVisible = false;

          if (landmarks) {
            this.drawSkeleton(landmarks);

            const nose = landmarks[NOSE_INDEX];

            if (nose && nose.visibility > MIN_VISIBILITY) {
              this.noseVisible = true;
              const noseY = nose.y * (video.videoHeight || 1);
              this.yPositions.unshift(noseY);

              if (this.yPositions.length > SMOOTHING_WINDOW) {
                this.yPositions.pop();
              }

              this.processSample();
            }

            if (!this.current(attempt)) {
              return;
            }

            this.processArmFlap(landmarks);
          } else {
            this.overlayCtx?.clearRect(0, 0, this.ui.overlay.width, this.ui.overlay.height);
          }

          this.showReadiness();
        } catch (error) {
          this.failStart(attempt, `Tracking interrupted: ${errorMessage(error)}`);
        }
      }

      if (this.current(attempt)) {
        this.raf = requestAnimationFrame(detectFrame);
      }
    };

    detectFrame();
  }

  private beginWarmup() {
    this.setState("warming");
    this.ui.cap.textContent = "📷 CENTERING";
    this.setStatus("Centering · stand naturally");
    this.warmupSamples = 0;
    this.warmupTotal = 0;
    this.baselineY = 0;
  }

  private processSample() {
    const currentY = getSmoothedY(this.yPositions);

    if (this.state === "warming") {
      this.warmupTotal += currentY;
      this.warmupSamples += 1;

      if (this.warmupSamples >= WARMUP_SAMPLES) {
        this.baselineY = this.warmupTotal / this.warmupSamples;
        this.setState("detecting");
      }

      return;
    }

    if (this.state === "detecting" && !this.locked) {
      this.baselineY = this.baselineY * (1 - BASELINE_ADAPT_RATE) + currentY * BASELINE_ADAPT_RATE;
    }

    this.detectJump(currentY);
  }

  private detectJump(currentY: number) {
    const heightDiff = this.baselineY - currentY;
    const jumpThreshold = this.baselineY * JUMP_THRESHOLD;

    if (heightDiff > jumpThreshold && this.state === "detecting") {
      this.setState("jumping");
      this.minY = currentY;
      this.jumpStartedAt = performance.now();

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
    } else if (this.state === "jumping" && performance.now() - this.jumpStartedAt > JUMP_STUCK_MS) {
      this.setState("detecting");
    }
  }

  private processArmFlap(landmarks: NormalizedLandmark[]) {
    if (this.state !== "detecting" && this.state !== "jumping") {
      return;
    }

    const ls = landmarks[LEFT_SHOULDER];
    const rs = landmarks[RIGHT_SHOULDER];
    const lw = landmarks[LEFT_WRIST];
    const rw = landmarks[RIGHT_WRIST];

    if (!ls || !rs || !lw || !rw) {
      return;
    }

    if (
      ls.visibility < MIN_VISIBILITY ||
      rs.visibility < MIN_VISIBILITY ||
      lw.visibility < MIN_VISIBILITY ||
      rw.visibility < MIN_VISIBILITY
    ) {
      return;
    }

    const scale = Math.abs(ls.x - rs.x);

    if (scale < MIN_SHOULDER_WIDTH) {
      return;
    }

    this.armsVisible = true;

    this.wristYs.unshift((lw.y + rw.y) / 2);

    if (this.wristYs.length > FLAP_SMOOTHING_WINDOW) {
      this.wristYs.pop();
    }

    const wy = getSmoothedY(this.wristYs);

    if (this.flapArmed) {
      this.strokeTopY = Math.min(this.strokeTopY, wy);
      const stroke = wy - this.strokeTopY;

      if (stroke > FLAP_STROKE * scale) {
        this.flapArmed = false;
        this.strokeBottomY = wy;

        if (this.state !== "jumping") {
          const strength = Math.min(stroke / (FLAP_STROKE * scale * MAX_FLAP_FACTOR), 1);
          this.onJump(strength, false);
        }
      }
    } else {
      this.strokeBottomY = Math.max(this.strokeBottomY, wy);

      if (this.strokeBottomY - wy > FLAP_REARM * scale) {
        this.flapArmed = true;
        this.strokeTopY = wy;
      }
    }
  }

  private showReadiness() {
    const [label, detail] = this.readiness();
    const cap = `📷 ${label}`;

    if (this.ui.cap.textContent !== cap) {
      this.ui.cap.textContent = cap;
    }

    this.setStatus(detail);
  }

  private readiness() {
    if (this.state === "warming") {
      const n = `${this.warmupSamples}/${WARMUP_SAMPLES}`;

      return (
        this.noseVisible
          ? [`CENTER ${n}`, `Centering ${n} · stand naturally`]
          : ["FIND FACE", "Step into view to center your pose"]
      ) satisfies [label: string, detail: string];
    }

    if (this.noseVisible && this.armsVisible) {
      return ["POSE READY", "Ready · jump or flap your arms"] satisfies [
        label: string,
        detail: string,
      ];
    }

    if (this.noseVisible) {
      return ["JUMP READY", "Jump ready · show wrists to flap too"] satisfies [
        label: string,
        detail: string,
      ];
    }

    if (this.armsVisible) {
      return ["ARMS READY", "Arms ready · show your face to jump too"] satisfies [
        label: string,
        detail: string,
      ];
    }

    return ["FIND YOU", "Step into view · keyboard and tap still work"] satisfies [
      label: string,
      detail: string,
    ];
  }

  private drawSkeleton(landmarks: NormalizedLandmark[]) {
    const ctx = this.overlayCtx;
    const { drawingUtils } = this;

    if (!ctx || !drawingUtils) {
      return;
    }

    ctx.clearRect(0, 0, this.ui.overlay.width, this.ui.overlay.height);

    drawingUtils.drawLandmarks(landmarks, {
      color: "red",
      fillColor: "red",
      radius: 3,
    });
    drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
      color: "blue",
      lineWidth: 2,
    });
  }
}

const PANEL_STYLE_ID = "fd-pose-cam-style";

const injectStyles = () => {
  if (document.querySelector(`#${PANEL_STYLE_ID}`)) {
    return;
  }

  const style = document.createElement("style");
  style.id = PANEL_STYLE_ID;
  style.textContent = `
    .fd-cam {
      position: fixed; z-index: 20;
      right: calc(12px + env(safe-area-inset-right));
      bottom: calc(12px + env(safe-area-inset-bottom));
      width: 512px; max-width: calc(100vw - 24px); padding: 6px;
      border-radius: 14px;
      background: rgba(10, 12, 28, 0.62);
      border: 1px solid rgba(255, 255, 255, 0.22);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      font: 11px/1.3 ui-monospace, "SF Mono", Menlo, monospace;
      color: #eef2ff;
      pointer-events: none;
    }
    .fd-cam__screen {
      position: relative; overflow: hidden; border-radius: 8px;
      /* Holds the frame's shape before the stream loads / if permission is
         denied (video is height:auto → 0 until it has dimensions). Kept below
         the loaded video height so it never letterboxes the overlay once live. */
      min-height: 180px;
      background: rgba(0, 0, 0, 0.35);
      cursor: pointer;
      pointer-events: auto; touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    @media (min-width: 600px) {
      .fd-cam:not(.fd-cam--collapsed) { width: min(512px, 45vw); }
    }
    @media (max-height: 520px) and (min-width: 600px) {
      .fd-cam:not(.fd-cam--collapsed) { width: min(320px, 45vw); }
    }
    .fd-cam--collapsed { width: 120px; }
    .fd-cam--collapsed .fd-cam__screen { min-height: 44px; }
    .fd-cam--collapsed .fd-cam__controls { display: none; }
    .fd-cam__cap { display: none; }
    .fd-cam--collapsed .fd-cam__cap {
      display: block; position: absolute; left: 0; right: 0; bottom: 5px;
      text-align: center; letter-spacing: 1px; text-transform: uppercase;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75);
      pointer-events: none;
    }
    .fd-cam__video, .fd-cam__overlay { transform: scaleX(-1); }
    /* Hidden until the stream reports dimensions (fd-cam--live) — a
       stream-less <video> renders at its 300×150 replaced-element default. */
    .fd-cam__video { display: none; width: 100%; height: auto; }
    .fd-cam--live .fd-cam__video { display: block; }
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
      pointer-events: auto; touch-action: manipulation;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      transition: background 0.15s ease, opacity 0.15s ease;
    }
    .fd-cam__btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.26); }
    .fd-cam__btn:disabled { opacity: 0.5; cursor: default; }
    /* Hidden, not removed: the state machine swaps which button is showing and
       display:none slid the status text sideways under the player. */
    .fd-cam__btn--off { visibility: hidden; }
    .fd-cam__status {
      min-width: 0; letter-spacing: 0.5px;
      white-space: normal; line-height: 1.4;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75);
    }
  `;
  document.head.append(style);
};

const buildPanel = (parent: HTMLElement, collapsed: boolean) => {
  injectStyles();

  const root = document.createElement("div");
  root.className = collapsed ? "fd-cam fd-cam--collapsed" : "fd-cam";

  const screen = document.createElement("div");
  screen.className = "fd-cam__screen";
  screen.tabIndex = 0;
  screen.setAttribute("role", "button");
  screen.setAttribute("aria-label", "Pose camera preview");
  screen.setAttribute("aria-expanded", String(!collapsed));

  const video = document.createElement("video");
  video.className = "fd-cam__video";
  video.playsInline = true;

  const overlay = document.createElement("canvas");
  overlay.className = "fd-cam__overlay";

  const cap = document.createElement("div");
  cap.className = "fd-cam__cap";
  cap.textContent = "📷 pose";

  const controls = document.createElement("div");
  controls.className = "fd-cam__controls";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "fd-cam__btn";
  button.textContent = "Start";

  const recal = document.createElement("button");
  recal.type = "button";
  recal.className = "fd-cam__btn";
  recal.textContent = "Recalibrate";
  recal.title = "Re-capture your resting position";
  recal.classList.add("fd-cam__btn--off");

  const status = document.createElement("span");
  status.className = "fd-cam__status";
  status.setAttribute("role", "status");

  controls.append(button, recal, status);
  screen.append(video, overlay, cap, controls);
  root.append(screen);
  parent.append(root);

  new ResizeObserver(() => {
    const { height } = root.getBoundingClientRect();
    document.documentElement.style.setProperty("--fd-cam-h", `${Math.round(height)}px`);
  }).observe(root);

  return { button, cap, overlay, recal, root, screen, status, video };
};

let active: PoseCamera | null = null;

/** Coarse-pointer/touch detection — decide input-aware copy + layout at boot. */
export const isCoarsePointer = () =>
  window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

/**
 * Create the bottom-right webcam panel and begin camera + model startup
 * (idempotent — repeat calls just swap the jump handler). Failures degrade to
 * a status message on the collapsed pill while keyboard/tap input keeps
 * working. The panel boots as a pill everywhere — the preview only unfolds
 * once a stream is live, so a denied or unsupported camera never parks a
 * blank frame on the start screen. Touch defers getUserMedia behind a tap on
 * the pill; desktop keeps the legacy auto-start.
 */
export const initPoseCamera = (onJump: PoseJumpHandler) => {
  if (active !== null) {
    active.setHandler(onJump);

    return;
  }

  const autoStart = !isCoarsePointer() && !isPlaytestRequested();
  active = new PoseCamera(buildPanel(document.body, true), onJump, autoStart);
};

/**
 * Lock the resting baseline for a run (true) or let it roll between runs
 * (false). The game calls this on its ready→playing / →gameover transitions so
 * the baseline "locks in place" the moment you start and re-tracks while idle.
 * No-op if the camera never initialised (permission denied / not started).
 */
export const setPoseLocked = (locked: boolean) => {
  active?.setLocked(locked);
};

/**
 * Re-seed the resting pose baseline (the game calls this when its start
 * countdown begins, so calibration captures the player once they're in
 * position). No-op if the camera never initialised or isn't tracking yet —
 * recalibrate() only has effect past warm-up, and warm-up already self-seeds.
 */
export const recalibratePose = () => {
  active?.recalibrate();
};
