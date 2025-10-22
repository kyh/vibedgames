"use client";

import { memo, useCallback, useEffect, useRef } from "react";

// 16-bit color palette (reduced color options)
const STAR_COLORS = [
  "#FFFFFF", // White
  "#FFFFAA", // Light yellow
  "#AAAAFF", // Light blue
  "#FFAAAA", // Light red
  "#AAFFAA", // Light green
  "#FFAAFF", // Light purple
  "#AAFFFF", // Light cyan
] as const;

// Configuration constants
const starDensity = 0.00004; // Reduced density for larger stars
const twinkleProbability = 0.7;
const minTwinkleSpeed = 2;
const maxTwinkleSpeed = 4;
const pixelSize = 5;
const starRegenerationInterval = 5000; // Interval to regenerate stars (in ms)
const percentToRegenerate = 0.15; // Percentage of stars to regenerate at each interval

// Shooting star configuration
const shootingStarPixelSize = 2;
const targetFps = 16; // 16 FPS for that retro feel

// Type definitions
type BackgroundStar = {
  x: number;
  y: number;
  color: string;
  baseOpacity: number;
  currentOpacity: number;
  twinkle: boolean;
  twinkleSpeed: number;
  twinkleDirection: number; // -1 fading out, 1 fading in
  twinkleTimer: number;
};

type TrailPoint = {
  x: number;
  y: number;
  opacity: number;
};

type ShootingStar = {
  id: number;
  x: number;
  y: number;
  angle: number;
  scale: number;
  speed: number;
  distance: number;
  trail: TrailPoint[];
};

type StartPoint = {
  x: number;
  y: number;
  angle: number;
};

