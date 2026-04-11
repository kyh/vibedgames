"use client";

import { useCallback, useEffect, useRef } from "react";

import { Camera } from "./camera";
import { useGameState } from "./use-game-state";

export const App = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { gameStateRef, loaded, jump, startGame, stopGame, restartGame } = useGameState();

  // Use useCallback to memoize the jump handler
  const handleJump = useCallback(
    (jumpStrength = 1) => {
      if (gameStateRef.current === "gameover") {
        restartGame();
        return;
      }
      jump(jumpStrength);
    },
    [jump, restartGame],
  );

  // Start game loop when assets are loaded and canvas is ready
  useEffect(() => {
    if (!loaded || !canvasRef.current) return;

    startGame({ canvas: canvasRef.current });

    // Clean up game loop when component unmounts
    return () => {
      stopGame();
    };
  }, [loaded, startGame, stopGame]);

  return (
    <>
      <canvas
        ref={canvasRef}
        width={window.innerWidth}
        height={window.innerHeight}
        onClick={() => handleJump()}
      />
      <Camera onJump={handleJump} />
    </>
  );
};

export default App;
