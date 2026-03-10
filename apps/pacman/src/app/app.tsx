"use client";

import type { FC } from "react";
import type { Group } from "three";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";

import { FaceDetection } from "./face-detection";

/**
 * Type definitions for the Pacman game
 */
type CellType = 0 | 1 | 2 | 3; // 0 = empty, 1 = wall, 2 = pellet, 3 = power pellet
type GameMap = CellType[][];
type Direction = Vector3;
type GhostId = number;

type PelletData = {
  id: string;
  position: Vector3;
  isPowerPellet: boolean;
  collected: boolean;
};

type GhostData = {
  id: GhostId;
  position: Vector3;
  color: string;
  direction: Direction;
};

type GameState = {
  score: number;
  gameOver: boolean;
  ghostsScared: boolean;
  scaredTimer?: NodeJS.Timeout;
};

/**
 * Game map layout:
 * 0 = empty
 * 1 = wall
 * 2 = pellet
 * 3 = power pellet
 */
const MAP: GameMap = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 3, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 1, 3, 1],
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 2, 1, 1, 2, 1, 2, 1, 1, 1, 1, 1, 2, 1, 2, 1, 1, 2, 1],
  [1, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 2, 1],
  [1, 1, 1, 1, 2, 1, 1, 1, 0, 1, 0, 1, 1, 1, 2, 1, 1, 1, 1],
  [0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0],
  [1, 1, 1, 1, 2, 1, 0, 1, 1, 0, 1, 1, 0, 1, 2, 1, 1, 1, 1],
  [0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0],
  [1, 1, 1, 1, 2, 1, 0, 1, 1, 1, 1, 1, 0, 1, 2, 1, 1, 1, 1],
  [0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0],
  [1, 1, 1, 1, 2, 1, 0, 1, 1, 1, 1, 1, 0, 1, 2, 1, 1, 1, 1],
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 2, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 1, 2, 1],
  [1, 3, 2, 1, 2, 2, 2, 2, 2, 0, 2, 2, 2, 2, 2, 1, 2, 3, 1],
  [1, 1, 2, 1, 2, 1, 2, 1, 1, 1, 1, 1, 2, 1, 2, 1, 2, 1, 1],
  [1, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 2, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

/**
 * Movement direction vectors
 */
const DIRECTIONS = {
  UP: new Vector3(0, 0, -1),
  DOWN: new Vector3(0, 0, 1),
  LEFT: new Vector3(-1, 0, 0),
  RIGHT: new Vector3(1, 0, 0),
  NONE: new Vector3(0, 0, 0),
};

/**
 * Game constants
 */
const CONSTANTS = {
  GRID_CELL_SIZE: 1,
  MOVEMENT_SPEED: 4,
  GHOST_SPEED: 1.5,
  SCARED_GHOST_SPEED: 0.75,
  WALL_COLLISION_THRESHOLD: 0.4,
  GHOST_COLLISION_RADIUS: 0.9,
  PELLET_COLLECTION_RADIUS: 0.6,
  CAMERA_SMOOTHING: 0.1,
  POWER_PELLET_DURATION: 10000,
};

/**
 * Wall component
 */
type WallProps = {
  position: [number, number, number];
};

const Wall: FC<WallProps> = ({ position }) => {
  return (
    <mesh position={[position[0], position[1] + 0.5, position[2]]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#1d4ed8" transparent opacity={0.7} />
    </mesh>
  );
};

/**
 * Pellet component
 */
type PelletProps = {
  position: Vector3;
  isPowerPellet?: boolean;
  onCollect?: () => void;
};

const Pellet: FC<PelletProps> = ({ position, isPowerPellet = false, onCollect }) => {
  const ref = useRef<Group>(null);

  useFrame(() => {
    if (ref.current) {
      ref.current.rotation.y += 0.01;
    }
  });

  return (
    <mesh
      ref={ref}
      position={position}
      userData={{ type: isPowerPellet ? "powerPellet" : "pellet", onCollect }}
    >
      <sphereGeometry args={isPowerPellet ? [0.3, 8, 8] : [0.1, 8, 8]} />
      <meshStandardMaterial color={isPowerPellet ? "#ec4899" : "#facc15"} />
    </mesh>
  );
};

/**
 * PacMan character component
 */
type PacManProps = {
  position: Vector3;
  direction: Direction;
  isMoving: boolean;
};

const PacMan: FC<PacManProps> = ({ position, direction, isMoving }) => {
  const ref = useRef<Group>(null);
  const mouthRef = useRef<Group>(null);
  const mouthOpenAngle = useRef(0);

  useFrame((_, delta) => {
    if (!ref.current || !mouthRef.current) return;

    // Reset rotation first
    ref.current.rotation.set(0, 0, 0);

    // Set proper orientation based on direction
    if (direction.equals(DIRECTIONS.UP)) {
      ref.current.rotation.x = -Math.PI / 2;
    } else if (direction.equals(DIRECTIONS.DOWN)) {
      ref.current.rotation.x = Math.PI / 2;
    } else if (direction.equals(DIRECTIONS.LEFT)) {
      ref.current.rotation.y = Math.PI;
    }
    // Right is the default orientation

    // Animate mouth opening/closing
    const targetAngle = isMoving ? Math.PI / 4 : 0;
    mouthOpenAngle.current += (targetAngle - mouthOpenAngle.current) * Math.min(delta * 10, 1);
  });

  return (
    <group ref={ref} position={position} name="pacman">
      {/* Pacman body with animated mouth */}
      <group ref={mouthRef}>
        {/* Main sphere */}
        <mesh>
          <sphereGeometry args={[0.5, 32, 32]} />
          <meshStandardMaterial color="#facc15" />
        </mesh>

        {/* Mouth cutout (black wedge facing forward) */}
        <mesh position={[0, 0, 0]} rotation={[0, 0, 0]}>
          <sphereGeometry
            args={[
              0.51,
              32,
              32,
              (Math.PI * 7) / 4, // phi start (slightly offset from PI*3/2 for better appearance)
              Math.PI / 2, // phi length (half circle)
              0, // theta start
              isMoving ? mouthOpenAngle.current : 0,
            ]} // theta length - animated
          />
          <meshStandardMaterial color="#000000" side={1} />
        </mesh>
      </group>
    </group>
  );
};

/**
 * Ghost enemy component
 */
type GhostProps = {
  position: Vector3;
  color: string;
  scared: boolean;
};

const Ghost: FC<GhostProps> = ({ position, color, scared }) => {
  const ref = useRef<Group>(null);

  useFrame(() => {
    // Make ghost float up and down
    if (ref.current) {
      ref.current.position.y = Math.sin(Date.now() * 0.003) * 0.1 + 0.5;
    }
  });

  return (
    <group position={position}>
      <group ref={ref}>
        <mesh>
          <sphereGeometry args={[0.5, 32, 16, 0, Math.PI * 2, 0, Math.PI]} />
          <meshStandardMaterial color={scared ? "#6b7280" : color} />
        </mesh>
        {/* Eyes */}
        <group position={[0.2, 0.1, -0.3]}>
          <mesh>
            <sphereGeometry args={[0.15, 16, 16]} />
            <meshStandardMaterial color="white" />
          </mesh>
          <mesh position={[0, 0, -0.08]}>
            <sphereGeometry args={[0.07, 16, 16]} />
            <meshStandardMaterial color="black" />
          </mesh>
        </group>
        <group position={[-0.2, 0.1, -0.3]}>
          <mesh>
            <sphereGeometry args={[0.15, 16, 16]} />
            <meshStandardMaterial color="white" />
          </mesh>
          <mesh position={[0, 0, -0.08]}>
            <sphereGeometry args={[0.07, 16, 16]} />
            <meshStandardMaterial color="black" />
          </mesh>
        </group>
      </group>
    </group>
  );
};

/**
 * Utility functions for game logic
 */
const GameUtils = {
  /**
   * Snaps an arbitrary position to the nearest grid cell center
   */
  snapToGrid: (position: Vector3): Vector3 => {
    return new Vector3(Math.round(position.x), position.y, Math.round(position.z));
  },

  /**
   * Checks if a position is at a grid cell center (or very close to it)
   */
  isAtGridCenter: (position: Vector3, threshold = 0.15): boolean => {
    const distX = Math.abs(position.x - Math.round(position.x));
    const distZ = Math.abs(position.z - Math.round(position.z));
    return distX <= threshold && distZ <= threshold;
  },

  /**
   * Checks if a position is approaching a grid cell center
   */
  isApproachingGridCenter: (position: Vector3, direction: Direction): boolean => {
    const targetGridX = Math.round(position.x + direction.x * 0.5);
    const targetGridZ = Math.round(position.z + direction.z * 0.5);
    const distToGrid = Math.abs(position.x - targetGridX) + Math.abs(position.z - targetGridZ);
    return distToGrid < 0.5;
  },

  /**
   * Checks if a grid cell is a valid move (not a wall)
   */
  isValidMove: (x: number, z: number): boolean => {
    // Check if the position is within the map bounds
    if (x < 0 || z < 0 || x >= MAP[0].length || z >= MAP.length) return false;
    // Check if the position is not a wall
    return MAP[z][x] !== 1;
  },

  /**
   * Gets valid directions from current grid position
   */
  getValidDirections: (position: Vector3): Direction[] => {
    // Ensure we're working with rounded grid coordinates
    const gridX = Math.round(position.x);
    const gridZ = Math.round(position.z);

    const validDirections: Direction[] = [];

    // Check each of the four possible directions
    if (GameUtils.isValidMove(gridX, gridZ - 1)) validDirections.push(DIRECTIONS.UP);
    if (GameUtils.isValidMove(gridX, gridZ + 1)) validDirections.push(DIRECTIONS.DOWN);
    if (GameUtils.isValidMove(gridX - 1, gridZ)) validDirections.push(DIRECTIONS.LEFT);
    if (GameUtils.isValidMove(gridX + 1, gridZ)) validDirections.push(DIRECTIONS.RIGHT);

    return validDirections;
  },
};

/**
 * First-person camera component with smooth transitions
 */
type PacmanCameraProps = {
  position: Vector3;
  direction: Direction;
  mapOffset: [number, number, number];
  shifKeyPressed: boolean; // Add new prop to track shift key state
};

const PacmanCamera: FC<PacmanCameraProps> = ({
  position,
  direction,
  mapOffset,
  shifKeyPressed, // New prop
}) => {
  const { camera } = useThree();

  // Create refs to track and smoothly interpolate camera position and target
  const currentCameraPos = useRef(new Vector3());
  const targetCameraPos = useRef(new Vector3());
  const currentLookAt = useRef(new Vector3());
  const targetLookAt = useRef(new Vector3());

  useFrame(() => {
    // Only update camera if the first-person view is enabled
    if (!position || !direction) return;

    // Calculate offset position (Pacman's position in the world)
    const worldPos = position.clone().add(new Vector3(...mapOffset));

    // Calculate target camera position
    let cameraOffset;

    if (shifKeyPressed) {
      // When shift is pressed, position camera in front of Pacman to see his front
      cameraOffset = direction.clone().multiplyScalar(2.5);
      cameraOffset.y = 2; // Raise the camera 2 units above the ground
    } else {
      // Normal position behind Pacman
      cameraOffset = direction.clone().multiplyScalar(-2.5);
      cameraOffset.y = 2; // Raise the camera 2 units above the ground
    }

    targetCameraPos.current.copy(worldPos).add(cameraOffset);

    // Calculate target look-at point
    // When shift is pressed, look back at Pacman, otherwise look ahead
    const lookAtOffset = shifKeyPressed
      ? direction.clone().multiplyScalar(-1)
      : direction.clone().multiplyScalar(2);

    targetLookAt.current.copy(worldPos).add(lookAtOffset);

    // On first frame, initialize current positions to targets to avoid jumps
    if (currentCameraPos.current.length() === 0) {
      currentCameraPos.current.copy(targetCameraPos.current);
      currentLookAt.current.copy(targetLookAt.current);
    }

    // Smoothly interpolate between current and target positions
    currentCameraPos.current.lerp(targetCameraPos.current, CONSTANTS.CAMERA_SMOOTHING);
    currentLookAt.current.lerp(targetLookAt.current, CONSTANTS.CAMERA_SMOOTHING);

    // Apply the smoothed camera position
    camera.position.copy(currentCameraPos.current);
    camera.lookAt(currentLookAt.current);
  });

  return null;
};

/**
 * Main game component
 */
type GameProps = {
  requestStepRef: React.MutableRefObject<boolean>;
  shiftKeyPressed: boolean;
  gameRef: React.MutableRefObject<{
    handleKeyDown?: (e: KeyboardEvent | { key: string }) => void;
  }>;
};

const Game: FC<GameProps> = ({ requestStepRef, shiftKeyPressed, gameRef }) => {
  // Game state
  const [gameState, setGameState] = useState<GameState>({
    score: 0,
    gameOver: false,
    ghostsScared: false,
  });

  // Player state
  const [pacmanPosition, setPacmanPosition] = useState<Vector3>(
    new Vector3(1, 0, 1), // Starting position
  );
  const [direction, setDirection] = useState<Direction>(DIRECTIONS.RIGHT);
  const [nextDirection, setNextDirection] = useState<Direction>(DIRECTIONS.NONE);

  // Add state for Pacman's target position and animation
  const [targetPosition, setTargetPosition] = useState<Vector3>(new Vector3(1, 0, 1));
  const [isMoving, setIsMoving] = useState<boolean>(false);
  const animationSpeed = useRef(5); // Speed of movement animation

  // Game elements
  const [pellets, setPellets] = useState<PelletData[]>([]);
  const [walls, setWalls] = useState<[number, number, number][]>([]);
  const [ghosts, setGhosts] = useState<GhostData[]>([
    {
      id: 1,
      position: new Vector3(9, 0, 9),
      color: "#ef4444",
      direction: DIRECTIONS.UP,
    },
    {
      id: 2,
      position: new Vector3(8, 0, 9),
      color: "#f97316",
      direction: DIRECTIONS.LEFT,
    },
    {
      id: 3,
      position: new Vector3(10, 0, 9),
      color: "#22c55e",
      direction: DIRECTIONS.RIGHT,
    },
    {
      id: 4,
      position: new Vector3(9, 0, 8),
      color: "#3b82f6",
      direction: DIRECTIONS.UP,
    },
  ]);

  // Direction ref for keyboard handling
  const directionRef = useRef<Direction>(DIRECTIONS.RIGHT);

  // Update direction ref when state changes
  if (!direction.equals(directionRef.current)) {
    directionRef.current = direction;
  }

  // Add a ref to track pending turns
  const pendingTurnRef = useRef<Direction | null>(null);

  /**
   * Initialize the game elements (walls and pellets)
   */
  useMemo(() => {
    const newPellets: PelletData[] = [];
    const newWalls: [number, number, number][] = [];

    // Create walls and pellets based on map
    for (let z = 0; z < MAP.length; z++) {
      for (let x = 0; x < MAP[0].length; x++) {
        if (MAP[z][x] === 1) {
          // Wall
          newWalls.push([x, 0, z]);
        } else if (MAP[z][x] === 2 || MAP[z][x] === 3) {
          // Pellet or Power Pellet
          newPellets.push({
            id: `pellet-${x}-${z}`,
            position: new Vector3(x, 0, z),
            isPowerPellet: MAP[z][x] === 3,
            collected: false,
          });
        }
      }
    }

    setPellets(newPellets);
    setWalls(newWalls);

    // Snap initial position to grid
    setPacmanPosition(GameUtils.snapToGrid(new Vector3(1, 0, 1)));

    return () => {
      // Clear any timers when unmounting
      if (gameState.scaredTimer) {
        clearTimeout(gameState.scaredTimer);
      }
    };
  }, []);

  /**
   * Handle keyboard input
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent | { key: string }): void => {
      const currentDirection = directionRef.current;
      let newDirection: Direction;

      switch (e.key) {
        case "ArrowUp": // Forward in current direction
          newDirection = currentDirection;
          break;
        case "ArrowDown": // Backward/reverse current direction
          newDirection = currentDirection.clone().negate();
          break;
        case "ArrowLeft": // Turn left relative to current direction
          if (currentDirection.equals(DIRECTIONS.UP)) {
            newDirection = DIRECTIONS.LEFT;
          } else if (currentDirection.equals(DIRECTIONS.DOWN)) {
            newDirection = DIRECTIONS.RIGHT;
          } else if (currentDirection.equals(DIRECTIONS.LEFT)) {
            newDirection = DIRECTIONS.DOWN;
          } else if (currentDirection.equals(DIRECTIONS.RIGHT)) {
            newDirection = DIRECTIONS.UP;
          } else {
            newDirection = DIRECTIONS.NONE;
          }
          break;
        case "ArrowRight": // Turn right relative to current direction
          if (currentDirection.equals(DIRECTIONS.UP)) {
            newDirection = DIRECTIONS.RIGHT;
          } else if (currentDirection.equals(DIRECTIONS.DOWN)) {
            newDirection = DIRECTIONS.LEFT;
          } else if (currentDirection.equals(DIRECTIONS.LEFT)) {
            newDirection = DIRECTIONS.UP;
          } else if (currentDirection.equals(DIRECTIONS.RIGHT)) {
            newDirection = DIRECTIONS.DOWN;
          } else {
            newDirection = DIRECTIONS.NONE;
          }
          break;
        default:
          return; // Ignore other keys
      }

      // Store the next direction for future reference
      setNextDirection(newDirection);

      // Set the direction immediately without validation
      setDirection(newDirection);

      // Clear any pending turns
      pendingTurnRef.current = null;
    },
    [directionRef],
  );

  // Setup event listeners
  useMemo(() => {
    window.addEventListener("keydown", handleKeyDown);
    gameRef.current = {
      handleKeyDown,
    };
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  /**
   * End ghost scared mode after a timeout
   */
  useMemo(() => {
    if (gameState.ghostsScared) {
      const timer = setTimeout(() => {
        setGameState((prev) => ({ ...prev, ghostsScared: false }));
      }, CONSTANTS.POWER_PELLET_DURATION);

      // Store timer reference for cleanup
      setGameState((prev) => ({ ...prev, scaredTimer: timer }));

      return () => clearTimeout(timer);
    }
  }, [gameState.ghostsScared]);

  /**
   * Check if Pacman collected any pellets
   */
  const checkPelletCollection = useCallback((position: Vector3, radius = 0.5): void => {
    // Use grid position for more precise collection
    const gridPos = GameUtils.snapToGrid(position);

    setPellets((prevPellets) => {
      const newPellets = [...prevPellets];
      const pelletIndex = newPellets.findIndex(
        (p) => !p.collected && p.position.distanceTo(gridPos) < radius,
      );

      if (pelletIndex !== -1) {
        // Update the game state when collecting a pellet
        newPellets[pelletIndex].collected = true;

        if (newPellets[pelletIndex].isPowerPellet) {
          setGameState((prev) => ({
            ...prev,
            ghostsScared: true,
            score: prev.score + 50,
          }));
        } else {
          setGameState((prev) => ({ ...prev, score: prev.score + 10 }));
        }

        // Check if all pellets are collected
        if (newPellets.every((p) => p.collected)) {
          setGameState((prev) => ({ ...prev, gameOver: true }));
        }
      }

      return newPellets;
    });
  }, []);

  /**
   * Check for collisions with ghosts
   */
  const checkGhostCollisions = useCallback(
    (position: Vector3, radius = 0.8): void => {
      const gridPos = GameUtils.snapToGrid(position);

      ghosts.forEach((ghost) => {
        const ghostGridPos = GameUtils.snapToGrid(ghost.position);
        if (gridPos.equals(ghostGridPos)) {
          if (gameState.ghostsScared) {
            // Ghost is scared, send it back to the center
            setGhosts((prevGhosts) =>
              prevGhosts.map((g) =>
                g.id === ghost.id ? { ...g, position: new Vector3(9, 0, 9) } : g,
              ),
            );

            setGameState((prev) => ({ ...prev, score: prev.score + 200 }));
          } else {
            // Reset Pacman position and direction
            setPacmanPosition(GameUtils.snapToGrid(new Vector3(1, 0, 1)));
            setDirection(DIRECTIONS.RIGHT);
            setNextDirection(DIRECTIONS.NONE);
            setIsMoving(false); // Reset animation state
            setTargetPosition(GameUtils.snapToGrid(new Vector3(1, 0, 1))); // Reset target position
            setGameState((prev) => ({ ...prev }));
          }
        }
      });
    },
    [ghosts, gameState.ghostsScared],
  );

  /**
   * Move ghosts with grid-based movement
   */
  const moveGhostsOnGrid = useCallback(
    (delta: number): void => {
      setGhosts((prevGhosts) => {
        return prevGhosts.map((ghost) => {
          // Check if ghost is at a grid intersection
          if (GameUtils.isAtGridCenter(ghost.position)) {
            // Get valid directions from current position
            const validDirections = GameUtils.getValidDirections(ghost.position);

            // Ghost AI: prefer to move toward Pacman, but with some randomness
            let newDirection = ghost.direction;

            // Don't allow ghosts to reverse direction unless it's the only option
            const nonReverseDirections = validDirections.filter(
              (dir) => !dir.equals(ghost.direction.clone().negate()),
            );

            const availableDirections =
              nonReverseDirections.length > 0 ? nonReverseDirections : validDirections;

            if (availableDirections.length > 0) {
              if (gameState.ghostsScared) {
                // When scared, move randomly
                newDirection =
                  availableDirections[Math.floor(Math.random() * availableDirections.length)]!;
              } else {
                // Simple chase algorithm: 70% chance to move toward Pacman, 30% random
                if (Math.random() < 0.7) {
                  // Calculate direction that gets us closer to Pacman
                  const ghostGrid = GameUtils.snapToGrid(ghost.position);
                  const pacmanGrid = GameUtils.snapToGrid(pacmanPosition);

                  // Calculate which directions reduce distance to Pacman
                  const goodDirections = availableDirections.filter((dir) => {
                    const nextPos = ghostGrid.clone().add(dir);
                    const currentDist = ghostGrid.distanceTo(pacmanGrid);
                    const nextDist = nextPos.distanceTo(pacmanGrid);
                    return nextDist < currentDist;
                  });

                  // Choose from good directions, or any available if none are good
                  if (goodDirections.length > 0) {
                    newDirection =
                      goodDirections[Math.floor(Math.random() * goodDirections.length)]!;
                  } else {
                    newDirection =
                      availableDirections[Math.floor(Math.random() * availableDirections.length)]!;
                  }
                } else {
                  // Random movement for unpredictability
                  newDirection =
                    availableDirections[Math.floor(Math.random() * availableDirections.length)]!;
                }
              }
            }

            // Update ghost direction
            ghost = { ...ghost, direction: newDirection };
          }

          // Move ghost in its current direction
          const speed = gameState.ghostsScared
            ? CONSTANTS.SCARED_GHOST_SPEED
            : CONSTANTS.GHOST_SPEED;
          const moveDistance = speed * delta;
          const newPosition = ghost.position
            .clone()
            .add(ghost.direction.clone().multiplyScalar(moveDistance));

          // Check if we'd overshoot the next grid cell
          const targetGridPos = GameUtils.snapToGrid(ghost.position.clone().add(ghost.direction));
          const distToTarget = ghost.position.distanceTo(targetGridPos);

          if (moveDistance > distToTarget) {
            // Snap to the grid cell if we'd overshoot
            return { ...ghost, position: targetGridPos };
          } else {
            // Regular movement
            return { ...ghost, position: newPosition };
          }
        });
      });
    },
    [pacmanPosition, gameState.ghostsScared],
  );

  /**
   * Take a single step in the current direction
   */
  const takeStep = useCallback(() => {
    if (gameState.gameOver || isMoving) return;

    let pacmanIsMoving = true;

    // Calculate the next cell position in the current direction
    const nextPos = pacmanPosition.clone().add(direction);
    const nextGridX = Math.round(nextPos.x);
    const nextGridZ = Math.round(nextPos.z);

    // Check if we can continue in the current direction
    if (!GameUtils.isValidMove(nextGridX, nextGridZ)) {
      pacmanIsMoving = false;
    }

    // Start movement animation to the next grid cell
    if (pacmanIsMoving && !direction.equals(DIRECTIONS.NONE)) {
      // Set target position to the next grid cell
      const nextGridPos = GameUtils.snapToGrid(pacmanPosition.clone().add(direction));

      setTargetPosition(nextGridPos);
      setIsMoving(true);
    }
  }, [pacmanPosition, direction, gameState.gameOver, isMoving]);

  /**
   * Animation and game loop
   */
  useFrame((_, delta) => {
    if (gameState.gameOver) return;

    // Check if we need to take a step based on mouth change
    if (requestStepRef.current) {
      requestStepRef.current = false;
      takeStep();
    }

    // Handle smooth movement animation
    if (isMoving) {
      // Calculate how much to move this frame
      const step = animationSpeed.current * delta;

      // Get direction to target
      const moveDirection = targetPosition.clone().sub(pacmanPosition).normalize();

      // Calculate new position
      const newPosition = pacmanPosition.clone().add(moveDirection.multiplyScalar(step));

      // Check if we've reached or passed the target
      const distanceToTarget = pacmanPosition.distanceTo(targetPosition);
      const distanceMoved = pacmanPosition.distanceTo(newPosition);

      if (distanceMoved >= distanceToTarget) {
        // We've reached the target, snap to it exactly
        setPacmanPosition(targetPosition.clone());
        setIsMoving(false);

        // Check for pellet collection and ghost collisions at the target position
        checkPelletCollection(targetPosition, CONSTANTS.PELLET_COLLECTION_RADIUS);
        checkGhostCollisions(targetPosition, CONSTANTS.GHOST_COLLISION_RADIUS);
      } else {
        // Continue moving toward target
        setPacmanPosition(newPosition);

        // Check for pellet collection and ghost collisions during movement
        checkPelletCollection(newPosition, CONSTANTS.PELLET_COLLECTION_RADIUS);
        checkGhostCollisions(newPosition, CONSTANTS.GHOST_COLLISION_RADIUS);
      }
    }

    // Clamp delta to prevent jumps on frame drops
    const clampedDelta = Math.min(delta, 0.1);

    // GHOST MOVEMENT - Always run, regardless of Pacman's state
    moveGhostsOnGrid(clampedDelta);
  });

  // Calculate map offset for camera positioning
  const mapOffset: [number, number, number] = [-MAP[0].length / 2, 0, -MAP.length / 2];

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={1.0} />

      {/* Game board */}
      <group position={mapOffset}>
        {/* Walls */}
        {walls.map((position, index) => (
          <Wall key={`wall-${index}`} position={position} />
        ))}

        {/* Floor */}
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[MAP[0].length / 2, -0.5, MAP.length / 2]}
          receiveShadow
        >
          <planeGeometry args={[MAP[0].length, MAP.length]} />
          <meshStandardMaterial color="#111111" />
        </mesh>

        {/* Pellets */}
        {pellets.map(
          (pellet) =>
            !pellet.collected && (
              <Pellet
                key={pellet.id}
                position={pellet.position}
                isPowerPellet={pellet.isPowerPellet}
              />
            ),
        )}

        {/* Pacman */}
        <PacMan position={pacmanPosition} direction={direction} isMoving={isMoving} />

        {/* Ghosts */}
        {ghosts.map((ghost) => (
          <Ghost
            key={ghost.id}
            position={ghost.position}
            color={ghost.color}
            scared={gameState.ghostsScared}
          />
        ))}
      </group>

      {/* Camera for first-person view */}
      <PacmanCamera
        position={pacmanPosition}
        direction={direction}
        mapOffset={mapOffset}
        shifKeyPressed={shiftKeyPressed}
      />
    </>
  );
};

