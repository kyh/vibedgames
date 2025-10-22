"use client";

import { useEffect, useRef } from "react";
import { useRealtimeGame } from "@repo/multiplayer";

import { Background } from "./_components/background";

const Page = () => {
  return (
    <section className="bg-background h-dvh w-dvw bg-[url('https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/bg.png')] bg-[size:10px]">
      <DemoGame />
      <Background />
    </section>
  );
};

type Point = {
  x: number;
  y: number;
};

type Ship = {
  id: string | null;
  position: Point;
  size: number;
  path: Point[];
  referencePath: Point[];
  angle: number;
  velocity: Point;
  lastPosition: Point;
  color: string;
  hue: string;
  targetPosition: Point;
};

type PlayerGameState = {
  position: Point;
  pointer?: "mouse" | "touch";
};

type PlayerActionPayload = {
  action: string;
  data: unknown;
};

type DemoPlayer = {
  id: string;
  position: Point;
  color?: string;
  hue?: string;
};

const SHIP_SPEED = 2;
const PI = Math.PI;
const DEG_TO_RAD = PI / 180;

const HOST =
  process.env.NODE_ENV === "development"
    ? "http://localhost:8787"
    : "https://vg-partyserver.kyh.workers.dev";
const PARTY = "vg-server";
const ROOM = "home";

