"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type * as poseDetection from "@tensorflow-models/pose-detection";
import { Camera } from "./camera";

const blockSize = 30;
const shapes = [
  [[1, 1, 1, 1]], // I
  [
    [1, 1],
    [1, 1],
  ], // O
  [
    [0, 1, 0],
    [1, 1, 1],
  ], // T
  [
    [1, 1, 0],
    [0, 1, 1],
  ], // S
  [
    [0, 1, 1],
    [1, 1, 0],
  ], // Z
  [
    [1, 1, 1],
    [1, 0, 0],
  ], // L
  [
    [1, 1, 1],
    [0, 0, 1],
  ], // J
] as const;

const getRandomShape = (): number[][] => {
  const randomIndex = Math.floor(Math.random() * shapes.length);
  return shapes[randomIndex].map((row) => [...row]);
};

const rotateShape = (shape: number[][]): number[][] => {
  // Transpose the matrix
  const transposed = shape[0].map((_, colIndex) => shape.map((row) => row[colIndex]));
  // Reverse each row to rotate clockwise
  return transposed.map((row) => row.reverse());
};

export const App = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<number[][]>([]);
  const shapeRef = useRef(getRandomShape());
  const nextShapeRef = useRef(getRandomShape());
  const positionRef = useRef({ x: 0, y: 0 });
  const canvasWidth = useRef(Math.min(700, window.innerWidth));
  const canvasHeight = useRef(window.innerHeight);
  const cols = useRef(Math.floor(canvasWidth.current / blockSize));
  const rows = useRef(Math.floor(canvasHeight.current / blockSize));
  const lastUpdateTime = useRef(0);
  const gameLoopRef = useRef<number>(0);
  const lastRotationTime = useRef(0);

  const drawGrid = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.clearRect(0, 0, canvasWidth.current, canvasHeight.current);
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, canvasWidth.current, canvasHeight.current);

    // Draw grid lines
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    for (let r = 0; r < rows.current; r++) {
      for (let c = 0; c < cols.current; c++) {
        ctx.strokeRect(c * blockSize, r * blockSize, blockSize, blockSize);
        if (gridRef.current[r][c]) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(c * blockSize, r * blockSize, blockSize, blockSize);
        }
      }
    }
  }, []);

  const drawShape = useCallback((ctx: CanvasRenderingContext2D) => {
    // Draw current shape
    ctx.fillStyle = "#f00";
    shapeRef.current.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell) {
          ctx.fillRect(
            (positionRef.current.x + c) * blockSize,
            (positionRef.current.y + r) * blockSize,
            blockSize,
            blockSize,
          );
        }
      });
    });

    // Draw next shape preview
    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    // Ensure the preview stays within bounds
    const previewX = Math.max(
      0,
      Math.min(positionRef.current.x, cols.current - nextShapeRef.current[0].length),
    );
    const previewY = 0; // Top of the canvas
    nextShapeRef.current.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell) {
          ctx.fillRect(
            (previewX + c) * blockSize,
            (previewY + r) * blockSize,
            blockSize,
            blockSize,
          );
        }
      });
    });
  }, []);

  const mergeShapeToGrid = useCallback(() => {
    shapeRef.current.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell) {
          const x = positionRef.current.x + c;
          const y = positionRef.current.y + r;
          if (y < rows.current && x >= 0 && x < cols.current) {
            gridRef.current[y][x] = cell;
          }
        }
      });
    });
  }, []);

  const clearRows = useCallback(() => {
    gridRef.current = gridRef.current.filter((row) => row.some((cell) => cell === 0));
    while (gridRef.current.length < rows.current) {
      gridRef.current.unshift(Array(cols.current).fill(0));
    }
  }, []);

  const moveShape = useCallback(
    (dx: number, dy: number) => {
      const newX = positionRef.current.x + dx;
      const newY = positionRef.current.y + dy;

      if (
        newX >= 0 &&
        newX + shapeRef.current[0].length <= cols.current &&
        newY + shapeRef.current.length <= rows.current &&
        !shapeRef.current.some((row, r) =>
          row.some((cell, c) => cell && gridRef.current[newY + r]?.[newX + c]),
        )
      ) {
        positionRef.current = { x: newX, y: newY };
      } else if (dy > 0) {
        mergeShapeToGrid();
        clearRows();
        // Set current shape to next shape and generate new next shape
        shapeRef.current = nextShapeRef.current;
        nextShapeRef.current = getRandomShape();
        // Keep the same x position for the new shape, but ensure it's within bounds
        positionRef.current = {
          x: Math.max(
            0,
            Math.min(positionRef.current.x, cols.current - shapeRef.current[0].length),
          ),
          y: 0,
        };
      }
    },
    [clearRows, mergeShapeToGrid],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        moveShape(-1, 0);
      } else if (e.key === "ArrowRight") {
        moveShape(1, 0);
      } else if (e.key === " ") {
        const rotatedShape = rotateShape(shapeRef.current);
        const newX = positionRef.current.x;
        const newY = positionRef.current.y;

        // Check if the rotated shape would be within bounds
        const wouldFit =
          newX >= 0 &&
          newX + rotatedShape[0].length <= cols.current &&
          newY + rotatedShape.length <= rows.current &&
          !rotatedShape.some((row, r) =>
            row.some((cell, c) => cell && gridRef.current[newY + r]?.[newX + c]),
          );

        if (wouldFit) {
          shapeRef.current = rotatedShape;
        }
      } else if (e.key === "ArrowDown") {
        moveShape(0, 1);
      }
    },
    [moveShape],
  );

  const handlePoseDetected = useCallback(
    (pose: poseDetection.Pose, poseCanvasRef: React.RefObject<HTMLCanvasElement | null>) => {
      // Get all relevant keypoints (only upper body)
      const keypoints = {
        leftWrist: pose.keypoints.find((kp) => kp.name === "left_wrist"),
        rightWrist: pose.keypoints.find((kp) => kp.name === "right_wrist"),
        leftShoulder: pose.keypoints.find((kp) => kp.name === "left_shoulder"),
        rightShoulder: pose.keypoints.find((kp) => kp.name === "right_shoulder"),
        leftHip: pose.keypoints.find((kp) => kp.name === "left_hip"),
        rightHip: pose.keypoints.find((kp) => kp.name === "right_hip"),
        leftEye: pose.keypoints.find((kp) => kp.name === "left_eye"),
        rightEye: pose.keypoints.find((kp) => kp.name === "right_eye"),
        leftEar: pose.keypoints.find((kp) => kp.name === "left_ear"),
        rightEar: pose.keypoints.find((kp) => kp.name === "right_ear"),
        nose: pose.keypoints.find((kp) => kp.name === "nose"),
      };

      // Type assertion since we've checked all keypoints exist
      const kp = keypoints as {
        [K in keyof typeof keypoints]: poseDetection.Keypoint;
      };

      if (!poseCanvasRef.current) return;
      const ctx = poseCanvasRef.current.getContext("2d");
      if (!ctx) return;

      const shoulderWidth = Math.abs(kp.rightShoulder.x - kp.leftShoulder.x);
      const centerX = (kp.leftShoulder.x + kp.rightShoulder.x) / 2;
      const centerY = (kp.leftShoulder.y + kp.rightShoulder.y) / 2;

      // I shape: Both arms straight up
      const iShapeBox = {
        x: kp.leftEar.x, // Start at left ear
        y: 0, // Start at top of canvas
        width: kp.rightEar.x - kp.leftEar.x, // Width spans between ears
        height: kp.leftEar.y, // Extend down to ear level
      };
      drawShapeGuide(
        ctx,
        iShapeBox.x,
        iShapeBox.y,
        iShapeBox.width,
        iShapeBox.height,
        "rgba(255, 0, 0, 0.5)",
      );
      if (
        kp.leftWrist.x > iShapeBox.x &&
        kp.leftWrist.x < iShapeBox.x + iShapeBox.width &&
        kp.rightWrist.x > iShapeBox.x &&
        kp.rightWrist.x < iShapeBox.x + iShapeBox.width &&
        kp.leftWrist.y > iShapeBox.y &&
        kp.leftWrist.y < iShapeBox.y + iShapeBox.height &&
        kp.rightWrist.y > iShapeBox.y &&
        kp.rightWrist.y < iShapeBox.y + iShapeBox.height
      ) {
        nextShapeRef.current = shapes[0].map((row) => [...row]);
      }

      // T shape: Extend arms straight out to sides
      const tShapeBox = {
        x: 0, // Start at left edge of canvas
        y: kp.leftShoulder.y - shoulderWidth * 0.3, // Center the box on shoulders
        width: canvasWidth.current, // Extend full width of canvas
        height: shoulderWidth * 0.6, // Height centered on shoulders
      };
      drawShapeGuide(
        ctx,
        tShapeBox.x,
        tShapeBox.y,
        tShapeBox.width,
        tShapeBox.height,
        "rgba(0, 0, 255, 0.5)",
      );
      if (
        kp.leftWrist.x > tShapeBox.x &&
        kp.leftWrist.x < tShapeBox.x + tShapeBox.width &&
        kp.rightWrist.x > tShapeBox.x &&
        kp.rightWrist.x < tShapeBox.x + tShapeBox.width &&
        kp.leftWrist.y > tShapeBox.y &&
        kp.leftWrist.y < tShapeBox.y + tShapeBox.height &&
        kp.rightWrist.y > tShapeBox.y &&
        kp.rightWrist.y < tShapeBox.y + tShapeBox.height
      ) {
        nextShapeRef.current = shapes[2].map((row) => [...row]);
      }

      // O shape: Hands between torso forming an X
      const oShapeBox = {
        x: centerX - shoulderWidth * 0.25, // Center between shoulders, width is half of shoulder width
        y: kp.leftShoulder.y, // Start at shoulder level
        width: shoulderWidth * 0.5, // Width is half of shoulder width
        height: shoulderWidth * 0.75, // Height extends down from shoulders
      };
      drawShapeGuide(
        ctx,
        oShapeBox.x,
        oShapeBox.y,
        oShapeBox.width,
        oShapeBox.height,
        "rgba(0, 255, 0, 0.5)",
      );
      if (
        kp.leftWrist.x > oShapeBox.x &&
        kp.leftWrist.x < oShapeBox.x + oShapeBox.width &&
        kp.rightWrist.x > oShapeBox.x &&
        kp.rightWrist.x < oShapeBox.x + oShapeBox.width &&
        kp.leftWrist.y > oShapeBox.y &&
        kp.leftWrist.y < oShapeBox.y + oShapeBox.height &&
        kp.rightWrist.y > oShapeBox.y &&
        kp.rightWrist.y < oShapeBox.y + oShapeBox.height
      ) {
        nextShapeRef.current = shapes[1].map((row) => [...row]);
      }

      // S shape: Right wrist above right shoulder, left wrist near left waist
      const sShapeBox1 = {
        x: 0, // Start at left edge of canvas
        y: 0, // Start at top of canvas
        width: kp.rightEye.x * 0.75, // Extend from left edge to right shoulder
        height: kp.rightEye.y * 0.75, // Extend down to shoulder
      };
      const sShapeBox2 = {
        x: kp.leftHip.x, // Start at left hip
        y: kp.leftHip.y * 0.8, // Start at hip level
        width: canvasWidth.current - kp.leftHip.x, // Extend to right edge of canvas
        height: canvasHeight.current - kp.leftHip.y, // Extend to bottom of canvas
      };
      drawShapeGuide(
        ctx,
        sShapeBox1.x,
        sShapeBox1.y,
        sShapeBox1.width,
        sShapeBox1.height,
        "rgba(255, 255, 0, 0.5)",
      );
      drawShapeGuide(
        ctx,
        sShapeBox2.x,
        sShapeBox2.y,
        sShapeBox2.width,
        sShapeBox2.height,
        "rgba(255, 255, 0, 0.5)",
      );
      if (
        // Right wrist above right shoulder
        kp.rightWrist.x > sShapeBox1.x &&
        kp.rightWrist.x < sShapeBox1.x + sShapeBox1.width &&
        kp.rightWrist.y > sShapeBox1.y &&
        kp.rightWrist.y < sShapeBox1.y + sShapeBox1.height &&
        // Left wrist near left waist
        kp.leftWrist.x > sShapeBox2.x &&
        kp.leftWrist.x < sShapeBox2.x + sShapeBox2.width &&
        kp.leftWrist.y > sShapeBox2.y &&
        kp.leftWrist.y < sShapeBox2.y + sShapeBox2.height
      ) {
        nextShapeRef.current = shapes[3].map((row) => [...row]);
      }

      // Z shape: Left wrist above left shoulder, right wrist near right waist
      const zShapeBox1 = {
        x: canvasWidth.current - (canvasWidth.current - kp.leftEye.x) * 0.75, // Start 0.75 distance from right edge
        y: 0, // Start at top of canvas
        width: (canvasWidth.current - kp.leftEye.x) * 0.75, // Width is 0.75 of distance to left eye
        height: kp.leftEye.y * 0.75, // Extend down to eye level
      };
      const zShapeBox2 = {
        x: 0, // Start at left edge of canvas
        y: kp.rightHip.y * 0.8, // Start at right hip level
        width: kp.rightHip.x, // Extend from right hip to left edge
        height: canvasHeight.current - kp.rightHip.y, // Extend to bottom of canvas
      };
      drawShapeGuide(
        ctx,
        zShapeBox1.x,
        zShapeBox1.y,
        zShapeBox1.width,
        zShapeBox1.height,
        "rgba(255, 0, 255, 0.5)",
      );
      drawShapeGuide(
        ctx,
        zShapeBox2.x,
        zShapeBox2.y,
        zShapeBox2.width,
        zShapeBox2.height,
        "rgba(255, 0, 255, 0.5)",
      );
      if (
        // Left wrist above left shoulder
        kp.leftWrist.x > zShapeBox1.x &&
        kp.leftWrist.x < zShapeBox1.x + zShapeBox1.width &&
        kp.leftWrist.y > zShapeBox1.y &&
        kp.leftWrist.y < zShapeBox1.y + zShapeBox1.height &&
        // Right wrist near right waist
        kp.rightWrist.x > zShapeBox2.x &&
        kp.rightWrist.x < zShapeBox2.x + zShapeBox2.width &&
        kp.rightWrist.y > zShapeBox2.y &&
        kp.rightWrist.y < zShapeBox2.y + zShapeBox2.height
      ) {
        nextShapeRef.current = shapes[4].map((row) => [...row]);
      }

      // L shape: Left arm up and right arm out
      const lShapeBox1 = {
        x: kp.leftShoulder.x - shoulderWidth * 0.25, // Left side box
        y: 0, // Start at top of canvas
        width: shoulderWidth * 0.5, // Width similar to I shape
        height: kp.leftShoulder.y, // Extend down to shoulder height
      };
      const lShapeBox2 = {
        x: 0, // Start at left edge of canvas
        y: kp.rightShoulder.y - shoulderWidth * 0.3, // Same height as T shape
        width: kp.rightShoulder.x, // Extend to right shoulder
        height: shoulderWidth * 0.6, // Same height as T shape
      };
      drawShapeGuide(
        ctx,
        lShapeBox1.x,
        lShapeBox1.y,
        lShapeBox1.width,
        lShapeBox1.height,
        "rgba(0, 255, 255, 0.5)",
      );
      drawShapeGuide(
        ctx,
        lShapeBox2.x,
        lShapeBox2.y,
        lShapeBox2.width,
        lShapeBox2.height,
        "rgba(0, 255, 255, 0.5)",
      );
      if (
        kp.leftWrist.x > lShapeBox1.x &&
        kp.leftWrist.x < lShapeBox1.x + lShapeBox1.width &&
        kp.leftWrist.y > lShapeBox1.y &&
        kp.leftWrist.y < lShapeBox1.y + lShapeBox1.height &&
        kp.rightWrist.x > lShapeBox2.x &&
        kp.rightWrist.x < lShapeBox2.x + lShapeBox2.width &&
        kp.rightWrist.y > lShapeBox2.y &&
        kp.rightWrist.y < lShapeBox2.y + lShapeBox2.height
      ) {
        nextShapeRef.current = shapes[5].map((row) => [...row]);
      }

      // J shape: Right arm up and left arm out
      const jShapeBox1 = {
        x: kp.rightShoulder.x - shoulderWidth * 0.25, // Right side box
        y: 0, // Start at top of canvas
        width: shoulderWidth * 0.5, // Width similar to I shape
        height: kp.rightShoulder.y, // Extend down to shoulder height
      };
      const jShapeBox2 = {
        x: kp.leftShoulder.x, // Start at left shoulder
        y: kp.leftShoulder.y - shoulderWidth * 0.3, // Same height as T shape
        width: canvasWidth.current - kp.leftShoulder.x, // Extend to right edge
        height: shoulderWidth * 0.6, // Same height as T shape
      };
      drawShapeGuide(
        ctx,
        jShapeBox1.x,
        jShapeBox1.y,
        jShapeBox1.width,
        jShapeBox1.height,
        "rgba(255, 165, 0, 0.5)",
      );
      drawShapeGuide(
        ctx,
        jShapeBox2.x,
        jShapeBox2.y,
        jShapeBox2.width,
        jShapeBox2.height,
        "rgba(255, 165, 0, 0.5)",
      );
      if (
        kp.rightWrist.x > jShapeBox1.x &&
        kp.rightWrist.x < jShapeBox1.x + jShapeBox1.width &&
        kp.rightWrist.y > jShapeBox1.y &&
        kp.rightWrist.y < jShapeBox1.y + jShapeBox1.height &&
        kp.leftWrist.x > jShapeBox2.x &&
        kp.leftWrist.x < jShapeBox2.x + jShapeBox2.width &&
        kp.leftWrist.y > jShapeBox2.y &&
        kp.leftWrist.y < jShapeBox2.y + jShapeBox2.height
      ) {
        nextShapeRef.current = shapes[6].map((row) => [...row]);
      }

      // Check for rotation by measuring distance between shoulders
      const shoulderDistance = Math.abs(kp.leftShoulder.x - kp.rightShoulder.x);
      const isRotating = shoulderDistance < 50 && Date.now() - lastRotationTime.current > 600;

      if (isRotating) {
        const rotatedShape = rotateShape(shapeRef.current);
        const newX = positionRef.current.x;
        const newY = positionRef.current.y;

        // Check if the rotated shape would be within bounds
        const wouldFit =
          newX >= 0 &&
          newX + rotatedShape[0].length <= cols.current &&
          newY + rotatedShape.length <= rows.current &&
          !rotatedShape.some((row, r) =>
            row.some((cell, c) => cell && gridRef.current[newY + r]?.[newX + c]),
          );

        if (wouldFit) {
          shapeRef.current = rotatedShape;
          lastRotationTime.current = Date.now();
        }
      }

      // Update block position based on nose position
      if (kp.nose) {
        // Convert nose x position to grid position and invert it
        const noseXPercent = 1 - kp.nose.x / canvasWidth.current;
        const targetX = Math.floor(noseXPercent * cols.current);

        // Ensure the shape stays within bounds
        const maxX = cols.current - shapeRef.current[0].length;
        const newX = Math.max(0, Math.min(targetX, maxX));

        // Only update position if it's different to avoid unnecessary moves
        if (newX !== positionRef.current.x) {
          positionRef.current.x = newX;
        }
      }
    },
    [],
  );

  const resetGame = useCallback(() => {
    // Clear the grid
    gridRef.current = Array.from({ length: rows.current }, () => Array(cols.current).fill(0));
    // Reset position and shapes
    positionRef.current = { x: Math.floor(cols.current / 2) - 1, y: 0 };
    shapeRef.current = getRandomShape();
    nextShapeRef.current = getRandomShape();
  }, []);

  // Initialize grid and starting position
  useEffect(() => {
    gridRef.current = Array.from({ length: rows.current }, () => Array(cols.current).fill(0));
    positionRef.current = { x: Math.floor(cols.current / 2) - 1, y: 0 };
  }, []);

  // Game loop using requestAnimationFrame
  const gameLoop = useCallback(
    (timestamp: number) => {
      if (!lastUpdateTime.current) {
        lastUpdateTime.current = timestamp;
      }

      const deltaTime = timestamp - lastUpdateTime.current;

      // Update game state every 500ms
      if (deltaTime >= 500) {
        // Move the shape down by 1 unit
        positionRef.current.y += 1;

        // Check for collisions or if the shape has reached the bottom
        const newY = positionRef.current.y;
        if (
          newY + shapeRef.current.length > rows.current ||
          shapeRef.current.some((row, r) =>
            row.some((cell, c) => cell && gridRef.current[newY + r]?.[positionRef.current.x + c]),
          )
        ) {
          // Merge the shape into the grid and reset position
          positionRef.current.y -= 1; // Undo the last move
          mergeShapeToGrid();
          clearRows();

          // Check if any block has reached the top
          const hasBlockAtTop = gridRef.current[0].some((cell) => cell === 1);
          if (hasBlockAtTop) {
            resetGame();
          } else {
            // Set current shape to next shape and generate new next shape
            shapeRef.current = nextShapeRef.current;
            nextShapeRef.current = getRandomShape();
            positionRef.current = { x: Math.floor(cols.current / 2) - 1, y: 0 };
          }
        }

        lastUpdateTime.current = timestamp;
      }

      // Always redraw the canvas
      const ctx = canvasRef.current?.getContext("2d");
      if (ctx) {
        drawGrid(ctx);
        drawShape(ctx);
      }

      gameLoopRef.current = requestAnimationFrame(gameLoop);
    },
    [drawGrid, drawShape, mergeShapeToGrid, clearRows, resetGame],
  );

  // Start game loop
  useEffect(() => {
    gameLoopRef.current = requestAnimationFrame(gameLoop);
    return () => {
      if (gameLoopRef.current) {
        cancelAnimationFrame(gameLoopRef.current);
      }
    };
  }, [gameLoop]);

  // Handle keyboard input
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <main className="flex">
      <canvas
        className="m-auto"
        ref={canvasRef}
        width={canvasWidth.current}
        height={canvasHeight.current}
      />
      <Camera onPoseDetected={(pose, poseCanvasRef) => handlePoseDetected(pose, poseCanvasRef)} />
    </main>
  );
};

export default App;

const drawShapeGuide = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
) => {
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.setLineDash([5, 5]);
  ctx.strokeRect(x, y, width, height);
  ctx.setLineDash([]);
};
