import type {
  Asteroid,
  Beam,
  Camera,
  Item,
  Point,
  Ship,
  Splinter,
  UFO,
  SerializedBeam,
} from "./types";
import { WORLD_WIDTH, WORLD_HEIGHT } from "./constants";
import {
  drawShip,
  drawAsteroid,
  drawBeam,
  drawUFO,
  drawItem,
  drawSplinters,
} from "./entities";
import type { StarField } from "./stars";
import { drawStarField } from "./stars";

type RenderState = {
  camera: Camera;
  myShip: Ship | null;
  myBeams: Beam[];
  myColor: string;
  myInvulnerable: boolean;
  /** Other players: id -> { path, color, beams, alive } */
  otherPlayers: Array<{
    path: Point[];
    color: string;
    alive: boolean;
    invulnerable: boolean;
    beams: SerializedBeam[];
  }>;
  asteroids: Asteroid[];
  ufo: UFO | null;
  items: Item[];
  splinters: Splinter[];
  starField: StarField;
};

/**
 * Draw the entire game state onto the canvas.
 * Translates by camera offset so the player's ship appears centered.
 */
export function render(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: RenderState,
) {
  ctx.clearRect(0, 0, width, height);
  ctx.save();

  // Camera transform: offset so player is centered
  ctx.translate(-state.camera.x, -state.camera.y);

  ctx.strokeStyle = "rgb(255, 255, 255)";
  ctx.fillStyle = "rgb(255, 255, 255)";
  ctx.lineWidth = 1;

  // Stars (behind everything)
  drawStarField(ctx, state.starField);

  // Asteroids
  ctx.beginPath();
  ctx.strokeStyle = "rgb(255, 255, 255)";
  ctx.lineWidth = 1;
  for (const a of state.asteroids) {
    drawAsteroid(ctx, a);
  }
  ctx.stroke();

  // UFO
  if (state.ufo) {
    ctx.strokeStyle = "rgb(255, 255, 255)";
    ctx.lineWidth = 1;
    drawUFO(ctx, state.ufo);
  }

  // Items
  for (const item of state.items) {
    drawItem(ctx, item);
  }

  // Other players
  for (const p of state.otherPlayers) {
    if (!p.alive) continue;
    const alpha = p.invulnerable ? 0.3 : 1;
    drawShip(ctx, p.path, p.color, alpha);

    // Other players' beams
    for (const sb of p.beams) {
      ctx.beginPath();
      ctx.strokeStyle = sb.color;
      ctx.lineWidth = sb.width;
      if (sb.exploding) {
        ctx.arc(sb.hx, sb.hy, sb.explosionRadius, 0, Math.PI * 2);
      } else {
        ctx.moveTo(sb.tx, sb.ty);
        ctx.lineTo(sb.hx, sb.hy);
      }
      ctx.stroke();
    }
  }

  // My beams
  for (const b of state.myBeams) {
    drawBeam(ctx, b);
  }

  // My ship
  if (state.myShip?.alive) {
    const alpha = state.myInvulnerable ? (Date.now() % 200 < 100 ? 0.3 : 0.9) : 1;
    drawShip(ctx, state.myShip.path, state.myColor, alpha);
  }

  // Splinters
  drawSplinters(ctx, state.splinters);

  // Black mask outside world bounds
  ctx.fillStyle = "#020617";
  const m = 10000; // large enough to cover any viewport
  ctx.fillRect(-m, -m, m + WORLD_WIDTH + m, m);               // top
  ctx.fillRect(-m, WORLD_HEIGHT, m + WORLD_WIDTH + m, m);     // bottom
  ctx.fillRect(-m, 0, m, WORLD_HEIGHT);                        // left
  ctx.fillRect(WORLD_WIDTH, 0, m, WORLD_HEIGHT);               // right

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------

export type MinimapDot = {
  x: number;
  y: number;
  color: string;
  isMe: boolean;
};

export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  size: number,
  dots: MinimapDot[],
  asteroids: Asteroid[],
) {
  const sx = size / WORLD_WIDTH;
  const sy = size / WORLD_HEIGHT;

  // Background
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(0, 0, size, size * (WORLD_HEIGHT / WORLD_WIDTH));

  // Asteroids as dim dots
  ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
  for (const a of asteroids) {
    const r = Math.max(1, a.radius * sx * 0.3);
    ctx.beginPath();
    ctx.arc(a.position.x * sx, a.position.y * sy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Player dots
  for (const dot of dots) {
    ctx.fillStyle = dot.color;
    ctx.beginPath();
    const r = dot.isMe ? 3 : 2;
    ctx.arc(dot.x * sx, dot.y * sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}