const DemoGame = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shipsRef = useRef<Record<string, Ship>>({});
  const myShipRef = useRef<Ship | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Use the realtime game hook with cursor tracking
  const game = useRealtimeGame<PlayerGameState, PlayerActionPayload>({
    host: HOST,
    party: PARTY,
    room: ROOM,
    autoTrackCursor: true, // Automatically track cursor movement
    tickRate: 20, // Smooth cursor updates
    interpolation: false, // Direct cursor positioning
    onPlayerMoved: (playerId, position) => {
      // Update ship position when player moves
      if (shipsRef.current[playerId]) {
        const ship = shipsRef.current[playerId];
        ship.targetPosition = position;

        // Calculate direction for ship rotation
        const dx = position.x - ship.position.x;
        const dy = position.y - ship.position.y;
        if (dx !== 0 || dy !== 0) {
          ship.angle = Math.atan2(dy, dx);
        }
      }
    },
    onPlayerJoined: (player) => {
      const position = (player.state as any)?.position;

      // Create ship for new player even if they don't have a position yet
      if (!shipsRef.current[player.id]) {
        const defaultPosition = position || {
          x: Math.random() * window.innerWidth,
          y: Math.random() * window.innerHeight,
        };

        shipsRef.current[player.id] = createShipFromPlayer({
          id: player.id,
          position: defaultPosition,
          color: player.color,
          hue: player.hue,
        });
      }
      updatePlayerCounter();
    },
    onPlayerLeft: (playerId) => {
      delete shipsRef.current[playerId];
      updatePlayerCounter();
    },
    onPlayersSync: (positions, allPlayers) => {
      // Initialize ships for all existing players with positions
      Object.entries(positions).forEach(([id, position]) => {
        if (position && !shipsRef.current[id]) {
          const player = allPlayers?.[id] || game.getPlayerById(id);
          if (player) {
            shipsRef.current[id] = createShipFromPlayer({
              id: player.id,
              position,
              color: player.color,
              hue: player.hue,
            });
          }
        }
      });

      // Create ships for ALL players that we don't have ships for yet (including those without positions)
      if (allPlayers) {
        Object.entries(allPlayers).forEach(([id, player]) => {
          if (!shipsRef.current[id] && id !== game.playerId) {
            const defaultPosition = {
              x: Math.random() * window.innerWidth,
              y: Math.random() * window.innerHeight,
            };

            shipsRef.current[id] = createShipFromPlayer({
              id: player.id,
              position: defaultPosition,
              color: player.color,
              hue: player.hue,
            });
          }
        });
      }
      updatePlayerCounter();
    },
  });

  // Initialize my ship
  useEffect(() => {
    if (game.isConnected && !myShipRef.current) {
      myShipRef.current = createShip(
        window.innerWidth / 2,
        window.innerHeight / 2,
        8,
        game.playerId,
      );
    }
  }, [game.isConnected, game.playerId]);

  // Create a ship from player data received from server
  const createShipFromPlayer = (player: DemoPlayer): Ship => {
    const ship = createShip(player.position.x, player.position.y, 8, player.id);

    // Add color information from the server
    ship.color = player.color || "rgb(255, 255, 255)";
    ship.hue = player.hue || "rgb(200, 200, 200)";

    // Add target position for smooth movement
    ship.targetPosition = { ...ship.position };

    return ship;
  };

  // Utility functions
  const createPoint = (x: number | Point = 0, y = 0): Point => {
    if (typeof x === "object" && x !== null) {
      return { x: x.x || 0, y: x.y || 0 };
    }
    return { x: x || 0, y: y || 0 };
  };

  const addPoints = (p1: Point, p2: Point): Point => ({
    x: p1.x + p2.x,
    y: p1.y + p2.y,
  });
  const subPoints = (p1: Point, p2: Point): Point => ({
    x: p1.x - p2.x,
    y: p1.y - p2.y,
  });
  const pointLength = (p: Point): number => Math.sqrt(p.x * p.x + p.y * p.y);

  const normalizePoint = (p: Point, thickness = 1): Point => {
    const len = pointLength(p);
    if (len === 0) return { x: 0, y: 0 };
    return {
      x: (p.x / len) * thickness,
      y: (p.y / len) * thickness,
    };
  };

  const pointAngle = (p: Point): number => Math.atan2(p.y, p.x);

  const polarToPoint = (length: number, angle: number): Point => ({
    x: length * Math.cos(angle),
    y: length * Math.sin(angle),
  });

  const createShip = (
    x: number,
    y: number,
    size: number,
    id: string | null = null,
  ): Ship => {
    const position = createPoint(x, y);
    const path: Point[] = [];
    const referencePath: Point[] = [];

    // Create hull drawing points
    const angles = [0, 140, 180, 220];

    angles.forEach((deg, i) => {
      const angle = DEG_TO_RAD * deg;
      const radius = i === 2 ? size / 2 : size;
      const point = addPoints(position, polarToPoint(radius, angle));
      path.push({ ...point });
      referencePath.push({ ...point });
    });

    return {
      id,
      position,
      size,
      path,
      referencePath,
      angle: 0,
      velocity: { x: 0, y: 0 },
      lastPosition: { ...position },
      color: "rgb(255, 255, 255)", // Default color
      hue: "rgb(200, 200, 200)", // Default hue
      targetPosition: { ...position }, // For smooth movement
    };
  };

  const updateShipPosition = (
    ship: Ship,
    target: Point,
    speed: number = SHIP_SPEED,
  ): Ship => {
    // Create a new ship object to maintain immutability
    const newShip: Ship = {
      ...ship,
      lastPosition: { ...ship.position },
    };

    // Calculate direction vector
    const v = subPoints(target, ship.position);
    const vlen = pointLength(v);

    // Update angle to face the direction of movement
    newShip.angle = pointAngle(v);

    // Normalize velocity if needed
    const velocity = vlen > speed ? normalizePoint(v, speed) : v;

    // Update position if far enough from target
    if (vlen > ship.size / 2) {
      newShip.position = addPoints(ship.position, velocity);
    }

    return newShip;
  };

  const updateShipPath = (ship: Ship): Ship => {
    // Create hull drawing points based on ship's current angle
    const newShip: Ship = { ...ship };

    // Create reference path (points in local space)
    const referencePoints: Point[] = [];
    const angles = [0, 140, 180, 220];

    angles.forEach((deg, i) => {
      const angle = DEG_TO_RAD * deg;
      const radius = i === 2 ? ship.size / 2 : ship.size;
      referencePoints.push(polarToPoint(radius, angle));
    });

    // Rotate and position the path points
    const cos = Math.cos(ship.angle);
    const sin = Math.sin(ship.angle);

    newShip.path = referencePoints.map((rp) => ({
      x: ship.position.x + rp.x * cos - rp.y * sin,
      y: ship.position.y + rp.x * sin + rp.y * cos,
    }));

    return newShip;
  };

  const drawShip = (ctx: CanvasRenderingContext2D, ship: Ship) => {
    if (ship?.path?.length === 0) return;

    ctx.beginPath();
    ctx.strokeStyle = ship.color || "rgb(255, 255, 255)";
    ctx.lineWidth = 1;

    ctx.moveTo(ship.path[0]?.x ?? 0, ship.path[0]?.y ?? 0);

    for (let i = 1; i < ship.path.length; i++) {
      ctx.lineTo(ship.path[i]?.x ?? 0, ship.path[i]?.y ?? 0);
    }

    ctx.lineTo(ship.path[0]?.x ?? 0, ship.path[0]?.y ?? 0);
    ctx.stroke();
  };

  const updatePlayerCounter = () => {
    const playerCountElement = document.getElementById("player-count");
    const playerIdElement = document.getElementById("player-id");

    if (playerCountElement) {
      playerCountElement.textContent = game.getPlayerCount().toString();
    }

    if (playerIdElement && game.playerId) {
      playerIdElement.textContent = game.playerId;
    }
  };

  // Initialize the game
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    // Set initial canvas dimensions
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Handle window resize
    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    // Mouse/touch handling is now done by the hook automatically
    // No need for manual event listeners since autoTrackCursor is enabled

    // Game loop
    const gameLoop = () => {
      if (!context) return;

      // Clear canvas
      context.clearRect(0, 0, canvas.width, canvas.height);

      // Update and draw my ship
      if (myShipRef.current) {
        const currentPos = game.getCurrentPosition();
        const updatedShip = updateShipPosition(myShipRef.current, currentPos);
        myShipRef.current = updateShipPath(updatedShip);
        drawShip(context, myShipRef.current);
      }

      // Update and draw other ships
      Object.values(shipsRef.current).forEach((ship) => {
        const updatedShip = updateShipPosition(
          ship,
          ship.targetPosition,
          SHIP_SPEED * 0.8,
        );
        const finalShip = updateShipPath(updatedShip);
        shipsRef.current[ship.id!] = finalShip;
        drawShip(context, finalShip);
      });

      animationFrameRef.current = requestAnimationFrame(gameLoop);
    };

    // Add event listeners
    window.addEventListener("resize", handleResize);

    // Start game loop
    animationFrameRef.current = requestAnimationFrame(gameLoop);

    // Cleanup function
    return () => {
      window.removeEventListener("resize", handleResize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [game]);

  return <canvas ref={canvasRef} className="game" />;
};

export default Page;
