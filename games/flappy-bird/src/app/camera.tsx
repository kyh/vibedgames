"use client";

import { memo, useEffect, useRef, useState } from "react";
import {
  DrawingUtils,
  FilesetResolver,
  PoseLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

// Define app states as a type for better type safety
type AppState = "idle" | "loading" | "ready" | "calibrating" | "detecting" | "jumping";

// Constants
const JUMP_THRESHOLD = 0.1; // 10% of baseline height
const SMOOTHING_WINDOW = 5; // Number of frames to average
const MAX_JUMP_HEIGHT_FACTOR = 2; // Maximum jump height multiplier

// MediaPipe Pose landmark index for nose
const NOSE_INDEX = 0;

type CameraProps = {
  onJump?: (jumpStrength: number) => void;
};

export const Camera = memo(function Camera({ onJump }: CameraProps) {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafIdRef = useRef<number | null>(null);
  const baselineYRef = useRef(0);
  const minYRef = useRef(Infinity);
  const yPositionsRef = useRef<number[]>([]);
  const stateRef = useRef<AppState>("idle");
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);

  // Track if we've been calibrated at least once
  const hasBeenCalibratedRef = useRef(false);

  // States - only keep UI-related states
  const [status, setStatus] = useState("Click 'Start' to begin");
  const [currentState, setCurrentState] = useState<AppState>("idle");

  // Update the state with a ref for animation frame access
  const setAppState = (newState: AppState) => {
    setCurrentState(newState);
    stateRef.current = newState;
  };

  // Start calibration
  const startCalibration = () => {
    setAppState("calibrating");
    setStatus("Calibrating... Stand still");

    // Reset values
    baselineYRef.current = 0;
    let calibrationFrames = 0;
    let totalY = 0;

    // Collect average position over 2 seconds
    const calibrationInterval = setInterval(() => {
      if (yPositionsRef.current.length > 0) {
        totalY += getSmoothedY(yPositionsRef.current);
        calibrationFrames++;
        setStatus(`Calibrating... ${Math.min(100, Math.round((calibrationFrames / 30) * 100))}%`);
      }

      // After 2 seconds, calculate average baseline
      if (calibrationFrames >= 30) {
        clearInterval(calibrationInterval);
        baselineYRef.current = totalY / calibrationFrames;
        hasBeenCalibratedRef.current = true;
        setAppState("detecting");
        setStatus("Calibrated! Jump now (or click 'Reset' to recalibrate)");
      }
    }, 66);
  };

  // Reset calibration
  const resetCalibration = () => {
    setAppState("ready");
    setStatus("Ready for calibration. Stand still and click 'Calibrate'");
    baselineYRef.current = 0;
    hasBeenCalibratedRef.current = false;
  };

  // Main action button handler
  const handleMainAction = () => {
    switch (stateRef.current) {
      case "ready":
        startCalibration();
        break;
      case "detecting":
      case "jumping":
        resetCalibration();
        break;
      case "calibrating":
      case "loading":
        break;
      default:
        setStatus("Unknown state, please refresh");
    }
  };

  // Initial setup effect - load camera and model
  useEffect(() => {
    if (stateRef.current !== "idle") return;

    setAppState("loading");
    setStatus("Starting camera and loading model...");

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();

          videoRef.current.onloadedmetadata = async () => {
            if (canvasRef.current && videoRef.current) {
              canvasRef.current.width = videoRef.current.videoWidth;
              canvasRef.current.height = videoRef.current.videoHeight;
            }

            await loadModel();
          };
        }
      } catch (error) {
        setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
        setAppState("idle");
      }
    };

    const loadModel = async () => {
      try {
        setStatus("Loading pose detection model...");

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
        setAppState("ready");
        setStatus("Ready for calibration. Stand still and click 'Calibrate'");

        startDetection();
      } catch (error) {
        setStatus(`Error loading model: ${error instanceof Error ? error.message : String(error)}`);
        setAppState("idle");
      }
    };

    const startDetection = () => {
      let lastVideoTime = -1;
      let lastTimestamp = 0;

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

                // Get nose landmark (index 0) — coordinates are normalized (0-1)
                const nose = landmarks[NOSE_INDEX];
                if (nose && nose.visibility > 0.3) {
                  // Convert normalized y to pixel y for consistency with calibration
                  const noseY = nose.y * (video.videoHeight || 1);

                  yPositionsRef.current.unshift(noseY);
                  if (yPositionsRef.current.length > SMOOTHING_WINDOW) {
                    yPositionsRef.current.pop();
                  }

                  if (stateRef.current === "detecting" || stateRef.current === "jumping") {
                    detectJump();
                  }
                }
              }
            }
          } catch (error) {
            setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        rafIdRef.current = requestAnimationFrame(detectFrame);
      };

      detectFrame();
    };

    void startCamera();

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (videoRef.current && videoRef.current.srcObject) {
        const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
        tracks.forEach((track) => track.stop());
      }
    };
  }, []);

  // Detect jump
  const detectJump = () => {
    if (!hasBeenCalibratedRef.current) return;

    const currentY = getSmoothedY(yPositionsRef.current);
    const heightDiff = baselineYRef.current - currentY;
    const jumpThreshold = baselineYRef.current * JUMP_THRESHOLD;

    if (heightDiff > jumpThreshold && stateRef.current === "detecting") {
      setAppState("jumping");
      setStatus("Jumping!");
      minYRef.current = currentY;

      const jumpStrength = Math.min(
        heightDiff / (baselineYRef.current * JUMP_THRESHOLD * MAX_JUMP_HEIGHT_FACTOR),
        1,
      );
      onJump?.(jumpStrength);
    } else if (stateRef.current === "jumping" && currentY < minYRef.current) {
      minYRef.current = currentY;

      const updatedHeightDiff = baselineYRef.current - currentY;
      const updatedJumpStrength = Math.min(
        updatedHeightDiff / (baselineYRef.current * JUMP_THRESHOLD * MAX_JUMP_HEIGHT_FACTOR),
        1,
      );
      onJump?.(updatedJumpStrength);
    } else if (
      stateRef.current === "jumping" &&
      Math.abs(currentY - baselineYRef.current) < jumpThreshold / 2
    ) {
      setAppState("detecting");
      setStatus("Landed!");
    }
  };

  return (
    <div className="absolute right-1 bottom-1 aspect-video h-[288px] w-sm rounded-lg bg-black/10">
      <video ref={videoRef} className="rounded-lg" playsInline />
      <canvas ref={canvasRef} className="absolute top-0 left-0 h-full w-full" />
      <div className="absolute bottom-2 left-2 flex items-center gap-2 text-xs">
        <button
          className="rounded-md bg-white px-2 py-1 text-xs"
          onClick={handleMainAction}
          disabled={currentState === "loading" || currentState === "calibrating"}
        >
          {getButtonText(currentState)}
        </button>
        <span>{status}</span>
      </div>
    </div>
  );
});

// Draw skeleton on canvas using MediaPipe DrawingUtils
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

const getSmoothedY = (positions: number[]) => {
  if (positions.length === 0) return 0;
  return positions.reduce((sum, val) => sum + val, 0) / positions.length;
};

const getButtonText = (state: AppState) => {
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
    default:
      return "Start";
  }
};
