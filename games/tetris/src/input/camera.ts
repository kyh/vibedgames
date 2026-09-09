import type { DrawingUtils, NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";

import { isCoarsePointer } from "./touch";

/**
 * Webcam pose camera (plain TS port of the legacy React `camera.tsx`).
 *
 * Owns the bottom-right preview panel (video + skeleton overlay canvas),
 * the MediaPipe PoseLandmarker, and the rAF detection loop. Legacy
 * semantics preserved exactly:
 * - wasm from jsdelivr @0.10.3, pose_landmarker_lite float16 from
 *   storage.googleapis.com, GPU delegate, VIDEO mode, numPoses 1
 * - skeleton drawn per frame: red landmarks (radius 3), blue connectors
 *   (lineWidth 2), then the handler draws its guide boxes on the same ctx
 * - camera/model failure degrades to keyboard: log + visible status text.
 *
 * A fine pointer still auto-starts (main.ts). A coarse one waits for a tap on
 * the panel: getUserMedia at boot is a permission prompt before the player has
 * seen the game, and the model + wasm are megabytes competing with first paint.
 */

/** MediaPipe's wrapper JS is ~135 KB of the bundle and is dead weight until the
 *  player actually grants the camera, so it loads with the model, not at boot. */
type VisionTasks = typeof import("@mediapipe/tasks-vision");

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

/**
 * Keypoint with pixel coordinates, matching the interface previously provided
 * by @tensorflow-models/pose-detection (legacy-compatible names).
 */
export interface Keypoint {
  name: string;
  x: number;
  y: number;
  score: number;
}

export interface Pose {
  keypoints: Keypoint[];
  /** Source video frame dimensions (px) — keypoints are in this space, so
   *  pose interpretation normalises against these (no frozen-refW drift). */
  width: number;
  height: number;
}

/** Called once per detected frame, after the skeleton has been drawn. */
export type PoseHandler = (pose: Pose, overlay: CanvasRenderingContext2D | null) => void;

/** MediaPipe Pose landmark indices → human-readable names (MoveNet-compatible) */
const LANDMARK_NAMES = new Map<number, string>([
  [0, "nose"],
  [1, "left_eye_inner"],
  [2, "left_eye"],
  [3, "left_eye_outer"],
  [4, "right_eye_inner"],
  [5, "right_eye"],
  [6, "right_eye_outer"],
  [7, "left_ear"],
  [8, "right_ear"],
  [9, "mouth_left"],
  [10, "mouth_right"],
  [11, "left_shoulder"],
  [12, "right_shoulder"],
  [13, "left_elbow"],
  [14, "right_elbow"],
  [15, "left_wrist"],
  [16, "right_wrist"],
  [23, "left_hip"],
  [24, "right_hip"],
  [25, "left_knee"],
  [26, "right_knee"],
  [27, "left_ankle"],
  [28, "right_ankle"],
]);

/** Convert MediaPipe normalized landmarks to pixel-coordinate keypoints. */
function landmarksToKeypoints(
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
): Keypoint[] {
  return landmarks
    .map((lm, i) => {
      const name = LANDMARK_NAMES.get(i);
      if (!name) {
        return null;
      }
      return { name, score: lm.visibility, x: lm.x * width, y: lm.y * height };
    })
    .filter((kp): kp is Keypoint => kp !== null);
}

export class PoseCamera {
  private readonly onPose: PoseHandler;
  private readonly panel: HTMLDivElement;
  private readonly toggle: HTMLButtonElement;
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly status: HTMLDivElement;
  private landmarker: PoseLandmarker | null = null;
  private drawingUtils: DrawingUtils | null = null;
  private tasks: VisionTasks | null = null;
  private stream: MediaStream | null = null;
  private releaseMediaEvents: (() => void) | null = null;
  private rafId: number | null = null;
  private state: "idle" | "starting" | "live" | "unavailable" = "idle";
  /** Bumped on every start/failure so a stale await never touches a newer attempt. */
  private attempt = 0;
  private lastVideoTime = -1;
  private lastTimestamp = 0;

  constructor(onPose: PoseHandler) {
    this.onPose = onPose;
    const deferred = isCoarsePointer();

    // Never stack a second panel if the game is re-initialised.
    document.querySelector("#camera-panel")?.remove();

    this.panel = document.createElement("div");
    this.panel.id = "camera-panel";
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.canvas = document.createElement("canvas");
    this.status = document.createElement("div");
    this.status.id = "camera-status";
    this.status.textContent = deferred ? "tap to play with the camera" : "starting camera…";
    this.toggle = document.createElement("button");
    this.toggle.id = "camera-toggle";
    this.toggle.className = "camera-toggle";
    this.toggle.type = "button";
    this.panel.append(this.video, this.canvas, this.status, this.toggle);
    this.panel.dataset.gamepadIgnore = "";
    this.toggle.addEventListener("click", (event) => {
      this.panel.classList.toggle("expanded");
      if (this.state === "idle" || this.state === "unavailable") {
        void this.start();
      }
      this.updateToggle();
      // A mouse click must not leave the button focused: Space would then
      // toggle the panel instead of hard-dropping.
      if (event.detail > 0) {
        this.toggle.blur();
      }
    });
    this.updateToggle();
    document.body.append(this.panel);
  }

  /** Request the camera, play the video, then load the model. Retries after a
   *  failure (denied camera, unplugged device, model error) via the panel button. */
  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "unavailable") {
      return;
    }
    const attempt = ++this.attempt;
    this.state = "starting";
    this.setStatus("starting camera…");
    this.updateToggle();
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
      this.video.srcObject = stream;
      const tracks = stream.getTracks();
      const onEnded = (): void => this.fail(attempt);
      const onVideoError = (): void => {
        if (this.video.srcObject === stream && this.video.error !== null) {
          this.fail(attempt);
        }
      };
      for (const track of tracks) {
        track.addEventListener("ended", onEnded);
      }
      this.video.addEventListener("error", onVideoError);
      this.releaseMediaEvents = () => {
        for (const track of tracks) {
          track.removeEventListener("ended", onEnded);
        }
        this.video.removeEventListener("error", onVideoError);
      };
      if (tracks.some((track) => track.readyState === "ended")) {
        this.fail(attempt);
        return;
      }
      await this.video.play();
      if (!this.current(attempt)) {
        return;
      }
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;

      await this.loadModel(attempt);
      if (!this.current(attempt)) {
        return;
      }

      this.state = "live";
      this.setStatus(null);
      this.updateToggle();
      this.detectFrame(attempt);
    } catch (error) {
      if (this.current(attempt)) {
        console.error("Error starting camera or loading model:", error);
      }
      this.fail(attempt);
    }
  }

  private current(attempt: number): boolean {
    return this.attempt === attempt;
  }

  /** Degrade to keyboard/touch: stop the stream so the webcam LED matches the
   *  status text, and offer a retry. */
  private fail(attempt: number): void {
    if (!this.current(attempt)) {
      return;
    }
    this.attempt++;
    this.releaseCapture();
    this.state = "unavailable";
    this.setStatus(
      isCoarsePointer()
        ? "camera unavailable — retry · touch controls active"
        : "camera unavailable — retry · keyboard controls active",
    );
    this.updateToggle();
  }

  private releaseCapture(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    this.releaseMediaEvents?.();
    this.releaseMediaEvents = null;
    this.video.pause();
    this.video.srcObject = null;
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.drawingUtils?.close();
    this.drawingUtils = null;
    this.tasks = null;
    this.lastVideoTime = -1;
    this.lastTimestamp = 0;
  }

  private async loadModel(attempt: number): Promise<void> {
    const tasks = await import("@mediapipe/tasks-vision");
    if (!this.current(attempt)) {
      return;
    }
    this.tasks = tasks;
    const vision = await tasks.FilesetResolver.forVisionTasks(WASM_URL);
    if (!this.current(attempt)) {
      return;
    }
    const landmarker = await tasks.PoseLandmarker.createFromOptions(vision, {
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
  }

  private detectFrame = (attempt = this.attempt): void => {
    if (!this.current(attempt)) {
      return;
    }
    this.rafId = null;
    const { video } = this;
    const { landmarker } = this;

    if (video.readyState !== 4 || !landmarker) {
      this.rafId = requestAnimationFrame(() => this.detectFrame(attempt));
      return;
    }

    if (video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = video.currentTime;
      // MediaPipe requires strictly increasing timestamps
      const now = performance.now();
      const timestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1;
      this.lastTimestamp = timestamp;

      try {
        const result = landmarker.detectForVideo(video, timestamp);
        const landmarks = result.landmarks[0];
        if (landmarks) {
          this.drawSkeleton(landmarks);
          const keypoints = landmarksToKeypoints(landmarks, video.videoWidth, video.videoHeight);
          this.onPose(
            { height: video.videoHeight, keypoints, width: video.videoWidth },
            this.canvas.getContext("2d"),
          );
        }
      } catch (error) {
        if (this.current(attempt)) {
          console.error("Error detecting pose:", error);
        }
        this.fail(attempt);
        return;
      }
    }

    if (this.current(attempt)) {
      this.rafId = requestAnimationFrame(() => this.detectFrame(attempt));
    }
  };

  private drawSkeleton(landmarks: NormalizedLandmark[]): void {
    const ctx = this.canvas.getContext("2d");
    const { tasks } = this;
    if (!ctx || !tasks) {
      return;
    }

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const drawingUtils = this.drawingUtils ?? new tasks.DrawingUtils(ctx);
    this.drawingUtils = drawingUtils;
    drawingUtils.drawLandmarks(landmarks, {
      color: "red",
      fillColor: "red",
      radius: 3,
    });
    drawingUtils.drawConnectors(landmarks, tasks.PoseLandmarker.POSE_CONNECTIONS, {
      color: "blue",
      lineWidth: 2,
    });
  }

  private updateToggle(): void {
    const expanded = this.panel.classList.contains("expanded");
    const action =
      this.state === "unavailable"
        ? "Retry body camera"
        : this.state === "idle"
          ? "Enable body controls"
          : expanded
            ? "Collapse body camera"
            : "Expand body camera";
    this.toggle.setAttribute("aria-label", action);
    this.toggle.setAttribute("aria-expanded", String(expanded));
  }

  private setStatus(message: string | null): void {
    if (message === null) {
      this.status.style.display = "none";
    } else {
      this.status.style.display = "block";
      this.status.textContent = message;
    }
  }
}
