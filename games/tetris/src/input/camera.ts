import type { DrawingUtils, NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";
import type * as VisionTasks from "@mediapipe/tasks-vision";

import { isCoarsePointer } from "./touch";

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

const landmarksToKeypoints = (landmarks: NormalizedLandmark[], width: number, height: number) =>
  landmarks.flatMap((lm, i) => {
    const name = LANDMARK_NAMES.get(i);

    if (!name) {
      return [];
    }

    return [{ name, score: lm.visibility, x: lm.x * width, y: lm.y * height }];
  });

type CameraState = "idle" | "starting" | "live" | "unavailable";

export class PoseCamera {
  private readonly onPose: PoseHandler;
  private readonly panel: HTMLDivElement;
  private readonly toggle: HTMLButtonElement;
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly status: HTMLDivElement;
  private landmarker: PoseLandmarker | null = null;
  private drawingUtils: DrawingUtils | null = null;
  private tasks: typeof VisionTasks | null = null;
  private stream: MediaStream | null = null;
  private releaseMediaEvents: (() => void) | null = null;
  private rafId: number | null = null;
  private state: CameraState = "idle";
  private attempt = 0;
  private lastVideoTime = -1;
  private lastTimestamp = 0;

  constructor(onPose: PoseHandler) {
    this.onPose = onPose;
    const deferred = isCoarsePointer();

    document.querySelector("#camera-panel")?.remove();

    this.panel = document.createElement("div");
    this.panel.id = "camera-panel";
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.canvas = document.createElement("canvas");
    this.status = document.createElement("div");
    this.status.id = "camera-status";
    this.status.textContent = deferred ? "play with the camera" : "starting camera…";
    this.toggle = document.createElement("button");
    this.toggle.id = "camera-toggle";
    this.toggle.className = "camera-toggle";
    this.toggle.type = "button";
    this.panel.append(this.video, this.canvas, this.status, this.toggle);
    this.panel.dataset.gamepadIgnore = "";
    this.panel.dataset.state = this.state;
    this.toggle.addEventListener("click", (event) => {
      this.panel.classList.toggle("expanded");

      if (this.state === "idle" || this.state === "unavailable") {
        void this.start();
      }

      this.updateToggle();

      if (event.detail > 0) {
        this.toggle.blur();
      }
    });
    this.updateToggle();
    document.body.append(this.panel);
  }

  /** Request the camera, play the video, then load the model. Retries after a
   *  failure (denied camera, unplugged device, model error) via the panel button. */
  async start() {
    if (this.state !== "idle" && this.state !== "unavailable") {
      return;
    }

    this.attempt += 1;
    const { attempt } = this;
    this.setState("starting");
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
      const onEnded = () => this.fail(attempt);

      const onVideoError = () => {
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

      this.setState("live");
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

  private current(attempt: number) {
    return this.attempt === attempt;
  }

  private fail(attempt: number) {
    if (!this.current(attempt)) {
      return;
    }

    this.attempt += 1;
    this.releaseCapture();
    this.setState("unavailable");
    this.setStatus("camera unavailable · retry");
    this.updateToggle();
  }

  private releaseCapture() {
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

  private async loadModel(attempt: number) {
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

  private detectFrame = (attempt = this.attempt) => {
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
      const now = performance.now();
      const timestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1;
      this.lastTimestamp = timestamp;

      try {
        const result = landmarker.detectForVideo(video, timestamp);
        const [landmarks] = result.landmarks;

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

  private drawSkeleton(landmarks: NormalizedLandmark[]) {
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

  private toggleAction(expanded: boolean) {
    if (this.state === "unavailable") {
      return "Retry body camera";
    }

    if (this.state === "idle") {
      return "Enable body controls";
    }

    return expanded ? "Collapse body camera" : "Expand body camera";
  }

  private setState(next: CameraState) {
    this.state = next;
    this.panel.dataset.state = next;
  }

  private updateToggle() {
    const expanded = this.panel.classList.contains("expanded");
    const action = this.toggleAction(expanded);
    this.toggle.setAttribute("aria-label", action);
    this.toggle.setAttribute("aria-expanded", String(expanded));
  }

  private setStatus(message: string | null) {
    if (message === null) {
      this.status.style.display = "none";
    } else {
      this.status.style.display = "block";
      this.status.textContent = message;
    }
  }
}
