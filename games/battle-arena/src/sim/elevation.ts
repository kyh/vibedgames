// Real walkable elevation — GAMEPLAY, so it lives in the sim and is the single
// source of truth (the renderer reads these constants and groundHeight() to
// match). Deterministic, no RNG.
//
// The throne sits on a raised platform (a real level, == THRONE_RADIUS). Units
// can only step onto it through the STAIR gaps in its edge; everywhere else the
// edge is a wall you must go around. This gates the central objective behind the
// stairs — high ground you have to climb for.
//
// Two rules keep the gate from becoming a cage:
//   1. groundHeight() RAMPS up the stairs (no teleport to platform height), and
//      the ramp band is the stair mesh's real footprint — environment.ts fits
//      the stair model to STAIR_RUN/STAIR_HALF rather than the other way round.
//   2. resolveElevation() SLIDES you along the wall toward the nearest stair
//      instead of dead-stopping. Walking straight at the wall used to leave you
//      pinned with no hint where the way up was.
import type { Vec2 } from "./math";

export const PLATEAU_R = 11; // plateau radius (== THRONE_RADIUS): inside is level 1
export const PLATEAU_H = 2.0; // height of the platform top above the plaza
export const STAIR_ANGLES = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
/** Walkable stair-gap half-width (radians). 0.26 rad ≈ 15° → a ~5.7u-wide gap at
 *  the plateau edge: two bodies abreast. (Was 0.18 — only 8 of 36 approach
 *  headings could find a gap, which read as "the throne is walled off".) */
export const STAIR_HALF = 0.26;
/** Radial length of the stair run, measured OUTWARD from the plateau edge. The
 *  ramp climbs 0 → PLATEAU_H across this band. */
export const STAIR_RUN = 3.2;
/** Angular soft edge on the ramp (radians): the stair cheeks blend down to the
 *  plaza instead of a lateral cliff you can strafe off. */
const STAIR_FEATHER = 0.07;
/** How much of a blocked move's radial speed is redirected along the wall, toward
 *  the nearest stair. The slide fights the player's own tangential input, so it
 *  settles at atan(WALL_SLIDE) off the wall's worst point: below 1 that
 *  equilibrium lands SHORT of the gap (0.85 → 27°, gap edge at 30° → pinned to
 *  the wall forever) and the swing cap below stops it overshooting the stair. Any
 *  value > 1 funnels you all the way in. 0 was the old behaviour: a dead stop,
 *  with no hint where the way up even is. */
const WALL_SLIDE = 1.25;
/** Per-tick radial correction (u) for a body that a blink or knockback posted
 *  into the cliff — eases it out over a few frames instead of snapping. */
const DEPENETRATE = 0.06;

export function onPlateau(x: number, y: number): boolean {
  return x * x + y * y < PLATEAU_R * PLATEAU_R;
}

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** Signed angular distance from `ang` to the nearest stair centreline, and that
 *  centreline. Positive `delta` means `ang` sits counter-clockwise of the stair. */
function nearestStairAngle(ang: number): { center: number; delta: number } {
  let center = STAIR_ANGLES[0] ?? 0;
  let delta = Infinity;
  for (const s of STAIR_ANGLES) {
    const d = Math.atan2(Math.sin(ang - s), Math.cos(ang - s));
    if (Math.abs(d) < Math.abs(delta)) {
      center = s;
      delta = d;
    }
  }
  return { center, delta: delta === Infinity ? 0 : delta };
}

/** Whether a heading points through one of the stair gaps (crossing allowed). */
function inStairGap(ang: number): boolean {
  return Math.abs(nearestStairAngle(ang).delta) < STAIR_HALF;
}

/** Walkable ground height at (x, y) — the ONE height function. Flat plaza at 0,
 *  flat platform top at PLATEAU_H, and a real ramp up each stair run between
 *  them. Renderer reads this for unit feet, camera, and the stair mesh fit. */
