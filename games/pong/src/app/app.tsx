"use client";

import React, { useEffect, useRef, useState } from "react";
import { Circle, OrbitControls, PerspectiveCamera, Text } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { ThreeEvent } from "@react-three/fiber";
import { Camera } from "./camera";

const Table = () => (
  <group>
    <lineSegments>
      <edgesGeometry args={[new THREE.BoxGeometry(10, 20, 0)]} />
      <lineBasicMaterial color="black" />
    </lineSegments>
    <mesh position={[0, 0, 0]}>
      <planeGeometry args={[10, 0.1]} />
      <meshBasicMaterial color="black" />
    </mesh>
  </group>
);

const Paddle = React.forwardRef<THREE.Group, React.ComponentProps<"group">>((props, ref) => (
  <group {...props} ref={ref}>
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[0.5, 0.1, 16, 100]} />
      <meshBasicMaterial color="black" />
    </mesh>
  </group>
));
Paddle.displayName = "Paddle";

const Ball = React.forwardRef<THREE.Mesh, React.ComponentProps<"mesh">>((props, ref) => (
  <mesh {...props} ref={ref}>
    <sphereGeometry args={[0.2, 16, 16]} />
    <meshBasicMaterial color="black" />
  </mesh>
));
Ball.displayName = "Ball";

