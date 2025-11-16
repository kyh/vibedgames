import { useEffect, useRef } from "react";

import type { Player } from "@repo/multiplayer";
import { useRealtimeGame } from "@repo/multiplayer";

import { Background } from "./Background";

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
  return (
    typeof candidate.x === "number" && typeof candidate.y === "number"
  );
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

  const createShipFromPlayer = (player: DemoPlayer): Ship => {
    const ship = createShip(player.position.x, player.position.y, 8, player.id);
    ship.color = player.color ?? "rgb(255, 255, 255)";
    ship.hue = player.hue ?? "rgb(200, 200, 200)";
    ship.targetPosition = { ...ship.position };
    return ship;
  };

  const game = useRealtimeGame<PlayerGameState, PlayerActionPayload>({
    host: HOST,
    party: PARTY,
    room: ROOM,
    autoTrackCursor: true,
    tickRate: 20,
    interpolation: false,
    onPlayerMoved: (playerId, position) => {
      const ship = shipsRef.current[playerId];
      if (!ship) return;

      ship.targetPosition = position;

      const dx = position.x - ship.position.x;
      const dy = position.y - ship.position.y;
      if (dx !== 0 || dy !== 0) {
        ship.angle = Math.atan2(dy, dx);
      }
    },
    onPlayerJoined: (player) => {
      const position = extractPlayerPosition(player);
      shipsRef.current[player.id] ??= createShipFromPlayer({
        id: player.id,
        position: position ?? getRandomPosition(),
        color: player.color,
        hue: player.hue,
      });
      updatePlayerCounter();
    },
    onPlayerLeft: (playerId) => {
      delete shipsRef.current[playerId];
      updatePlayerCounter();
    },
    onPlayersSync: (positions, allPlayers) => {
      const playerPositions = positions as Record<string, Point | undefined>;
      const players = allPlayers as Record<string, Player> | undefined;

      for (const [id, position] of Object.entries(playerPositions)) {
        if (position === undefined) {
          continue;
        }

        if (shipsRef.current[id] !== undefined) {
          continue;
        }

        const player = players?.[id] ?? game.getPlayerById(id);
        if (player) {
          shipsRef.current[id] = createShipFromPlayer({
            id: player.id,
            position,
            color: player.color,
            hue: player.hue,
          });
        }
      }

      if (players !== undefined) {
        for (const [id, player] of Object.entries(players)) {
          if (shipsRef.current[id] !== undefined) {
            continue;
          }

          if (id === game.playerId) {
            continue;
          }

          shipsRef.current[id] = createShipFromPlayer({
            id: player.id,
            position: getRandomPosition(),
            color: player.color,
            hue: player.hue,
          });
        }
      }

      updatePlayerCounter();
    },
  });

  function updatePlayerCounter() {
    const playerCountElement = document.getElementById("player-count");
    const playerIdElement = document.getElementById("player-id");

    if (playerCountElement) {
      playerCountElement.textContent = game.getPlayerCount().toString();
    }

    if (playerIdElement && game.playerId) {
      playerIdElement.textContent = game.playerId;
    }
  }

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
        const currentPos = game.getCurrentPosition();
        const updatedShip = updateShipPosition(myShipRef.current, currentPos);
        myShipRef.current = updateShipPath(updatedShip);
        drawShip(context, myShipRef.current);
      }

      Object.values(shipsRef.current).forEach((ship) => {
        if (!ship?.id) return;

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
  }, [game]);

  return <canvas ref={canvasRef} className="game-canvas" />;
};


export default App;