export function groundHeight(x: number, y: number): number {
  const r = Math.hypot(x, y);
  if (r <= PLATEAU_R) return PLATEAU_H;
  if (r >= PLATEAU_R + STAIR_RUN) return 0;
  const { delta } = nearestStairAngle(Math.atan2(y, x));
  // outside the stair wedge (plus its feathered cheeks) the edge is a wall — the
  // plaza floor runs right up to it
  const lateral = 1 - smoothstep((Math.abs(delta) - STAIR_HALF) / STAIR_FEATHER);
  if (lateral <= 0) return 0;
  const climb = 1 - (r - PLATEAU_R) / STAIR_RUN; // 1 at the top step, 0 at the foot
  return PLATEAU_H * climb * lateral;
}

/** Block a move that crosses the plateau edge unless it's through a stair gap.
 *  A blocked move keeps its tangential speed AND is nudged around the wall
 *  toward the nearest stair, so holding "forward" into the wall walks you to the
 *  way up instead of pinning you. */
export function resolveElevation(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
): Vec2 {
  // Through a stair gap you may change level freely — that's the whole point.
  if (inStairGap(Math.atan2(toY, toX))) return { x: toX, y: toY };

  // Off-gap the cliff is solid, so a body's radius is confined to ONE side of it.
  // The legal band and the block test must use the SAME limit: the old code
  // tested the crossing against the bare edge (r = 11) but clamped to a
  // radius standoff (r ≈ 10.44), so every tick you touched the wall you were
  // thrown half a unit backward. That stutter — not the wall — was the "stuck".
  const fromIn = onPlateau(fromX, fromY);
  const limit = fromIn ? PLATEAU_R - radius - 0.06 : PLATEAU_R + radius + 0.06;
  const rNow = Math.hypot(fromX, fromY) || 1;
  const rTo = Math.hypot(toX, toY);
  // a move that keeps you where you are, or retreats deeper into your own side,
  // is always legal (this is also how a body that got posted into the wall by a
  // blink or a knockback digs itself out)
  const legal = fromIn ? rTo <= Math.max(limit, rNow) : rTo >= Math.min(limit, rNow);
  if (legal) return { x: toX, y: toY };

  // Blocked: freeze the radius (gently depenetrating if something posted us into
  // the cliff), keep whatever tangential motion the player had…
  const push = fromIn ? -DEPENETRATE : DEPENETRATE;
  const wall = fromIn
    ? Math.min(rNow, Math.max(limit, rNow + push))
    : Math.max(rNow, Math.min(limit, rNow + push));

  const toAng = Math.atan2(toY, toX);
  const fromAng = Math.atan2(fromY, fromX);
  const tangential = Math.atan2(Math.sin(toAng - fromAng), Math.cos(toAng - fromAng));

  // …and convert the radial speed the wall just ate into a slide toward the
  // nearest stair. Without this, walking straight at the wall is a dead stop with
  // no hint where the way up is.
  const into = ((toX - fromX) * fromX + (toY - fromY) * fromY) / rNow; // + = outward
  const radialKilled = Math.max(0, fromIn ? into : -into);
  const { delta } = nearestStairAngle(fromAng);
  const toward = delta > 0 ? -1 : 1; // rotate back toward the stair centreline
  // never overshoot the gap in one tick — a slide can at most reach the centreline
  const swing = Math.min((radialKilled * WALL_SLIDE) / wall, Math.abs(delta));
  const slide = toward * swing;

  const ang = fromAng + tangential + slide;
  return { x: Math.cos(ang) * wall, y: Math.sin(ang) * wall };
}

/** A waypoint just outside the nearest stair gap — bots steer here to reach the
 *  plateau instead of grinding the wall. */
export function nearestStair(x: number, y: number): Vec2 {
  const { center } = nearestStairAngle(Math.atan2(y, x));
  return {
    x: Math.cos(center) * (PLATEAU_R + STAIR_RUN * 0.5),
    y: Math.sin(center) * (PLATEAU_R + STAIR_RUN * 0.5),
  };
}
