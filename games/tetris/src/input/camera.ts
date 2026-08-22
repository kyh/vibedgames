import type { NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";

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
export type Keypoint = {
  name: string;
  x: number;
  y: number;
  score: number;
};

export type Pose = {
  keypoints: Keypoint[];
  /** Source video frame dimensions (px) — keypoints are in this space, so
   *  pose interpretation normalises against these (no frozen-refW drift). */
  width: number;
  height: number;
};

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
      if (!name) return null;
      return { name, x: lm.x * width, y: lm.y * height, score: lm.visibility };
    })
    .filter((kp): kp is Keypoint => kp !== null);
}

export class PoseCamera {
  private readonly onPose: PoseHandler;
  private readonly panel: HTMLDivElement;
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly status: HTMLDivElement;
  private landmarker: PoseLandmarker | null = null;
  private tasks: VisionTasks | null = null;
  private rafId: number | null = null;
  private destroyed = false;
  private started = false;
  private lastVideoTime = -1;
  private lastTimestamp = 0;

  constructor(onPose: PoseHandler) {
    this.onPose = onPose;
    const deferred = isCoarsePointer();

    // Never stack a second panel if the game is re-initialised.
    document.getElementById("camera-panel")?.remove();

    this.panel = document.createElement("div");
    this.panel.id = "camera-panel";
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.canvas = document.createElement("canvas");
    this.status = document.createElement("div");
    this.status.id = "camera-status";
    this.status.textContent = deferred ? "tap to play with the camera" : "starting camera…";
    this.panel.append(this.video, this.canvas, this.status);
    // Small screens shrink the panel (CSS); tapping toggles the expanded size.
    // The attribute keeps the virtual gamepad from claiming taps on the panel.
    this.panel.setAttribute("data-gamepad-ignore", "");
    this.panel.addEventListener("click", () => {
      this.panel.classList.toggle("expanded");
      if (deferred) void this.start();
    });
    document.body.appendChild(this.panel);
  }

  /** Request the camera, then load the model. Idempotent: the panel tap that
   *  opts a phone in also toggles the expanded size, and may fire again later. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      if (this.destroyed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.video.srcObject = stream;
      await this.video.play();
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;

      await this.loadModel();
      if (this.destroyed) return;

      this.setStatus(null);
      this.detectFrame();
    } catch (error) {
      // Denied/unavailable camera or model load failure: keyboard keeps
      // working, the panel just reports why the webcam path is inactive.
      // Stop any acquired stream so the webcam LED matches the status text.
      this.started = false; // another tap on the panel retries
      if (this.video.srcObject instanceof MediaStream) {
        this.video.srcObject.getTracks().forEach((track) => track.stop());
        this.video.srcObject = null;
      }
      console.error("Error starting camera or loading model:", error);
      this.setStatus(
        isCoarsePointer()
          ? "camera unavailable — touch controls active"
          : "camera unavailable — keyboard controls active",
      );
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    const src = this.video.srcObject;
    if (src instanceof MediaStream) {
      src.getTracks().forEach((track) => track.stop());
    }
    this.landmarker?.close();
    this.landmarker = null;
    this.panel.remove();
  }

  private async loadModel(): Promise<void> {
    const tasks = await import("@mediapipe/tasks-vision");
    this.tasks = tasks;
    const vision = await tasks.FilesetResolver.forVisionTasks(WASM_URL);
    this.landmarker = await tasks.PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  }

  private detectFrame = (): void => {
    if (this.destroyed) return;
    const video = this.video;
    const landmarker = this.landmarker;

    if (video.readyState !== 4 || !landmarker) {
      this.rafId = requestAnimationFrame(this.detectFrame);
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
            { keypoints, width: video.videoWidth, height: video.videoHeight },
            this.canvas.getContext("2d"),
          );
        }
      } catch (error) {
        console.error("Error detecting pose:", error);
      }
    }

    this.rafId = requestAnimationFrame(this.detectFrame);
  };

  private drawSkeleton(landmarks: NormalizedLandmark[]): void {
    const ctx = this.canvas.getContext("2d");
    const tasks = this.tasks;
    if (!ctx || !tasks) return;

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const drawingUtils = new tasks.DrawingUtils(ctx);
    drawingUtils.drawLandmarks(landmarks, {
      radius: 3,
      color: "red",
      fillColor: "red",
    });
    drawingUtils.drawConnectors(landmarks, tasks.PoseLandmarker.POSE_CONNECTIONS, {
      color: "blue",
      lineWidth: 2,
    });
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
