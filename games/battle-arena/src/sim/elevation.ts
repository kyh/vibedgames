// Real walkable elevation — GAMEPLAY, so it lives in the sim and is the single
// source of truth (the renderer reads these constants to match). Deterministic,
// no RNG.
//
// The throne sits on a raised platform (a real level, == THRONE_RADIUS). Units
// can only step onto it through the STAIR gaps in its edge; everywhere else the
// edge is a wall you must go around. This gates the central objective behind the
// stairs — high ground you have to climb for.
import type { Vec2 } from "./math";

export const PLATEAU_R = 11; // plateau radius (== THRONE_RADIUS): inside is level 1
export const PLATEAU_H = 2.0; // visual height of the platform (renderer reads this)
export const STAIR_ANGLES = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
const STAIR_HALF = 0.18; // walkable stair-gap half-width (radians) — matches the visual gap

export function onPlateau(x: number, y: number): boolean {
  return x * x + y * y < PLATEAU_R * PLATEAU_R;
}

/** Whether a heading points through one of the stair gaps (crossing allowed). */
function inStairGap(ang: number): boolean {
  for (const s of STAIR_ANGLES) {
    const d = Math.atan2(Math.sin(ang - s), Math.cos(ang - s));
    if (Math.abs(d) < STAIR_HALF) return true;
  }
  return false;
}

/** Block a move that crosses the plateau edge unless it's through a stair gap.
 *  Off-gap crossings clamp radially to the edge (tangential motion kept, so the
 *  unit slides along the wall toward a stair). */
export function resolveElevation(fromX: number, fromY: number, toX: number, toY: number, radius: number): Vec2 {
  const fromIn = onPlateau(fromX, fromY);
  const toIn = onPlateau(toX, toY);
  if (fromIn === toIn) return { x: toX, y: toY }; // no level change
  if (inStairGap(Math.atan2(toY, toX))) return { x: toX, y: toY }; // climb/descend
  const r = Math.hypot(toX, toY) || 1;
  const target = fromIn ? PLATEAU_R - radius - 0.06 : PLATEAU_R + radius + 0.06;
  const s = target / r;
  return { x: toX * s, y: toY * s };
}

/** A waypoint just outside the nearest stair gap — bots steer here to reach the
 *  plateau instead of grinding the wall. */
export function nearestStair(x: number, y: number): Vec2 {
  const ang = Math.atan2(y, x);
  let best = STAIR_ANGLES[0]!;
  let bestD = Infinity;
  for (const s of STAIR_ANGLES) {
    const d = Math.abs(Math.atan2(Math.sin(ang - s), Math.cos(ang - s)));
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return { x: Math.cos(best) * (PLATEAU_R + 1.6), y: Math.sin(best) * (PLATEAU_R + 1.6) };
}
