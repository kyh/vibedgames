import { useEffect, useRef, useState } from "react";

import { useGameAssets } from "./use-game-assets";

// Game constants
export const GRAVITY = 0.5;
export const JUMP_STRENGTH = 10;
export const PIPE_WIDTH = 50;
export const PIPE_GAP = 350;
export const PIPE_SPEED = 2.5;
export const PIPE_SPAWN_DISTANCE = 350;
export const BIRD_WIDTH = 34;
export const BIRD_HEIGHT = 24;
export const JUMP_VELOCITY = -8;
export const MAX_JUMP_VELOCITY = -12;

// Game types
export type GameState = "initial" | "playing" | "gameover";

export type Bird = {
  y: number;
  velocity: number;
  frame: number;
};

export type Pipe = {
  x: number;
  topHeight: number;
};

export type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Check if two rectangles are colliding
 */
export const checkCollision = (rect1: Rectangle, rect2: Rectangle): boolean => {
  return (
    rect1.x < rect2.x + rect2.width &&
    rect1.x + rect1.width > rect2.x &&
    rect1.y < rect2.y + rect2.height &&
    rect1.y + rect1.height > rect2.y
  );
};

// Game loop interface
export type GameLoopParams = {
  canvas: HTMLCanvasElement;
};

export const useGameState = () => {
  const { assetsLoaded, assets, playSound } = useGameAssets();
  const birdRef = useRef<Bird>({ y: 200, velocity: 0, frame: 0 });
  const pipesRef = useRef<Pipe[]>([]);
  const scoreRef = useRef<number>(0);
  const gameStateRef = useRef<GameState>("initial");
  const gameLoopRef = useRef<number | null>(null);
  const [_forceRender, setForceRender] = useState(false);

  // Reference to store the latest game loop params
  const gameLoopParamsRef = useRef<GameLoopParams | null>(null);

  /**
   * Makes the bird jump with optional strength parameter
   * @param jumpStrength A value between 0-1 that controls how high the bird jumps
   * @returns true if the bird jumped, false if the game state changed
   */
  const jump = (jumpStrength = 1): boolean => {
    if (gameStateRef.current === "playing") {
      // Calculate jump velocity based on strength (between JUMP_VELOCITY and MAX_JUMP_VELOCITY)
      const scaledVelocity = JUMP_VELOCITY + (MAX_JUMP_VELOCITY - JUMP_VELOCITY) * jumpStrength;

      birdRef.current.velocity = scaledVelocity;
      return true;
    }
    if (gameStateRef.current === "initial") {
      gameStateRef.current = "playing";
      return false;
    }
    return false;
  };

  /**
   * Starts or restarts the game loop with the given parameters.
   * If the restart parameter is true, game state will be reset.
   *
   * @param params Game loop parameters (canvas, assets, sound functions)
   * @param restart Whether to reset the game state (default: false)
   */
  const startGame = (params: GameLoopParams, restart = false) => {
    // Store params for potential restarts
    gameLoopParamsRef.current = params;

    // Reset game state if restarting
    if (restart) {
      birdRef.current = { y: 200, velocity: 0, frame: 0 };
      pipesRef.current = [];
      scoreRef.current = 0;
      gameStateRef.current = "playing";
      // Force a re-render
      setForceRender((prev) => !prev);
    }

    // Clear any existing game loop
    if (gameLoopRef.current) {
      clearInterval(gameLoopRef.current);
    }

    const { canvas } = params;
    const ctx = canvas.getContext("2d");
    if (!ctx || !assets.loaded) return;

    gameLoopRef.current = window.setInterval(() => {
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw background
      if (assets.background) {
        ctx.drawImage(assets.background, 0, 0, canvas.width, canvas.height);
      }

      if (gameStateRef.current === "initial") {
        // Draw message
        if (assets.message) {
          const messageWidth = 184;
          const messageHeight = 267;
          const messageX = (canvas.width - messageWidth) / 2;
          const messageY = (canvas.height - messageHeight) / 2;
          ctx.drawImage(assets.message, messageX, messageY, messageWidth, messageHeight);
        }
        return;
      }

      // Only update physics if the game is still playing
      if (gameStateRef.current === "playing") {
        // Update bird position and animation frame
        const bird = birdRef.current;
        bird.y += bird.velocity;
        bird.velocity += GRAVITY;
        bird.frame = (bird.frame + 1) % 3;

        // Move pipes
        const pipes = pipesRef.current;
        pipes.forEach((pipe) => (pipe.x -= PIPE_SPEED));

        // Generate new pipes
        const lastPipe = pipes[pipes.length - 1];
        if (pipes.length === 0 || lastPipe.x < canvas.width - PIPE_SPAWN_DISTANCE) {
          const topHeight = Math.random() * (canvas.height - PIPE_GAP - 100) + 50;
          pipes.push({ x: canvas.width, topHeight });
        }

        // Remove off-screen pipes
        pipesRef.current = pipes.filter((pipe) => pipe.x + PIPE_WIDTH > 0);

        // Check collisions
        const birdRect = {
          x: 50,
          y: bird.y,
          width: BIRD_WIDTH,
          height: BIRD_HEIGHT,
        };

        // Check pipe collisions
        for (const pipe of pipes) {
          const topPipeRect = {
            x: pipe.x,
            y: 0,
            width: PIPE_WIDTH,
            height: pipe.topHeight,
          };
          const bottomPipeRect = {
            x: pipe.x,
            y: pipe.topHeight + PIPE_GAP,
            width: PIPE_WIDTH,
            height: canvas.height - pipe.topHeight - PIPE_GAP,
          };

          if (checkCollision(birdRect, topPipeRect) || checkCollision(birdRect, bottomPipeRect)) {
            gameStateRef.current = "gameover";
            playSound("hit");
            break; // Exit the collision check loop once a collision is found
          }
        }

        // Check only floor collision, not ceiling
        if (bird.y > canvas.height) {
          gameStateRef.current = "gameover";
          playSound("hit");
        }

        // Update score - only when playing
        if (pipes.some((pipe) => pipe.x + PIPE_WIDTH < 50 && pipe.x + PIPE_WIDTH >= 48)) {
          scoreRef.current += 1;
          playSound("point");
        }
      }

      // Draw pipes
      pipesRef.current.forEach((pipe) => {
        if (assets.pipe) {
          // Draw top pipe (flipped vertically)
          ctx.save();
          ctx.scale(1, -1);
          ctx.drawImage(assets.pipe, pipe.x, -pipe.topHeight, PIPE_WIDTH, 640);
          ctx.restore();

          // Draw bottom pipe
          ctx.drawImage(assets.pipe, pipe.x, pipe.topHeight + PIPE_GAP, PIPE_WIDTH, 640);
        }
      });

      // Draw bird
      const bird = birdRef.current;
      ctx.save();
      ctx.translate(50 + BIRD_WIDTH / 2, bird.y + BIRD_HEIGHT / 2);
      ctx.rotate(Math.min(Math.PI / 4, Math.max(-Math.PI / 4, bird.velocity * 0.1)));
      const sprite = assets.birdSprites?.[bird.frame];
      if (sprite) {
        ctx.drawImage(sprite, -BIRD_WIDTH / 2, -BIRD_HEIGHT / 2, BIRD_WIDTH, BIRD_HEIGHT);
      }
      ctx.restore();

      // Draw score
      const scoreString = scoreRef.current.toString();
      const digitWidth = 24;
      const totalWidth = scoreString.length * digitWidth;
      const startX = (canvas.width - totalWidth) / 2;
      scoreString.split("").forEach((digit, index) => {
        const digitImage = assets.numberSprites?.[Number.parseInt(digit)];
        if (digitImage) {
          ctx.drawImage(digitImage, startX + index * digitWidth, 20, digitWidth, 36);
        }
      });

      // Draw game over screen
      if (gameStateRef.current === "gameover") {
        if (assets.gameOver) {
          const gameOverWidth = 192;
          const gameOverHeight = 42;
          const gameOverX = (canvas.width - gameOverWidth) / 2;
          const gameOverY = (canvas.height - gameOverHeight) / 2;
          ctx.drawImage(assets.gameOver, gameOverX, gameOverY, gameOverWidth, gameOverHeight);

          // Draw Restart button
          ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
          ctx.fillRect(canvas.width / 2 - 50, canvas.height / 2 + 50, 100, 40);
          ctx.fillStyle = "white";
          ctx.font = "20px Arial";
          ctx.fillText("Restart", canvas.width / 2 - 30, canvas.height / 2 + 75);
        }
      }
    }, 1000 / 60); // 60 FPS
  };

  /**
   * Stops the game loop
   */
  const stopGame = () => {
    if (gameLoopRef.current) {
      clearInterval(gameLoopRef.current);
      gameLoopRef.current = null;
    }
  };

  /**
   * Convenience method to restart the game with the existing parameters
   */
  const restartGame = () => {
    if (gameLoopParamsRef.current) {
      startGame(gameLoopParamsRef.current, true);
    }
  };

  // Ensure cleanup when component unmounts
  useEffect(() => {
    return () => {
      stopGame();
    };
  }, []);

  return {
    birdRef,
    pipesRef,
    scoreRef,
    gameStateRef,
    loaded: assetsLoaded,
    jump,
    startGame,
    stopGame,
    restartGame,
  };
};
