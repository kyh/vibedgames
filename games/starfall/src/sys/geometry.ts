import { Math as PhaserMath } from "phaser";
import { MAGNET_RANGE, WORLD_H, WORLD_W } from "../shared/constants";
import type { Vec } from "../shared/constants";

/** Pure 2D geometry shared by the sim, hit tests and steering. */

export const DEG = Math.PI / 180;

export const inWorld = (x: number, y: number, margin: number, w = WORLD_W, h = WORLD_H): boolean =>
  x >= -margin && x <= w + margin && y >= -margin && y <= h + margin;

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

/** Closest-point distance from segment (x1,y1)→(x2,y2) to a circle. */
export const segHitsCircle = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cx: number,
  cy: number,
  r: number,
): boolean => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? PhaserMath.Clamp(((cx - x1) * dx + (cy - y1) * dy) / len2, 0, 1) : 0;
  return dist2(x1 + dx * t, y1 + dy * t, cx, cy) <= r * r;
};

/** Wrap an angle difference into [-π, π]. */
export const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Rotate `from` toward `to` by at most `maxStep` radians. */
export const rotateToward = (from: number, to: number, maxStep: number): number => {
  const diff = wrapAngle(to - from);
  return from + PhaserMath.Clamp(diff, -maxStep, maxStep);
};

export const nearestOf = (points: readonly Vec[], x: number, y: number): Vec | null => {
  let best: Vec | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = dist2(p.x, p.y, x, y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
};

/** Steer a drifting pickup toward its nearest magnet holder at pullSpeed
 *  while in range; once out of range settle it back to driftSpeed. */
export const magnetPull = (
  it: { x: number; y: number; vx: number; vy: number },
  holders: readonly Vec[],
  pullSpeed: number,
  driftSpeed: number,
): void => {
  const h = nearestOf(holders, it.x, it.y);
  if (!h) {
    return;
  }
  const d = Math.hypot(h.x - it.x, h.y - it.y);
  if (d <= MAGNET_RANGE && d > 1) {
    it.vx = ((h.x - it.x) / d) * pullSpeed;
    it.vy = ((h.y - it.y) / d) * pullSpeed;
    return;
  }
  const sp = Math.hypot(it.vx, it.vy);
  if (sp > driftSpeed + 1) {
    // Left the magnet's range: settle back to drift speed.
    it.vx = (it.vx / sp) * driftSpeed;
    it.vy = (it.vy / sp) * driftSpeed;
  }
};

/** The `count` players nearest to `from` (repeated-min select; no sort). */
export const nearestPlayers = (players: readonly Vec[], from: Vec, count: number): Vec[] => {
  const cands = players.map((p) => ({ d: dist2(p.x, p.y, from.x, from.y), x: p.x, y: p.y }));
  const picks: Vec[] = [];
  for (let k = 0; k < count && cands.length > 0; k += 1) {
    let bi = 0;
    for (let i = 1; i < cands.length; i += 1) {
      if ((cands[i]?.d ?? Infinity) < (cands[bi]?.d ?? Infinity)) {
        bi = i;
      }
    }
    const best = cands[bi];
    if (best) {
      picks.push({ x: best.x, y: best.y });
    }
    cands.splice(bi, 1);
  }
  return picks;
};