/**
 * Main Pacman component with camera control
 */
const Pacman: FC = () => {
  const gameRef = useRef<{
    handleKeyDown?: (e: KeyboardEvent | { key: string }) => void;
  }>({});
  const [isMouthOpen, setIsMouthOpen] = useState<boolean>(false);
  const [shiftKeyPressed, setShiftKeyPressed] = useState<boolean>(false);
  const previousMouthStateRef = useRef<boolean>(false);
  const requestStepRef = useRef<boolean>(false);

  // Handle mouth state changes
  const handleMouthChange = useCallback((open: boolean) => {
    // Store current mouth state to detect transitions
    const wasMouthOpen = previousMouthStateRef.current;

    // Update previous state for next comparison
    previousMouthStateRef.current = open;

    // Request a step when mouth state changes from closed to open
    if (open && !wasMouthOpen) {
      requestStepRef.current = true;
    }

    // Update state
    setIsMouthOpen(open);
  }, []); // Removed isMouthOpen dependency since we're using refs for comparison

  // Handle shift key press for camera flip
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        setShiftKeyPressed(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        setShiftKeyPressed(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const onHeadTurnLeft = useCallback(() => {
    gameRef.current.handleKeyDown?.({ key: "ArrowLeft" });
  }, []);

  const onHeadTurnRight = useCallback(() => {
    gameRef.current.handleKeyDown?.({ key: "ArrowRight" });
  }, []);

  return (
    <div className="bg-background text-foreground relative h-dvh w-dvw bg-[url('https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/bg.png')] bg-[size:10px] font-sans antialiased">
      <FaceDetection
        onMouthChange={handleMouthChange}
        onHeadTurnLeft={onHeadTurnLeft}
        onHeadTurnRight={onHeadTurnRight}
      />
      <Canvas shadows>
        <Game gameRef={gameRef} requestStepRef={requestStepRef} shiftKeyPressed={shiftKeyPressed} />
      </Canvas>
    </div>
  );
};

export default Pacman;
