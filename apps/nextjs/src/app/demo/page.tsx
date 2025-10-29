"use client";

import { useEffect, useRef } from "react";
import { MultiplayerProvider, usePlayerState, usePlayers } from "@repo/multiplayer";
import type { Player } from "@repo/multiplayer";

import { Background } from "@/app/(home)/_components/background";

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

type CursorState = {
  position: Point | null;
  pointer?: "mouse" | "touch" | "pen" | "unknown";
};

type MultiplayerPlayer = Player<CursorState>;

const SHIP_SPEED = 2;
const DEG_TO_RAD = Math.PI / 180;

const HOST =
  process.env.NODE_ENV === "development"
    ? "http://localhost:8787"
    : "https://vg-partyserver.kyh.workers.dev";
const PARTY = "vg-server";
const ROOM = "home";

const INITIAL_PLAYER_STATE: CursorState = {
  position: null,
  pointer: "unknown",
};

const Page = () => {
  return (
    <>
      <MultiplayerProvider
        host={HOST}
        party={PARTY}
        room={ROOM}
        initialPlayerState={INITIAL_PLAYER_STATE}
      >
        <DemoGame />
      </MultiplayerProvider>
      <Background />
    </>
  );
};

const randomPosition = (): Point => {
  if (typeof window === "undefined") {
    return { x: 0, y: 0 };
  }

  return {
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
  };
};

const createPoint = (x: number | Point = 0, y = 0): Point => {
  if (typeof x === "object") {
    return { x: x.x, y: x.y };
  }

  return { x, y };
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

  const initialPosition = { ...position };

  return {
    id,
    position,
    size,
    path,
    referencePath,
    angle: 0,
    velocity: { x: 0, y: 0 },
    lastPosition: initialPosition,
    color: "rgb(255, 255, 255)",
    hue: "rgb(200, 200, 200)",
    targetPosition: initialPosition,
  };
};

const createShipFromPlayer = (
  player: MultiplayerPlayer,
  fallbackPosition?: Point,
): Ship => {
  const basePosition = fallbackPosition ?? randomPosition();
  const ship = createShip(basePosition.x, basePosition.y, 8, player.id);

  ship.color = player.color ?? ship.color;
  ship.hue = player.hue ?? ship.hue;
  ship.targetPosition = { ...basePosition };

  return ship;
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

  ctx.moveTo(ship.path[0].x, ship.path[0].y);

  for (let i = 1; i < ship.path.length; i++) {
    ctx.lineTo(ship.path[i].x, ship.path[i].y);
  }

  ctx.lineTo(ship.path[0].x, ship.path[0].y);
  ctx.stroke();
};

const DemoGame = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shipsRef = useRef<Record<string, Ship>>({});
  const myShipRef = useRef<Ship | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const hasInitialisedRef = useRef(false);

  const [playerState, setPlayerState, self] = usePlayerState<CursorState>();
  const players = usePlayers<CursorState>();

  useEffect(() => {
    if (!self?.id || hasInitialisedRef.current) return;
    if (typeof window === "undefined") return;

    hasInitialisedRef.current = true;
    const startPosition = randomPosition();

    setPlayerState({
      position: startPosition,
      pointer: "mouse",
    });
  }, [self?.id, setPlayerState]);

  useEffect(() => {
    if (!self?.id) return;
    if (typeof window === "undefined") return;

    const myShip = myShipRef.current ??
      createShip(
        playerState.position?.x ?? window.innerWidth / 2,
        playerState.position?.y ?? window.innerHeight / 2,
        8,
        self.id,
      );

    myShip.color = self.color ?? myShip.color;
    myShip.hue = self.hue ?? myShip.hue;
    myShip.targetPosition = playerState.position
      ? { ...playerState.position }
      : myShip.targetPosition;

    myShipRef.current = myShip;
  }, [playerState.position, self?.color, self?.hue, self?.id]);

  useEffect(() => {
    const selfId = self?.id;

    const remotePlayers = players.filter((entry) => entry.id !== selfId);
    const remoteIds = new Set(remotePlayers.map((entry) => entry.id));

    Object.keys(shipsRef.current).forEach((id) => {
      if (!remoteIds.has(id)) {
        delete shipsRef.current[id];
      }
    });

    remotePlayers.forEach((entry) => {
      const existing = shipsRef.current[entry.id];
      const fallbackPosition = entry.state.position ?? randomPosition();
      const ship = existing ?? createShipFromPlayer(entry, fallbackPosition);

      ship.color = entry.color ?? ship.color;
      ship.hue = entry.hue ?? ship.hue;

      if (entry.state.position) {
        ship.targetPosition = { ...entry.state.position };
      }

      shipsRef.current[entry.id] = ship;
    });
  }, [players, self?.id]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePointerMove = (event: PointerEvent) => {
      const pointerType =
        event.pointerType === "mouse" ||
        event.pointerType === "touch" ||
        event.pointerType === "pen"
          ? event.pointerType
          : "unknown";

      setPlayerState((prev) => ({
        ...prev,
        position: { x: event.clientX, y: event.clientY },
        pointer: pointerType,
      }));
    };

    const handlePointerLeave = () => {
      setPlayerState((prev) => ({
        ...prev,
        position: null,
      }));
    };

    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    window.addEventListener("pointerleave", handlePointerLeave);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, [setPlayerState]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const resizeCanvas = () => {
      if (typeof window === "undefined") return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    const gameLoop = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);

      if (myShipRef.current) {
        const updatedShip = updateShipPosition(
          myShipRef.current,
          myShipRef.current.targetPosition,
        );
        myShipRef.current = updateShipPath(updatedShip);
        drawShip(context, myShipRef.current);
      }

      Object.entries(shipsRef.current).forEach(([id, ship]) => {
        const updatedShip = updateShipPosition(
          ship,
          ship.targetPosition,
          SHIP_SPEED * 0.8,
        );
        const finalShip = updateShipPath(updatedShip);
        shipsRef.current[id] = finalShip;
        drawShip(context, finalShip);
      });

      animationFrameRef.current = requestAnimationFrame(gameLoop);
    };

    animationFrameRef.current = requestAnimationFrame(gameLoop);

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  return <canvas ref={canvasRef} className="game" />;
};

export default Page;
