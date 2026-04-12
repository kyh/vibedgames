"use client";

import { memo, useEffect, useRef } from "react";
import {
  DrawingUtils,
  FilesetResolver,
  PoseLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

/**
 * Keypoint with pixel coordinates, matching the interface previously provided
 * by @tensorflow-models/pose-detection so app.tsx can stay unchanged.
 */
export type Keypoint = {
  name: string;
  x: number;
  y: number;
  score: number;
};

export type Pose = {
  keypoints: Keypoint[];
};

/** MediaPipe Pose landmark indices → human-readable names (MoveNet-compatible) */
const LANDMARK_NAMES: Record<number, string> = {
  0: "nose",
  1: "left_eye_inner",
  2: "left_eye",
  3: "left_eye_outer",
  4: "right_eye_inner",
  5: "right_eye",
  6: "right_eye_outer",
  7: "left_ear",
  8: "right_ear",
  9: "mouth_left",
  10: "mouth_right",
  11: "left_shoulder",
  12: "right_shoulder",
  13: "left_elbow",
  14: "right_elbow",
  15: "left_wrist",
  16: "right_wrist",
  23: "left_hip",
  24: "right_hip",
  25: "left_knee",
  26: "right_knee",
  27: "left_ankle",
  28: "right_ankle",
};

/** Convert MediaPipe normalized landmarks to pixel-coordinate keypoints. */
function landmarksToKeypoints(
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
): Keypoint[] {
  return landmarks
    .map((lm, i) => {
      const name = LANDMARK_NAMES[i];
      if (!name) return null;
      return { name, x: lm.x * width, y: lm.y * height, score: lm.visibility };
    })
    .filter((kp): kp is Keypoint => kp !== null);
}

export const Camera = memo(function Camera({
  onPoseDetected,
}: {
  onPoseDetected?: (
    pose: Pose,
    canvasRef: React.RefObject<HTMLCanvasElement | null>,
  ) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);

  useEffect(() => {
    const startCameraAndModel = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();

          if (canvasRef.current && videoRef.current) {
            canvasRef.current.width = videoRef.current.videoWidth;
            canvasRef.current.height = videoRef.current.videoHeight;
          }

          await loadModel();
        }
      } catch (error) {
        console.error("Error starting camera or loading model:", error);
      }
    };

    const loadModel = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm",
        );

        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
        });

        poseLandmarkerRef.current = poseLandmarker;
        startDetectionLoop();
      } catch (error) {
        console.error("Error loading pose detection model:", error);
      }
    };

    let lastVideoTime = -1;
    let lastTimestamp = 0;
    const startDetectionLoop = () => {
      const detectFrame = () => {
        const video = videoRef.current;
        const landmarker = poseLandmarkerRef.current;

        if (!video || video.readyState !== 4 || !landmarker) {
          rafIdRef.current = requestAnimationFrame(detectFrame);
          return;
        }

        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          // MediaPipe requires strictly increasing timestamps
          const now = performance.now();
          const timestamp = now > lastTimestamp ? now : lastTimestamp + 1;
          lastTimestamp = timestamp;

          try {
            const result = landmarker.detectForVideo(video, timestamp);

            if (result.landmarks.length > 0) {
              const landmarks = result.landmarks[0];
              if (landmarks) {
                drawSkeleton(landmarks, canvasRef);

                const keypoints = landmarksToKeypoints(
                  landmarks,
                  video.videoWidth,
                  video.videoHeight,
                );
                onPoseDetected?.({ keypoints }, canvasRef);
              }
            }
          } catch (error) {
            console.error("Error detecting pose:", error);
          }
        }

        rafIdRef.current = requestAnimationFrame(detectFrame);
      };

      detectFrame();
    };

    startCameraAndModel();

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }

      if (videoRef.current && videoRef.current.srcObject) {
        const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
        tracks.forEach((track) => track.stop());
      }
    };
  }, [onPoseDetected]);

  return (
    <div className="absolute right-1 bottom-1 aspect-video h-[288px] w-sm rounded-lg bg-black/10">
      <video ref={videoRef} className="rounded-lg" playsInline />
      <canvas ref={canvasRef} className="absolute top-0 left-0 h-full w-full" />
    </div>
  );
});

const drawSkeleton = (
  landmarks: NormalizedLandmark[],
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
) => {
  if (!canvasRef.current) return;
  const ctx = canvasRef.current.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

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
};