const Game = ({ handPosition }: { handPosition: number | null }) => {
  const playerPaddleRef = useRef<THREE.Group>(null);
  const aiPaddleRef = useRef<THREE.Group>(null);
  const ballRef = useRef<THREE.Mesh>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const shadowRef = useRef<THREE.Mesh>(null);
  const isDragging = useRef(false);
  const lastPointerPosition = useRef({ x: 0, y: 0 });
  const initialCameraPosition = useRef(new THREE.Vector3(0, -13, 12));
  const lastHandPosition = useRef<number | null>(null);

  const [gameState, setGameState] = useState({
    playerScore: 0,
    aiScore: 0,
    gameStarted: false,
  });

  const ballVelocity = useRef(new THREE.Vector3(0, 0, 0));
  const BALL_SPEED = 0.1;
  const isArcing = useRef(false);
  const arcStartY = useRef(0);
  const arcTotalDistY = useRef(0);
  const MAX_BOUNCE_HEIGHT = 2;

  const resetGame = () => {
    if (ballRef.current) {
      ballRef.current.position.set(0, 0, 0);
    }
    const speed = BALL_SPEED;
    const angle = Math.random() * Math.PI * 2;
    ballVelocity.current.set(Math.cos(angle) * speed, Math.sin(angle) * speed, 0);
    setGameState((prev) => ({ ...prev, gameStarted: false }));
    isArcing.current = false;
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !gameState.gameStarted) {
        setGameState((prev) => ({ ...prev, gameStarted: true }));
        const speed = BALL_SPEED;
        const angle = -Math.PI / 2 + (Math.random() * 0.2 - 0.1);
        ballVelocity.current.set(Math.cos(angle) * speed, Math.sin(angle) * speed, 0);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [gameState.gameStarted]);

  useFrame(() => {
    if (cameraRef.current && !isDragging.current) {
      cameraRef.current.position.lerp(initialCameraPosition.current, 0.1);
    }

    if (handPosition && playerPaddleRef.current) {
      const targetX = (1 - handPosition) * 9 - 4.5;
      const clampedTargetX = THREE.MathUtils.clamp(targetX, -4.5, 4.5);

      let speed = 0;
      if (lastHandPosition.current !== null) {
        speed = Math.abs(handPosition - lastHandPosition.current);
      }
      lastHandPosition.current = handPosition;

      const baseSpeed = 0.2;
      const accelerationFactor = 10;
      const lerpFactor = THREE.MathUtils.clamp(baseSpeed + speed * accelerationFactor, 0, 1);

      playerPaddleRef.current.position.x = THREE.MathUtils.lerp(
        playerPaddleRef.current.position.x,
        clampedTargetX,
        lerpFactor,
      );
    } else {
      lastHandPosition.current = null;
    }

    if (ballRef.current && shadowRef.current) {
      shadowRef.current.position.x = ballRef.current.position.x;
      shadowRef.current.position.y = ballRef.current.position.y;
      (shadowRef.current.material as THREE.MeshBasicMaterial).opacity =
        0.3 * (1 - ballRef.current.position.z / MAX_BOUNCE_HEIGHT);
    }

    if (
      !gameState.gameStarted ||
      !ballRef.current ||
      !playerPaddleRef.current ||
      !aiPaddleRef.current
    )
      return;

    ballRef.current.position.x += ballVelocity.current.x;
    ballRef.current.position.y += ballVelocity.current.y;

    if (isArcing.current) {
      const distY = Math.abs(ballRef.current.position.y - arcStartY.current);
      const progress = Math.min(distY / arcTotalDistY.current, 1);

      ballRef.current.position.z = MAX_BOUNCE_HEIGHT * 4 * progress * (1 - progress);

      if (progress >= 1) {
        isArcing.current = false;
      }
    } else {
      ballRef.current.position.z = 0;
    }

    const { x, y } = ballRef.current.position;

    if (x >= 4.9 || x <= -4.9) {
      ballVelocity.current.x *= -1;
    }

    const playerPaddlePos = playerPaddleRef.current.position;
    if (
      y < playerPaddlePos.y + 0.5 &&
      y > playerPaddlePos.y - 0.5 &&
      x > playerPaddlePos.x - 0.7 &&
      x < playerPaddlePos.x + 0.7 &&
      ballVelocity.current.y < 0
    ) {
      const angle = Math.atan2(y - playerPaddlePos.y, x - playerPaddlePos.x);
      ballVelocity.current.set(
        Math.cos(angle) * BALL_SPEED,
        Math.abs(Math.sin(angle)) * BALL_SPEED,
        0,
      );

      isArcing.current = true;
      arcStartY.current = ballRef.current.position.y;
      const targetY = 4 + Math.random() * 3;
      arcTotalDistY.current = Math.abs(targetY - arcStartY.current);
    }

    const aiPaddlePos = aiPaddleRef.current.position;
    if (
      y > aiPaddlePos.y - 0.5 &&
      y < aiPaddlePos.y + 0.5 &&
      x > aiPaddlePos.x - 0.7 &&
      x < aiPaddlePos.x + 0.7 &&
      ballVelocity.current.y > 0
    ) {
      const angle = Math.atan2(y - aiPaddlePos.y, x - aiPaddlePos.x);
      ballVelocity.current.set(
        Math.cos(angle) * BALL_SPEED,
        -Math.abs(Math.sin(angle)) * BALL_SPEED,
        0,
      );

      isArcing.current = true;
      arcStartY.current = ballRef.current.position.y;
      const targetY = -4 - Math.random() * 3;
      arcTotalDistY.current = Math.abs(targetY - arcStartY.current);
    }

    const aiSpeed = 0.08;
    if (ballRef.current.position.x > aiPaddleRef.current.position.x) {
      aiPaddleRef.current.position.x = Math.min(
        aiPaddleRef.current.position.x + aiSpeed,
        ballRef.current.position.x,
      );
    } else {
      aiPaddleRef.current.position.x = Math.max(
        aiPaddleRef.current.position.x - aiSpeed,
        ballRef.current.position.x,
      );
    }
    aiPaddleRef.current.position.x = THREE.MathUtils.clamp(
      aiPaddleRef.current.position.x,
      -4.5,
      4.5,
    );

    if (y > 10) {
      setGameState((prev) => ({ ...prev, playerScore: prev.playerScore + 1 }));
      resetGame();
    } else if (y < -10) {
      setGameState((prev) => ({ ...prev, aiScore: prev.aiScore + 1 }));
      resetGame();
    }
  });

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    isDragging.current = true;
    lastPointerPosition.current = { x: event.clientX, y: event.clientY };
  };

  const handlePointerUp = () => {
    isDragging.current = false;
  };

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (isDragging.current) {
      const deltaX = event.clientX - lastPointerPosition.current.x;
      const deltaY = event.clientY - lastPointerPosition.current.y;

      if (cameraRef.current) {
        cameraRef.current.position.x -= deltaX * 0.02;
        cameraRef.current.position.y += deltaY * 0.02;
      }

      lastPointerPosition.current = { x: event.clientX, y: event.clientY };
    } else if (playerPaddleRef.current && handPosition === null) {
      const { x } = event.point;
      const clampedX = THREE.MathUtils.clamp(x, -4.5, 4.5);
      playerPaddleRef.current.position.x = clampedX;
      playerPaddleRef.current.position.y = -8;
    }
  };

  return (
    <>
      <PerspectiveCamera ref={cameraRef} makeDefault position={[0, -12, 12]} fov={50} />
      <OrbitControls enabled={false} target={[0, 0, 0]} />
      <ambientLight intensity={1} />
      <Table />
      <Ball ref={ballRef} />

      <Circle ref={shadowRef} args={[0.2, 16]} position={[0, 0, 0.01]} renderOrder={1}>
        <meshBasicMaterial color="black" transparent opacity={0.3} />
      </Circle>

      <Paddle ref={aiPaddleRef} position={[0, 8, 0]} />

      <Paddle ref={playerPaddleRef} position={[0, -8, 0]} />

      <mesh
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onPointerMove={handlePointerMove}
        visible={false}
      >
        <planeGeometry args={[100, 100]} />
      </mesh>

      <Text position={[-4, 10.5, 0]} fontSize={0.5} color="black">
        Player: {gameState.playerScore}
      </Text>
      <Text position={[4, 10.5, 0]} fontSize={0.5} color="black">
        AI: {gameState.aiScore}
      </Text>

      {!gameState.gameStarted && (
        <Text position={[0, 0, 1]} fontSize={0.5} color="black">
          Press Space to Start
        </Text>
      )}
    </>
  );
};

const Pong = () => {
  const [handPosition, setHandPosition] = useState<number | null>(null);

  return (
    <div className="h-dvh w-dvw bg-neutral-300">
      <Canvas>
        <Game handPosition={handPosition} />
      </Canvas>
      <Camera onPositionChange={setHandPosition} />
    </div>
  );
};

export default Pong;
