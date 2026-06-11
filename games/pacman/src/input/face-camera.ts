// Webcam face-gesture input, ported 1:1 from the legacy face-detection.tsx:
// MediaPipe FaceLandmarker drives the game — mouth open/close transitions step
// Pacman forward, head turns steer. Also draws the face-mesh landmark overlay
// onto the preview canvas, with the legacy colors.
//
// The camera auto-starts on page load (legacy initialized on mount, no start
// button). On failure (denied/no camera/CDN offline) it degrades to a status
// message — keyboard input keeps working.

import type { FaceLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { DrawingUtils, FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

import { HEAD_DEBOUNCE_MS, HEAD_TURN_THRESHOLD, MOUTH_OPEN_RATIO } from "../shared/constants";

/** Verbatim legacy CDN URL (the 0.10.35 JS lib shipped against these binaries). */
const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
/** Local model file (3.8MB), same as legacy `/face_landmarker.task`. */
const MODEL_PATH = "face_landmarker.task";

// Legacy landmark indices:
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const FACE_TOP = 10; // "nose" reference for face height
const CHIN = 152;
const NOSE_TIP = 4;
const LEFT_CHEEK = 234;
const RIGHT_CHEEK = 454;

type HeadPosition = "center" | "left" | "right";

export type FaceCameraOptions = {
  video: HTMLVideoElement;
  overlay: HTMLCanvasElement;
  status: HTMLElement;
  /** Raw mouth-open boolean, reported every detection frame (legacy contract). */
  onMouthChange?: (open: boolean) => void;
  onHeadTurnLeft?: () => void;
  onHeadTurnRight?: () => void;
};

export class FaceCamera {
  private readonly opts: FaceCameraOptions;
  private landmarker: FaceLandmarker | null = null;
  private drawingUtils: DrawingUtils | null = null;
  private result: FaceLandmarkerResult | null = null;
  private lastVideoTime = -1;
  private lastHeadChange = 0;
  private frameHandle: number | null = null;

  constructor(opts: FaceCameraOptions) {
    this.opts = opts;
  }

  /** Initialize landmarker + webcam; never throws — failures show in the panel. */
  async start(): Promise<void> {
    this.setStatus("starting camera…");
    try {
      const ctx = this.opts.overlay.getContext("2d");
      if (!ctx) throw new Error("no 2d context for overlay canvas");
      this.drawingUtils = new DrawingUtils(ctx);

      const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: MODEL_PATH,
          delegate: "GPU",
        },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });

      const video = this.opts.video;
      video.srcObject = stream;
      video.onloadeddata = () => {
        this.opts.overlay.width = video.videoWidth;
        this.opts.overlay.height = video.videoHeight;
        this.setStatus(null);
        this.predict();
      };
      void video.play();
    } catch (err) {
      console.error("face camera unavailable:", err);
      this.setStatus("camera unavailable — keyboard: ←/→ turn · SPACE step");
    }
  }

  stop(): void {
    if (this.frameHandle !== null) window.cancelAnimationFrame(this.frameHandle);
    const stream = this.opts.video.srcObject;
    if (stream instanceof MediaStream) {
      for (const track of stream.getTracks()) track.stop();
    }
    this.landmarker?.close();
  }

  private setStatus(text: string | null): void {
    this.opts.status.textContent = text ?? "";
    this.opts.status.style.display = text === null ? "none" : "";
  }

  // ---- per-frame detection (legacy predictWebcam) ----------------------------

  private predict = (): void => {
    const video = this.opts.video;
    const canvas = this.opts.overlay;
    const ctx = canvas.getContext("2d");
    if (!ctx || !this.landmarker || !this.drawingUtils) return;

    if (this.lastVideoTime !== video.currentTime) {
      this.lastVideoTime = video.currentTime;
      this.result = this.landmarker.detectForVideo(video, performance.now());
    }

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (this.result) {
      for (const landmarks of this.result.faceLandmarks) {
        this.drawMesh(landmarks);

        this.opts.onMouthChange?.(detectMouthOpen(landmarks));

        // Legacy-as-shipped behavior: the legacy RAF loop recursed on its
        // render-1 closure, so `headPosition` was permanently the stale
        // "center". Effectively: holding a turn re-fires every
        // HEAD_DEBOUNCE_MS, and recentering fires nothing (and consumes no
        // debounce slot).
        const next = this.detectHeadTurn(landmarks);
        const now = performance.now();
        if (next !== "center" && now - this.lastHeadChange > HEAD_DEBOUNCE_MS) {
          this.lastHeadChange = now;
          if (next === "left") this.opts.onHeadTurnLeft?.();
          else this.opts.onHeadTurnRight?.();
        }
      }
    }

    ctx.restore();
    this.frameHandle = window.requestAnimationFrame(this.predict);
  };

  /** Face-mesh overlay — legacy colors/order verbatim. */
  private drawMesh(landmarks: NormalizedLandmark[]): void {
    const du = this.drawingUtils;
    if (!du) return;
    du.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION, {
      color: "#C0C0C070",
      lineWidth: 1,
    });
    du.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, { color: "#30FF30" });
    du.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, {
      color: "#30FF30",
    });
    du.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, { color: "#30FF30" });
    du.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, { color: "#30FF30" });
    du.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, { color: "#E0E0E0" });
    du.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LIPS, { color: "#E0E0E0" });
    du.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, { color: "#30FF30" });
    du.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, { color: "#30FF30" });
  }

  /**
   * Head turn from nose-to-cheek asymmetry (legacy detectHeadTurn):
   * ratio > 0.3 = left, < -0.3 = right, everything else = center. The legacy
   * source had a hysteresis band (0.15–0.3) that "held the current state", but
   * its stale closure meant the held state was always "center" — so as shipped
   * the band resolved to "center", and we reproduce that.
   */
  private detectHeadTurn(landmarks: NormalizedLandmark[]): HeadPosition {
    const leftCheek = landmarks[LEFT_CHEEK];
    const rightCheek = landmarks[RIGHT_CHEEK];
    const noseTip = landmarks[NOSE_TIP];
    if (!leftCheek || !rightCheek || !noseTip) return "center";

    const leftDistance = Math.abs(noseTip.x - leftCheek.x);
    const rightDistance = Math.abs(noseTip.x - rightCheek.x);
    const asymmetryRatio = (leftDistance - rightDistance) / (leftDistance + rightDistance);

    if (asymmetryRatio > HEAD_TURN_THRESHOLD) return "left";
    if (asymmetryRatio < -HEAD_TURN_THRESHOLD) return "right";
    return "center";
  }
}

/**
 * Mouth-open check (legacy detectMouthOpen): lip gap relative to face height
 * (landmarks 13/14 lips, 10/152 vertical reference) above 0.07 = open.
 */
function detectMouthOpen(landmarks: NormalizedLandmark[]): boolean {
  const upperLip = landmarks[UPPER_LIP];
  const lowerLip = landmarks[LOWER_LIP];
  const nose = landmarks[FACE_TOP];
  const chin = landmarks[CHIN];
  if (!upperLip || !lowerLip || !nose || !chin) return false;

  const mouthOpenDistance = Math.abs(upperLip.y - lowerLip.y);
  const faceHeight = Math.abs(nose.y - chin.y);
  return mouthOpenDistance / faceHeight > MOUTH_OPEN_RATIO;
}
