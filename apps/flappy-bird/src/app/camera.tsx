"use client";

import { memo, useEffect, useRef, useState } from "react";
import * as poseDetection from "@tensorflow-models/pose-detection";
import * as tf from "@tensorflow/tfjs";

// Import WASM backend for fallback
import "@tensorflow/tfjs-backend-cpu";
// Import WebGL backend for better performance
import "@tensorflow/tfjs-backend-webgl";

// Define app states as a type for better type safety
type AppState =
  | "idle"
  | "loading"
  | "ready"
  | "calibrating"
  | "detecting"
  | "jumping";

// Constants
const JUMP_THRESHOLD = 0.1; // 10% of baseline height
const SMOOTHING_WINDOW = 5; // Number of frames to average
const MAX_JUMP_HEIGHT_FACTOR = 2; // Maximum jump height multiplier

type CameraProps = {
  onJump?: (jumpStrength: number) => void; // Updated to include jump strength
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
  const detectorRef = useRef<poseDetection.PoseDetector | null>(null);

  // Track if we've been calibrated at least once
  const hasBeenCalibratedRef = useRef(false);

  // States - only keep UI-related states
  const [status, setStatus] = useState("Click 'Start' to begin");
  const [currentState, setCurrentState] = useState<AppState>("idle");

  // Update the state with a ref for animation frame access
  const setAppState = (newState: AppState) => {
    setCurrentState(newState); // Update UI state
    stateRef.current = newState; // Update ref for animation frames
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
        setStatus(
          `Calibrating... ${Math.min(100, Math.round((calibrationFrames / 30) * 100))}%`,
        );
      }

      // After 2 seconds, calculate average baseline
      if (calibrationFrames >= 30) {
        // ~30 frames in 2 seconds
        clearInterval(calibrationInterval);
        baselineYRef.current = totalY / calibrationFrames;
        hasBeenCalibratedRef.current = true;
        setAppState("detecting");
        setStatus("Calibrated! Jump now (or click 'Reset' to recalibrate)");
      }
    }, 66); // ~15 frames per second
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
        // Can't do anything while loading or calibrating
        break;
      default:
        setStatus("Unknown state, please refresh");
    }
  };

  // Initial setup effect - load camera and model
  useEffect(() => {
    // This effect should only run once to set up the camera and model
    if (stateRef.current !== "idle") return;

    setAppState("loading");
    setStatus("Starting camera and loading model...");

    const startCamera = async () => {
      try {
        // Start camera
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();

          // Wait for video to load
          videoRef.current.onloadedmetadata = async () => {
            if (canvasRef.current && videoRef.current) {
              canvasRef.current.width = videoRef.current.videoWidth;
              canvasRef.current.height = videoRef.current.videoHeight;
            }

            // Load model
            await loadModel();
          };
        }
      } catch (error) {
        setStatus(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        setAppState("idle");
      }
    };

    // Load TensorFlow model
    const loadModel = async () => {
      try {
        setStatus("Loading pose detection model...");

        // Initialize TensorFlow.js
        await tf.ready();

        // Set backend
        await tf.setBackend("webgl");

        setStatus(`Initializing detector with ${tf.getBackend()} backend...`);

        const detectorConfig = {
          modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        };

        const model = await poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet,
          detectorConfig,
        );

        detectorRef.current = model;
        setAppState("ready");
        setStatus("Ready for calibration. Stand still and click 'Calibrate'");

        // Start detection loop
        startDetection();
      } catch (error) {
        setStatus(
          `Error loading model: ${error instanceof Error ? error.message : String(error)}`,
        );
        setAppState("idle");
      }
    };

    // Start detection loop - uses the detector from the ref
    const startDetection = () => {
      const detectFrame = async () => {
        if (videoRef.current?.readyState !== 4 || !detectorRef.current) {
          rafIdRef.current = requestAnimationFrame(detectFrame);
          return;
        }

        try {
          const poses = await detectorRef.current.estimatePoses(
            videoRef.current,
          );

          // Process all detected poses
          if (poses.length > 0) {
            // Draw skeletons for all detected people
            poses.forEach((pose) => {
              drawSkeleton(pose, canvasRef);
            });

            // Find the most visible person (highest confidence score)
            const bestPose = findMostVisiblePerson(poses);

            // Get nose keypoint from the most visible person
            const nose = bestPose.keypoints.find((kp) => kp.name === "nose");
            if (nose && (nose.score ?? 0) > 0.3) {
              // Add to recent positions for smoothing
              yPositionsRef.current.unshift(nose.y);
              if (yPositionsRef.current.length > SMOOTHING_WINDOW) {
                yPositionsRef.current.pop();
              }

              // If calibrated, detect jumps
              if (
                stateRef.current === "detecting" ||
                stateRef.current === "jumping"
              ) {
                detectJump();
              }
            }
          }
        } catch (error) {
          setStatus(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Continue detection loop
        rafIdRef.current = requestAnimationFrame(detectFrame);
      };

      // Start the detection loop
      detectFrame();
    };

    void startCamera();

    return () => {
      // Cleanup
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      // Stop camera
      if (videoRef.current && videoRef.current.srcObject) {
        const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
        tracks.forEach((track) => track.stop());
      }
    };
  }, []); // Only run this effect once

  // Detect jump - using state from the ref
  const detectJump = () => {
    // If not calibrated, don't detect jumps
    if (!hasBeenCalibratedRef.current) {
      return;
    }

    const currentY = getSmoothedY(yPositionsRef.current);
    const heightDiff = baselineYRef.current - currentY;
    const jumpThreshold = baselineYRef.current * JUMP_THRESHOLD;

    // Person is currently in a jump
    if (heightDiff > jumpThreshold && stateRef.current === "detecting") {
      setAppState("jumping");
      setStatus("Jumping!");
      minYRef.current = currentY;

      // Calculate jump strength (0-1 range, capped at MAX_JUMP_HEIGHT_FACTOR)
      const jumpStrength = Math.min(
        heightDiff /
          (baselineYRef.current * JUMP_THRESHOLD * MAX_JUMP_HEIGHT_FACTOR),
        1,
      );

      // Call onJump with the calculated jump strength
      onJump?.(jumpStrength);
    }
    // Update minimum Y if still jumping and going higher
    else if (stateRef.current === "jumping" && currentY < minYRef.current) {
      minYRef.current = currentY;

      // Calculate updated jump strength as the person jumps higher
      const updatedHeightDiff = baselineYRef.current - currentY;
      const updatedJumpStrength = Math.min(
        updatedHeightDiff /
          (baselineYRef.current * JUMP_THRESHOLD * MAX_JUMP_HEIGHT_FACTOR),
        1,
      );

      // Call onJump with the updated jump strength
      onJump?.(updatedJumpStrength);
    }
    // Person has landed
    else if (
      stateRef.current === "jumping" &&
      Math.abs(currentY - baselineYRef.current) < jumpThreshold / 2
    ) {
      setAppState("detecting");
      setStatus(`Landed!`);
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
          disabled={
            currentState === "loading" || currentState === "calibrating"
          }
        >
          {getButtonText(currentState)}
        </button>
        <span>{status}</span>
      </div>
    </div>
  );
});