export const Background = memo(
  () => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const animationFrameRef = useRef<number | null>(null);

    // State references
    const backgroundStarsRef = useRef<BackgroundStar[]>([]);
    const shootingStarsRef = useRef<ShootingStar[]>([]);
    const lastRenderTimeRef = useRef<number>(0);
    const frameInterval: number = 1000 / targetFps;

    // Get random starting point for shooting stars
    const getRandomStartPoint = useCallback((): StartPoint => {
      // Start from anywhere along the top edge
      const x = Math.random() * window.innerWidth;

      // Randomize the angle with a wider range (45-135 degrees)
      // 90 degrees is straight down
      // 45 degrees is down-right, 135 degrees is down-left
      const angle = 45 + Math.random() * 90;

      return { x, y: 0, angle };
    }, []);

    // Create a new shooting star
    const createNewShootingStar = useCallback((): ShootingStar => {
      const { x, y, angle } = getRandomStartPoint();
      return {
        id: Date.now(),
        x,
        y,
        angle,
        scale: 1,
        speed: Math.random() * 5 + 8,
        distance: 0,
        trail: [], // Empty trail initially
      };
    }, [getRandomStartPoint]);

    // Initialize background stars
    const initBackgroundStars = useCallback((): void => {
      if (!canvasRef.current) return;

      const canvas = canvasRef.current;

      // Clear existing stars
      backgroundStarsRef.current = [];

      // Generate new stars
      const area = canvas.width * canvas.height;
      const numStars = Math.floor(area * starDensity);

      for (let i = 0; i < numStars; i++) {
        const shouldTwinkle = Math.random() < twinkleProbability;
        const gridX =
          Math.floor(Math.random() * (canvas.width / pixelSize)) * pixelSize;
        const gridY =
          Math.floor(Math.random() * (canvas.height / pixelSize)) * pixelSize;
        const colorIndex = Math.floor(Math.random() * STAR_COLORS.length);
        const baseOpacity = Math.random() * 0.5 + 0.5;

        backgroundStarsRef.current.push({
          x: gridX,
          y: gridY,
          color: STAR_COLORS[colorIndex]!,
          baseOpacity,
          currentOpacity: baseOpacity,
          twinkle: shouldTwinkle,
          twinkleSpeed:
            minTwinkleSpeed +
            Math.random() * (maxTwinkleSpeed - minTwinkleSpeed),
          twinkleDirection: -1, // -1 fading out, 1 fading in
          twinkleTimer: 0,
        });
      }
    }, []);

    // Regenerate a portion of background stars
    const regenerateBackgroundStars = useCallback((): void => {
      if (!canvasRef.current || backgroundStarsRef.current.length === 0) return;

      const canvas = canvasRef.current;
      const numToRegenerate = Math.max(
        1,
        Math.floor(backgroundStarsRef.current.length * percentToRegenerate),
      );

      for (let i = 0; i < numToRegenerate; i++) {
        const randomIndex = Math.floor(
          Math.random() * backgroundStarsRef.current.length,
        );

        // Replace with a new star
        const shouldTwinkle = Math.random() < twinkleProbability;
        const gridX =
          Math.floor(Math.random() * (canvas.width / pixelSize)) * pixelSize;
        const gridY =
          Math.floor(Math.random() * (canvas.height / pixelSize)) * pixelSize;
        const colorIndex = Math.floor(Math.random() * STAR_COLORS.length);
        const baseOpacity = Math.random() * 0.5 + 0.5;

        backgroundStarsRef.current[randomIndex] = {
          x: gridX,
          y: gridY,
          color: STAR_COLORS[colorIndex]!,
          baseOpacity,
          currentOpacity: baseOpacity,
          twinkle: shouldTwinkle,
          twinkleSpeed:
            minTwinkleSpeed +
            Math.random() * (maxTwinkleSpeed - minTwinkleSpeed),
          twinkleDirection: -1,
          twinkleTimer: 0,
        };
      }
    }, []);

    // Main animation loop
    const animateCanvas = useCallback(
      (timestamp: number): void => {
        // Skip frames to limit to target FPS
        if (timestamp - lastRenderTimeRef.current < frameInterval) {
          animationFrameRef.current = requestAnimationFrame(animateCanvas);
          return;
        }

        lastRenderTimeRef.current = timestamp;

        if (!canvasRef.current) {
          animationFrameRef.current = requestAnimationFrame(animateCanvas);
          return;
        }

        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");

        if (!ctx) {
          animationFrameRef.current = requestAnimationFrame(animateCanvas);
          return;
        }

        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 1. Draw and update background stars
        backgroundStarsRef.current.forEach((star) => {
          ctx.fillStyle = star.color;
          ctx.globalAlpha = star.currentOpacity;
          ctx.fillRect(star.x, star.y, pixelSize, pixelSize);

          // Update twinkling
          if (star.twinkle) {
            // Update twinkle timer
            star.twinkleTimer += 1 / targetFps;

            if (star.twinkleTimer >= star.twinkleSpeed) {
              star.twinkleTimer = 0;
              star.twinkleDirection *= -1; // Reverse direction
            }

            // Calculate new opacity based on discrete steps
            const progress = star.twinkleTimer / star.twinkleSpeed;
            if (progress < 0.5) {
              star.currentOpacity =
                star.twinkleDirection < 0
                  ? star.baseOpacity
                  : star.baseOpacity * 0.3;
            } else {
              star.currentOpacity =
                star.twinkleDirection < 0
                  ? star.baseOpacity * 0.3
                  : star.baseOpacity;
            }
          }
        });

        // 2. Update shooting stars
        if (shootingStarsRef.current.length) {
          shootingStarsRef.current = shootingStarsRef.current
            .map((star) => {
              // Calculate new position
              const newX =
                star.x + star.speed * Math.cos((star.angle * Math.PI) / 180);
              const newY =
                star.y + star.speed * Math.sin((star.angle * Math.PI) / 180);
              const newDistance = star.distance + star.speed;

              // Add current position to trail
              const newTrail = [...star.trail];

              // Only add to trail every few frames for pixelated effect
              if (newDistance % 8 < star.speed) {
                newTrail.push({
                  x: star.x,
                  y: star.y,
                  opacity: 1.0,
                });
              }

              // Update trail opacity and remove old trail pieces
              const updatedTrail = newTrail
                .map((point) => ({ ...point, opacity: point.opacity - 0.1 }))
                .filter((point) => point.opacity > 0);

              return {
                ...star,
                x: newX,
                y: newY,
                distance: newDistance,
                trail: updatedTrail,
              };
            })
            .filter(
              (star) =>
                // Remove stars that are out of bounds
                star.x >= -30 &&
                star.x <= window.innerWidth + 30 &&
                star.y >= -30 &&
                star.y <= window.innerHeight + 30,
            );

          // 3. Draw shooting stars
          shootingStarsRef.current.forEach((star) => {
            // Draw trail
            star.trail.forEach((point) => {
              ctx.save();
              ctx.translate(point.x, point.y);
              ctx.rotate((star.angle * Math.PI) / 180);
              ctx.translate(-point.x, -point.y);

              ctx.fillStyle = `rgba(180, 242, 255, ${point.opacity})`;
              ctx.fillRect(
                point.x,
                point.y,
                shootingStarPixelSize,
                shootingStarPixelSize,
              );

              ctx.restore();
            });

            // Draw star (pixelated representation)
            const starWidth = 4; // 4 pixels wide
            const starHeight = 2; // 2 pixels high

            ctx.save();
            ctx.translate(star.x, star.y);
            ctx.rotate((star.angle * Math.PI) / 180);
            ctx.translate(-star.x, -star.y);

            ctx.fillStyle = "#ffffff";
            ctx.globalAlpha = 1.0;

            for (let y = 0; y < starHeight; y++) {
              for (let x = 0; x < starWidth; x++) {
                // Skip some pixels for pixelated look
                if ((x === 0 && y === 1) || (x === 3 && y === 0)) continue;

                ctx.fillRect(
                  star.x + x * shootingStarPixelSize,
                  star.y + y * shootingStarPixelSize,
                  shootingStarPixelSize,
                  shootingStarPixelSize,
                );
              }
            }

            ctx.restore();
          });
        }

        animationFrameRef.current = requestAnimationFrame(animateCanvas);
      },
      [frameInterval],
    );

    // Initialize the component
    useEffect(() => {
      if (!canvasRef.current) return;

      // Set canvas dimensions
      canvasRef.current.width = window.innerWidth;
      canvasRef.current.height = window.innerHeight;

      // Initialize background stars
      initBackgroundStars();

      // Start animation loop
      animationFrameRef.current = requestAnimationFrame(animateCanvas);

      // Create shooting stars periodically
      const createShootingStar = (): void => {
        const newStar = createNewShootingStar();
        shootingStarsRef.current = [...shootingStarsRef.current, newStar];

        // Set a random delay for creating the next star
        const randomDelay = Math.random() * 4000 + 2000; // 2-6 seconds
        setTimeout(createShootingStar, randomDelay);
      };

      // Create first shooting star
      createShootingStar();

      // Set up regeneration interval for background stars
      const regenerationInterval = setInterval(
        regenerateBackgroundStars,
        starRegenerationInterval,
      );

      // Handle window resize
      const handleResize = (): void => {
        if (canvasRef.current) {
          canvasRef.current.width = window.innerWidth;
          canvasRef.current.height = window.innerHeight;
          initBackgroundStars();
        }
      };

      window.addEventListener("resize", handleResize);

      // Cleanup
      return () => {
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }
        clearInterval(regenerationInterval);
        window.removeEventListener("resize", handleResize);
      };
    }, [
      animateCanvas,
      createNewShootingStar,
      initBackgroundStars,
      regenerateBackgroundStars,
    ]);

    return (
      <canvas ref={canvasRef} className="pointer-events-none fixed inset-0" />
    );
  },
  () => true,
);

export default Background;
