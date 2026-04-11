"use client";

import { memo, useEffect, useRef } from "react";
import { DrawingUtils, FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";

export const Camera = memo(function Camera({
  onPositionChange,
}: {
  onPositionChange: (position: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gestureRecognizerRef = useRef<GestureRecognizer | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const videoPlaying = useRef(false);

  useEffect(() => {
    const createGestureRecognizer = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm",
        );
        const recognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 1, // Only detect one hand for the paddle
        });
        gestureRecognizerRef.current = recognizer;
        startWebcam();
      } catch (error) {
        console.error("Error creating GestureRecognizer:", error);
      }
    };

    const startWebcam = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.addEventListener("loadeddata", () => {
            if (videoRef.current) {
              videoPlaying.current = true;
              videoRef.current.play();

              if (canvasRef.current) {
                canvasRef.current.width = videoRef.current.videoWidth;
                canvasRef.current.height = videoRef.current.videoHeight;
              }
              predictWebcam();
            }
          });
        }
      } catch (error) {
        console.error("Error starting webcam:", error);
      }
    };

    let lastVideoTime = -1;
    const predictWebcam = () => {
      const video = videoRef.current;
      const recognizer = gestureRecognizerRef.current;

      if (!video || !videoPlaying.current || !recognizer) {
        rafIdRef.current = requestAnimationFrame(predictWebcam);
        return;
      }

      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const results = recognizer.recognizeForVideo(video, Date.now());

        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");

        if (ctx && canvas) {
          ctx.save();
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const drawingUtils = new DrawingUtils(ctx);

          if (results.landmarks.length > 0) {
            const handLandmarks = results.landmarks[0];
            if (handLandmarks) {
              for (const landmarks of results.landmarks) {
                drawingUtils.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, {
                  color: "#00FF00",
                  lineWidth: 5,
                });
                drawingUtils.drawLandmarks(landmarks, {
                  color: "#FF0000",
                  lineWidth: 2,
                });
              }

              const wrist = handLandmarks[0];
              if (wrist) {
                onPositionChange(wrist.x);
              }
            }
          }
          ctx.restore();
        }
      }

      rafIdRef.current = requestAnimationFrame(predictWebcam);
    };

    createGestureRecognizer();

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [onPositionChange]);

  return (
    <div className="absolute right-1 bottom-1 aspect-video h-[288px] w-sm rounded-lg bg-black/10">
      <video ref={videoRef} className="rounded-lg" playsInline muted autoPlay />
      <canvas ref={canvasRef} className="absolute top-0 left-0 h-full w-full" />
    </div>
  );
});
