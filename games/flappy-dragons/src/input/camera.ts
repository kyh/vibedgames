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
 * The module owns its DOM: a rounded bottom-right panel with live video, a
 * skeleton overlay (red landmark dots r=3, blue connectors lw=2), and a status
 * line. Normal play is button-free — a Start button surfaces only if
 * camera/model startup fails, to retry. On desktop the panel is full-size
 * (384px) and camera + model startup begins automatically on init — the legacy
 * app mounted the component on page load, which kicked off getUserMedia
 * immediately. On touch devices (and tiny windows) the panel boots as a ~120px
 * pill instead — the full card would blanket the prime thumb zone — and
 * getUserMedia waits for a tap on the pill (a user gesture, as phones
 * require). Clicking the camera view toggles it between full size and the
 * pill — the view itself is the only size control. Taps on the panel are
 * consumed by it (they size-toggle rather than flap); everywhere else on
 * screen still flaps. If permission is denied or loading fails, the panel
 * shows the error and the game stays fully playable with keyboard/tap.
 */

import { DrawingUtils, FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

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

// ---- arm-flap detection ---------------------------------------------------------

/** MediaPipe landmark indices for the wing joints. */
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;
/** Downward wrist stroke that fires a flap, as a fraction of shoulder width
 *  (normalized units) — distance-invariant: the closer you stand, the bigger
 *  both your shoulders and the required stroke read on screen. */
const FLAP_STROKE = 0.55;
/** Upward wrist recovery that re-arms the next beat, as a fraction of shoulder width. */
const FLAP_REARM = 0.3;
/** A stroke of FLAP_STROKE × this factor maps to strength 1. */
const MAX_FLAP_FACTOR = 2;
/** Moving-average window over the averaged wrist Y, in frames. */
const FLAP_SMOOTHING_WINDOW = 3;
/** Shoulders closer than this (normalized) are a bad read — skip the frame. */
const MIN_SHOULDER_WIDTH = 0.06;
/**
 * A "jump" that never lands within this window is a stuck read (the player
 * shifted posture, so the nose never settles back near the frozen baseline).
 * Drop back to detecting and let the rolling baseline re-track — otherwise
 * jump detection stays dead until a recalibration.
 */
const JUMP_STUCK_MS = 2500;

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

// ---- state machine ---------------------------------------------------------------

// ---- pure helpers --------------------------------------------------------------------------

const getSmoothedY = (positions: number[]): number => {
  if (positions.length === 0) {
    return 0;
  }
  return positions.reduce((sum, val) => sum + val, 0) / positions.length;
};

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

class PoseCamera {
  /**
   * Startup attempt token. A failure (denied permission, track ended, tracking
   * exception) invalidates every async continuation of the attempt it belongs
   * to, so a late model load can't resurrect a camera the retry already replaced.
   */
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
  /** While true the baseline is frozen — set for the duration of a game run. */
  private locked = false;
  // Arm-flap (wing-beat) state: armed at the top of a stroke, fires on the
  // downstroke, re-arms once the wrists recover upward.
  private wristYs: number[] = [];
  private flapArmed = false;
  private strokeTopY = Infinity;
  private strokeBottomY = -Infinity;
  private landmarker: PoseLandmarker | null = null;
  private stream: MediaStream | null = null;
  private detectionStarted = false;
  /** Observation only: never used by the detectors or baseline. */
  private noseVisible = false;
  private armsVisible = false;
  /** Overlay 2d context + DrawingUtils, created once when the stream is sized. */
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private drawingUtils: DrawingUtils | null = null;

  private readonly ui: Panel;
  private onJump: PoseJumpHandler;
  private readonly autoStart: boolean;
  /** The player chose a panel size by hand; a later live stream must not undo it. */
  private userSized = false;

  constructor(ui: Panel, onJump: PoseJumpHandler, autoStart: boolean) {
    this.ui = ui;
    this.autoStart = autoStart;
    this.onJump = onJump;
    this.setStatus(autoStart ? "Click 'Start' to begin" : "Tap to enable the pose cam");
    this.ui.button.addEventListener("click", (e) => {
      // Don't also toggle the panel size.
      e.stopPropagation();
      // Drop focus so Space (a game input) can't re-activate the button.
      this.ui.button.blur();
      this.handleMainAction();
    });
    this.ui.recal.addEventListener("click", (e) => {
      // Don't also toggle the panel size.
      e.stopPropagation();
      this.ui.recal.blur();
      this.recalibrate();
    });
    // The camera view itself is the size toggle: click to expand/collapse.
    // Expanding also starts the camera if it never did (touch defers
    // getUserMedia until this user gesture).
    this.ui.screen.addEventListener("click", () => {
      const expanding = this.collapsed;
      this.userSized = true;
      this.setCollapsed(!this.collapsed);
      if (expanding && this.state === "idle") {
        this.start();
      }
    });
    // Keyboard activation of the focused preview must not leak Space/Enter to
    // the game as a flap, so both edges are swallowed here.
    const isActivationKey = (event: KeyboardEvent): boolean =>
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
      // Legacy mounted the component on page load and auto-started immediately.
      this.start();
    }
  }

  setHandler(onJump: PoseJumpHandler): void {
    this.onJump = onJump;
  }

  // ---- UI plumbing ---------------------------------------------------------------

  private setState(state: PoseState): void {
    this.state = state;
    // The button exists only to retry after a startup failure; normal play is
    // clickless (the baseline locks itself at game-start).
    this.ui.button.classList.toggle("fd-cam__btn--off", state !== "idle");
    // Recalibrate only makes sense once tracking is live.
    const tracking = state === "detecting" || state === "jumping";
    this.ui.recal.classList.toggle("fd-cam__btn--off", !tracking);
  }

  /** Freeze the baseline for a run (true) / resume rolling between runs (false). */
  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  /** Re-seed the resting baseline from scratch (moved chair, new player, bad
   *  lock). Clears jump + arm-flap state and re-runs the warm-up capture. */
  recalibrate(): void {
    // Only meaningful once tracking is live — warm-up already self-seeds, and
    // resetting mid-load would corrupt the startup state machine.
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

  private get collapsed(): boolean {
    return this.ui.root.classList.contains("fd-cam--collapsed");
  }

  private setCollapsed(collapsed: boolean): void {
    this.ui.root.classList.toggle("fd-cam--collapsed", collapsed);
    this.ui.screen.setAttribute("aria-expanded", String(!collapsed));
  }

  private setStatus(text: string): void {
    if (this.ui.status.textContent !== text) {
      this.ui.status.textContent = text;
    }
  }

  /** The button is only shown in "idle" — a retry after a startup failure. */
  private handleMainAction(): void {
    if (this.state === "idle") {
      this.start();
    }
  }

  // ---- startup --------------------------------------------------------------------

  private start(): void {
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

  private current(attempt: number): boolean {
    return attempt === this.attempt;
  }

  private releaseCapture(): void {
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

  private failStart(attempt: number, message: string): void {
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

  private async startCamera(attempt: number): Promise<void> {
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
      const onEnded = (): void => this.failStart(attempt, "Camera stream ended");
      const onVideoError = (): void => {
        if (video.srcObject !== stream || video.error === null) {
          return;
        }
        this.failStart(
          attempt,
          `Camera interrupted: ${video.error.message || "Video playback failed"}`,
        );
      };
      // Reached from the event or, if the stream was already sized, directly
      // below; overlayCtx marks it done for this attempt.
      const onMetadata = (): void => {
        if (!this.current(attempt) || this.overlayCtx !== null) {
          return;
        }
        try {
          // Reveal the video only once it has real dimensions — a stream-less
          // <video> renders at its 300×150 default and bloats the pill.
          this.ui.root.classList.add("fd-cam--live");
          // Desktop unfolds the preview by itself once there is something to
          // show; a cramped window stays a pill like touch does.
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
      // Graceful degradation: show why, fall back to keyboard/tap input.
      this.failStart(attempt, `Error: ${errorMessage(error)}`);
    }
  }

  private async loadModel(attempt: number): Promise<void> {
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

  // ---- detection loop ----------------------------------------------------------------

  private startDetection(attempt: number): void {
    if (!this.current(attempt) || this.detectionStarted) {
      return;
    }
    this.detectionStarted = true;

    let lastVideoTime = -1;
    let lastTimestamp = 0;

    const detectFrame = (): void => {
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
        // MediaPipe requires strictly increasing timestamps.
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

            // Nose coordinates are normalized (0-1) — convert to pixel Y so the
            // calibrated baseline matches the legacy numbers.
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

  // ---- adaptive baseline ---------------------------------------------------------------

  /** Enter warm-up: collect samples to seed the baseline, then arm jumps automatically. */
  private beginWarmup(): void {
    this.setState("warming");
    this.ui.cap.textContent = "📷 CENTERING";
    this.setStatus("Centering · stand naturally");
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
      this.warmupSamples += 1;
      if (this.warmupSamples >= WARMUP_SAMPLES) {
        this.baselineY = this.warmupTotal / this.warmupSamples;
        this.setState("detecting");
      }
      return;
    }

    // Track the resting head between runs; hold it fixed once a run locks in
    // (this.locked) and while mid-jump, so the jump can't pull its own
    // reference upward.
    if (this.state === "detecting" && !this.locked) {
      this.baselineY = this.baselineY * (1 - BASELINE_ADAPT_RATE) + currentY * BASELINE_ADAPT_RATE;
    }

    this.detectJump(currentY);
  }

  // ---- jump detection (exact legacy port; baseline now adaptive) --------------------------

  private detectJump(currentY: number): void {
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
      // Never landed — stuck read. Re-arm detection and let the baseline
      // re-track from wherever the player settled.
      this.setState("detecting");
    }
  }

  // ---- arm-flap (wing-beat) detection ------------------------------------------

  /**
   * Flapping both arms like wings flaps the dragon: fire on each fast downward
   * wrist stroke, re-arm once the wrists recover upward. Runs alongside the
   * nose-jump detector but stays quiet mid-jump so one physical motion can't
   * double-fire.
   */
  private processArmFlap(landmarks: NormalizedLandmark[]): void {
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
      // Track the top of the stroke (smallest y = highest wrists), fire once
      // the downstroke travels far enough.
      this.strokeTopY = Math.min(this.strokeTopY, wy);
      const stroke = wy - this.strokeTopY;
      if (stroke > FLAP_STROKE * scale) {
        this.flapArmed = false;
        this.strokeBottomY = wy;
        // A body-jump already flapped this instant — don't double-fire.
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

  /** Read-only projection of tracking; these labels never arm or gate controls. */
  private showReadiness(): void {
    const [label, detail] = this.readiness();
    const cap = `📷 ${label}`;
    if (this.ui.cap.textContent !== cap) {
      this.ui.cap.textContent = cap;
    }
    this.setStatus(detail);
  }

  private readiness(): [label: string, detail: string] {
    if (this.state === "warming") {
      const n = `${this.warmupSamples}/${WARMUP_SAMPLES}`;
      return this.noseVisible
        ? [`CENTER ${n}`, `Centering ${n} · stand naturally`]
        : ["FIND FACE", "Step into view to center your pose"];
    }
    if (this.noseVisible && this.armsVisible) {
      return ["POSE READY", "Ready · jump or flap your arms"];
    }
    if (this.noseVisible) {
      return ["JUMP READY", "Jump ready · show wrists to flap too"];
    }
    if (this.armsVisible) {
      return ["ARMS READY", "Arms ready · show your face to jump too"];
    }
    return ["FIND YOU", "Step into view · keyboard and tap still work"];
  }

  // ---- skeleton overlay ------------------------------------------------------

  /** Skeleton overlay: red landmark dots (r=3) + blue connectors (lineWidth=2). */
  private drawSkeleton(landmarks: NormalizedLandmark[]): void {
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

// ---- DOM (styled to match the app's dark "glass pill" HUD) --------------------------------

const PANEL_STYLE_ID = "fd-pose-cam-style";

/**
 * Inject the panel stylesheet once. Mirrors the HUD pills in index.html
 * (dark translucent glass, hairline light border, monospace, #eef2ff, blur).
 * Video + overlay are flipped horizontally for a natural selfie view — both get
 * the same transform so the skeleton stays registered on the face. (Jump
 * detection is vertical-only, so the mirror is purely cosmetic.)
 *
 * Pointer rules: the root ignores all events; the camera view (any size) and
 * the buttons are interactive — a click on the view toggles its size, so the
 * panel consumes its own taps instead of flapping.
 */
const injectStyles = (): void => {
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

const buildPanel = (parent: HTMLElement, collapsed: boolean): Panel => {
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

  // The bottom-centred HUD pills reach under this panel on a narrow screen and
  // disappear behind it once it expands, so publish how much of the bottom-right
  // corner it currently owns and let index.html lift them clear.
  new ResizeObserver(() => {
    const { height } = root.getBoundingClientRect();
    document.documentElement.style.setProperty("--fd-cam-h", `${Math.round(height)}px`);
  }).observe(root);

  return { button, cap, overlay, recal, root, screen, status, video };
};

// ---- module API ------------------------------------------------------------------------

let active: PoseCamera | null = null;

/** Coarse-pointer/touch detection — decide input-aware copy + layout at boot. */
export const isCoarsePointer = (): boolean =>
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
export const initPoseCamera = (onJump: PoseJumpHandler): void => {
  if (active !== null) {
    active.setHandler(onJump);
    return;
  }
  active = new PoseCamera(buildPanel(document.body, true), onJump, !isCoarsePointer());
};

/**
 * Lock the resting baseline for a run (true) or let it roll between runs
 * (false). The game calls this on its ready→playing / →gameover transitions so
 * the baseline "locks in place" the moment you start and re-tracks while idle.
 * No-op if the camera never initialised (permission denied / not started).
 */
export const setPoseLocked = (locked: boolean): void => {
  active?.setLocked(locked);
};

/**
 * Re-seed the resting pose baseline (the game calls this when its start
 * countdown begins, so calibration captures the player once they're in
 * position). No-op if the camera never initialised or isn't tracking yet —
 * recalibrate() only has effect past warm-up, and warm-up already self-seeds.
 */
export const recalibratePose = (): void => {
  active?.recalibrate();
};
