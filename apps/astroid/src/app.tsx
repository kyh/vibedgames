import { useEffect, useMemo, useRef } from "react";
import { useMultiplayerRoom, usePlayerState } from "@repo/multiplayer";

import type { Player } from "@repo/multiplayer";
import { Background } from "./background";

const App = () => {
  return (
    <section className="app-container">
      <DemoGame />
      <Background />
    </section>
  );
};

type Point = {
  x: number;
  y: number;
};

const getRandomPosition = (): Point => ({
  x: Math.random() * window.innerWidth,
  y: Math.random() * window.innerHeight,
});

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

type AstroidPlayer = {
  id: string;
  position: Point;
  color?: string;
  hue?: string;
};

const SHIP_SPEED = 2;
const PI = Math.PI;
const DEG_TO_RAD = PI / 180;

const HOST =
  import.meta.env.MODE === "development"
    ? "http://localhost:8787"
    : "https://vg-partyserver.kyh.workers.dev";
const PARTY = "vg-server";
const ROOM = "home";

const createPoint = (x: number | Point = 0, y = 0): Point => {
  if (typeof x === "number") {
    return { x, y };
  }

  return { x: x.x, y: x.y };
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
    color: "rgb(255, 255, 255)",
    hue: "rgb(200, 200, 200)",
    targetPosition: { ...position },
  };
};

const updateShipPosition = (
  ship: Ship,
  target: Point,
  speed: number = SHIP_SPEED,
): Ship => {
  const newShip: Ship = {
    ...ship,
    lastPosition: { ...ship.position },
  };

  const v = subPoints(target, ship.position);
  const vlen = pointLength(v);

  newShip.angle = pointAngle(v);

  const velocity = vlen > speed ? normalizePoint(v, speed) : v;

  if (vlen > ship.size / 2) {
    newShip.position = addPoints(ship.position, velocity);
  }

  return newShip;
};

const updateShipPath = (ship: Ship): Ship => {
  const newShip: Ship = { ...ship };

  const referencePoints: Point[] = [];
  const angles = [0, 140, 180, 220];

  angles.forEach((deg, i) => {
    const angle = DEG_TO_RAD * deg;
    const radius = i === 2 ? ship.size / 2 : ship.size;
    referencePoints.push(polarToPoint(radius, angle));
  });

  const cos = Math.cos(ship.angle);
  const sin = Math.sin(ship.angle);

  newShip.path = referencePoints.map((rp) => ({
    x: ship.position.x + rp.x * cos - rp.y * sin,
    y: ship.position.y + rp.x * sin + rp.y * cos,
  }));

  return newShip;
};

const drawShip = (ctx: CanvasRenderingContext2D, ship: Ship) => {
  if (ship.path.length === 0) return;

  ctx.beginPath();
  ctx.strokeStyle = ship.color;
  ctx.lineWidth = 1;

  const [firstPoint, ...rest] = ship.path;

  ctx.moveTo(firstPoint.x, firstPoint.y);

  rest.forEach((point) => {
    ctx.lineTo(point.x, point.y);
  });

  ctx.lineTo(firstPoint.x, firstPoint.y);
  ctx.stroke();
};

const isPoint = (value: unknown): value is Point => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.x === "number" && typeof candidate.y === "number";
};

const extractPlayerPosition = (player?: Player): Point | undefined => {
  const state = player?.state;
  if (typeof state !== "object" || state === null) return undefined;

  const maybePosition = (state as Record<string, unknown>).position;
  if (isPoint(maybePosition)) {
    return { x: maybePosition.x, y: maybePosition.y };
  }

  return undefined;
};

const DemoGame = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shipsRef = useRef<Record<string, Ship | undefined>>({});
  const myShipRef = useRef<Ship | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const room = useMultiplayerRoom({
    host: HOST,
    party: PARTY,
    room: ROOM,
  });

  const [playerState, setPlayerState] = usePlayerState(room, {
    position: useMemo(() => getRandomPosition(), []),
    pointer: "mouse" as const,
  });

  const createShipFromPlayer = (player: AstroidPlayer): Ship => {
    const ship = createShip(player.position.x, player.position.y, 8, player.id);
    ship.color = player.color ?? "rgb(255, 255, 255)";
    ship.hue = player.hue ?? "rgb(200, 200, 200)";
    ship.targetPosition = { ...ship.position };
    return ship;
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      setPlayerState({
        position: { x: event.clientX, y: event.clientY },
        pointer: event.pointerType === "touch" ? "touch" : "mouse",
      });
    };

    window.addEventListener("pointermove", handlePointerMove);
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [setPlayerState]);

  function updatePlayerCounter() {
    const playerCountElement = document.getElementById("player-count");
    const playerIdElement = document.getElementById("player-id");

    if (playerCountElement) {
      playerCountElement.textContent = Object.keys(room.players).length.toString();
    }

    if (playerIdElement && room.playerId) {
      playerIdElement.textContent = room.playerId;
    }
  }

  useEffect(() => {
    if (
      room.connectionStatus === "connected" &&
      !myShipRef.current &&
      room.playerId
    ) {
      myShipRef.current = createShip(
        window.innerWidth / 2,
        window.innerHeight / 2,
        8,
        room.playerId,
      );
    }
  }, [room.connectionStatus, room.playerId]);

  useEffect(() => {
    const players = room.players;
    Object.entries(players).forEach(([id, player]) => {
      if (id === room.playerId) return;
      if (shipsRef.current[id]) return;

      const position = extractPlayerPosition(player);
      shipsRef.current[id] = createShipFromPlayer({
        id,
        position: position ?? getRandomPosition(),
        color: player.color,
        hue: player.hue,
      });
    });

    Object.keys(shipsRef.current).forEach((id) => {
      if (id === room.playerId) return;
      if (!players[id]) {
        delete shipsRef.current[id];
      }
    });

    updatePlayerCounter();
  }, [room.players, room.playerId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    const gameLoop = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);

      if (myShipRef.current) {
        const currentPos = playerState.position ?? myShipRef.current.position;
        const updatedShip = updateShipPosition(myShipRef.current, currentPos);
        myShipRef.current = updateShipPath(updatedShip);
        drawShip(context, myShipRef.current);
      }

      Object.values(shipsRef.current).forEach((ship) => {
        if (!ship?.id) return;

        const player = room.players[ship.id];
        const playerPosition = extractPlayerPosition(player);
        if (playerPosition) {
          ship.targetPosition = playerPosition;
        }

        const updatedShip = updateShipPosition(
          ship,
          ship.targetPosition,
          SHIP_SPEED * 0.8,
        );
        const finalShip = updateShipPath(updatedShip);
        shipsRef.current[ship.id] = finalShip;
        drawShip(context, finalShip);
      });

      animationFrameRef.current = requestAnimationFrame(gameLoop);
    };

    window.addEventListener("resize", handleResize);
    animationFrameRef.current = requestAnimationFrame(gameLoop);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [playerState.position, room.players]);

  return <canvas ref={canvasRef} className="game-canvas" />;
};

export default App;
