"use client";

import { memo, useEffect, useRef } from "react";
import * as poseDetection from "@tensorflow-models/pose-detection";
import * as tf from "@tensorflow/tfjs";

// Import WASM backend for fallback
import "@tensorflow/tfjs-backend-cpu";
// Import WebGL backend for better performance
import "@tensorflow/tfjs-backend-webgl";

export const Camera = memo(function Camera({
  onPoseDetected,
}: {
  onPoseDetected?: (
    pose: poseDetection.Pose,
    canvasRef: React.RefObject<HTMLCanvasElement | null>,
  ) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const detectorRef = useRef<poseDetection.PoseDetector | null>(null);

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
        await tf.ready();
        await tf.setBackend("webgl");

        const detectorConfig = {
          modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        };

        const model = await poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet,
          detectorConfig,
        );

        detectorRef.current = model;
        startDetectionLoop();
      } catch (error) {
        console.error("Error loading pose detection model:", error);
      }
    };

    const startDetectionLoop = () => {
      const detectFrame = async () => {
        if (!videoRef.current || videoRef.current.readyState !== 4 || !detectorRef.current) {
          rafIdRef.current = requestAnimationFrame(detectFrame);
          return;
        }

        try {
          const poses = await detectorRef.current.estimatePoses(videoRef.current);

          if (poses.length > 0 && poses[0]) {
            drawSkeleton(poses[0], canvasRef);
            onPoseDetected?.(poses[0], canvasRef);
          }
        } catch (error) {
          console.error("Error detecting pose:", error);
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
  pose: poseDetection.Pose,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
) => {
  if (!canvasRef.current) return;

  const ctx = canvasRef.current.getContext("2d");
  if (!ctx) return;

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

  // Draw connections
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