// Utility functions

// Draw skeleton on canvas
const drawSkeleton = (
  pose: poseDetection.Pose,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
) => {
  if (!canvasRef.current) return;

  const ctx = canvasRef.current.getContext("2d");
  if (!ctx) return;

  // Clear canvas
  ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

  // Draw keypoints
  pose.keypoints.forEach((keypoint) => {
    if ((keypoint.score ?? 0) > 0.5) {
      ctx.beginPath();
      ctx.arc(keypoint.x, keypoint.y, 5, 0, 2 * Math.PI);
      ctx.fillStyle = "red";
      ctx.fill();
    }
  });

  // Define connections for skeleton
  const connections = [
    ["nose", "left_eye"],
    ["nose", "right_eye"],
    ["left_eye", "left_ear"],
    ["right_eye", "right_ear"],
    ["nose", "left_shoulder"],
    ["nose", "right_shoulder"],
    ["left_shoulder", "left_elbow"],
    ["right_shoulder", "right_elbow"],
    ["left_elbow", "left_wrist"],
    ["right_elbow", "right_wrist"],
    ["left_shoulder", "right_shoulder"],
    ["left_shoulder", "left_hip"],
    ["right_shoulder", "right_hip"],
    ["left_hip", "right_hip"],
    ["left_hip", "left_knee"],
    ["right_hip", "right_knee"],
    ["left_knee", "left_ankle"],
    ["right_knee", "right_ankle"],
  ];

  // Draw connections
  ctx.strokeStyle = "blue";
  ctx.lineWidth = 2;

  connections.forEach(([p1Name, p2Name]) => {
    const p1 = pose.keypoints.find((kp) => kp.name === p1Name);
    const p2 = pose.keypoints.find((kp) => kp.name === p2Name);

    if (p1 && p2 && (p1.score ?? 0) > 0.5 && (p2.score ?? 0) > 0.5) {
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  });
};

// Get smoothed Y position from array of positions
const getSmoothedY = (positions: number[]) => {
  if (positions.length === 0) return 0;
  return positions.reduce((sum, val) => sum + val, 0) / positions.length;
};

// Get button text based on current state
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

// Find the most visible person (highest confidence score)
const findMostVisiblePerson = (poses: poseDetection.Pose[]) => {
  return poses.reduce((bestPose, currentPose) => {
    const bestScore = bestPose.keypoints.reduce(
      (sum, kp) => sum + (kp.score ?? 0),
      0,
    );
    const currentScore = currentPose.keypoints.reduce(
      (sum, kp) => sum + (kp.score ?? 0),
      0,
    );
    return currentScore > bestScore ? currentPose : bestPose;
  });
};
