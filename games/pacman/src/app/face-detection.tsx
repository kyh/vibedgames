"use client";

import { memo, useEffect, useRef, useState } from "react";
import { DrawingUtils, FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const THRESHOLD = 0.07; // Default threshold value
const HEAD_TURN_THRESHOLD = 0.3; // Increased threshold for detecting head turns
const HEAD_CENTER_THRESHOLD = 0.15; // Smaller threshold for detecting centered head

type FaceDetectionProps = {
  onMouthChange?: (open: boolean) => void;
  onHeadTurnLeft?: () => void;
  onHeadTurnRight?: () => void;
  onHeadCenter?: () => void;
};

export const FaceDetection = memo(function FaceDetection({
  onMouthChange,
  onHeadTurnLeft,
  onHeadTurnRight,
  onHeadCenter,
}: FaceDetectionProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);
  const resultsRef = useRef<any>(undefined);
  const drawingUtilsRef = useRef<DrawingUtils | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [headPosition, setHeadPosition] = useState<"center" | "left" | "right">("center");
  const lastHeadChangeRef = useRef<number>(0);
  const headChangeDebounceMs = 1000; // Debounce time in milliseconds

  // Combined useEffect for setup and cleanup
  useEffect(() => {
    async function initialize() {
      // Setup canvas context
      if (canvasRef.current) {
        const canvasCtx = canvasRef.current.getContext("2d");
        if (canvasCtx) {
          drawingUtilsRef.current = new DrawingUtils(canvasCtx);
        }
      }

      // Initialize face landmarker
      const filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm",
      );

      const landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: `/face_landmarker.task`,
          delegate: "GPU",
        },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      });

      faceLandmarkerRef.current = landmarker;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play();

        videoRef.current.onloadeddata = () => {
          if (canvasRef.current && videoRef.current) {
            canvasRef.current.width = videoRef.current.videoWidth;
            canvasRef.current.height = videoRef.current.videoHeight;
          }

          predictWebcam();
        };
      }
    }

    initialize().catch(console.error);

    // Clean up on unmount
    return () => {
      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }

      // Close video stream if active
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Helper function to detect if mouth is open
  const detectMouthOpen = (landmarks: any) => {
    if (!landmarks) return false;

    // Get the upper and lower lip points
    // Landmark indices based on MediaPipe face landmarks
    // Upper lip top point: 13
    // Lower lip bottom point: 14
    // Face vertical reference: 10 (nose) and 152 (chin)
    const upperLip = landmarks[13];
    const lowerLip = landmarks[14];
    const nose = landmarks[10];
    const chin = landmarks[152];

    if (!upperLip || !lowerLip || !nose || !chin) return false;
    // Calculate mouth opening as a ratio relative to face height
    const mouthOpenDistance = Math.abs(upperLip.y - lowerLip.y);
    const faceHeight = Math.abs(nose.y - chin.y);

    const mouthOpenRatio = mouthOpenDistance / faceHeight;

    return mouthOpenRatio > THRESHOLD;
  };

  // Helper function to detect head turning left or right
  const detectHeadTurn = (landmarks: any) => {
    if (!landmarks) return "center";

    // Get points on left and right side of face
    const leftCheek = landmarks[234]; // Left cheek point
    const rightCheek = landmarks[454]; // Right cheek point
    const noseTip = landmarks[4]; // Nose tip

    if (!leftCheek || !rightCheek || !noseTip) return "center";

    // Calculate horizontal distances from nose to cheeks
    const leftDistance = Math.abs(noseTip.x - leftCheek.x);
    const rightDistance = Math.abs(noseTip.x - rightCheek.x);

    // Calculate the asymmetry ratio
    const asymmetryRatio = (leftDistance - rightDistance) / (leftDistance + rightDistance);

    // Determine head position based on asymmetry
    if (asymmetryRatio > HEAD_TURN_THRESHOLD) {
      return "left"; // Head turned to the left (flipped from right to left)
    } else if (asymmetryRatio < -HEAD_TURN_THRESHOLD) {
      return "right"; // Head turned to the right (flipped from left to right)
    } else if (asymmetryRatio < HEAD_CENTER_THRESHOLD && asymmetryRatio > -HEAD_CENTER_THRESHOLD) {
      return "center"; // Head centered - using a narrower threshold
    }

    // If we're between thresholds, maintain current position to reduce oscillation
    return headPosition;
  };

  const predictWebcam = async () => {
    if (
      !videoRef.current ||
      !canvasRef.current ||
      !faceLandmarkerRef.current ||
      !drawingUtilsRef.current
    ) {
      return;
    }

    const video = videoRef.current;
    const canvasElement = canvasRef.current;
    const canvasCtx = canvasElement.getContext("2d");
    const startTimeMs = performance.now();

    if (!canvasCtx) {
      return;
    }

    if (lastVideoTimeRef.current !== video.currentTime) {
      lastVideoTimeRef.current = video.currentTime;
      resultsRef.current = faceLandmarkerRef.current.detectForVideo(video, startTimeMs);
    }

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    if (resultsRef.current?.faceLandmarks) {
      for (const landmarks of resultsRef.current.faceLandmarks) {
        drawingUtilsRef.current.drawConnectors(
          landmarks,
          FaceLandmarker.FACE_LANDMARKS_TESSELATION,
          { color: "#C0C0C070", lineWidth: 1 },
        );
        drawingUtilsRef.current.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, {
          color: "#30FF30",
        });
        drawingUtilsRef.current.drawConnectors(
          landmarks,
          FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
          { color: "#30FF30" },
        );
        drawingUtilsRef.current.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, {
          color: "#30FF30",
        });
        drawingUtilsRef.current.drawConnectors(
          landmarks,
          FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
          { color: "#30FF30" },
        );
        drawingUtilsRef.current.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, {
          color: "#E0E0E0",
        });
        drawingUtilsRef.current.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LIPS, {
          color: "#E0E0E0",
        });
        drawingUtilsRef.current.drawConnectors(
          landmarks,
          FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS,
          { color: "#30FF30" },
        );
        drawingUtilsRef.current.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, {
          color: "#30FF30",
        });

        // Check if mouth is open
        const mouthOpen = detectMouthOpen(landmarks);
        onMouthChange?.(mouthOpen);

        // Detect head turn direction
        const newHeadPosition = detectHeadTurn(landmarks);
        const currentTime = performance.now();

        // Only call callbacks when head position changes and after debounce period
        if (
          newHeadPosition !== headPosition &&
          currentTime - lastHeadChangeRef.current > headChangeDebounceMs
        ) {
          setHeadPosition(newHeadPosition);
          lastHeadChangeRef.current = currentTime;

          // Trigger appropriate callback based on head position
          if (newHeadPosition === "left") {
            onHeadTurnLeft?.();
          } else if (newHeadPosition === "right") {
            onHeadTurnRight?.();
          } else if (newHeadPosition === "center") {
            onHeadCenter?.();
          }
        }
      }
    }

    canvasCtx.restore();

    animationFrameRef.current = window.requestAnimationFrame(predictWebcam);
  };

  return (
    <div className="absolute right-1 bottom-1 z-1 aspect-video h-[144px] w-[192px] rounded-lg bg-black/10 md:h-[288px] md:w-[384px]">
      <video ref={videoRef} className="rounded-lg" playsInline />
      <canvas ref={canvasRef} className="absolute top-0 left-0 h-full w-full" />
    </div>
  );
});
