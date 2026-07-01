// The arena as DATA (build-doc §6). Both the sim and the renderer read this —
// nothing is hand-placed in the renderer. Centered on the origin so the Throne
// sits at (0,0); coords run [-HALF, HALF] on both axes. Sim plane is (x, y);
// the renderer maps y → world-z.
import { THRONE_RADIUS } from "./config";
import type { Vec2 } from "../sim/math";

export const HALF = 48; // arena half-extent (units)
export const ARENA = {
  half: HALF,
  throne: { x: 0, y: 0, radius: THRONE_RADIUS },
} as const;

export const BOSS_POS: Vec2 = { x: 0, y: 0 };
export const BOSS_PLATFORM_RADIUS = 5.5; // raised dais the boss stands on
export const BOSS_HEIGHT = 1.6; // dais lift (render + the coin-throw origin)

export type SpawnPoint = { slot: number; x: number; y: number; facing: number };

const SPAWN_RING = 42;
const NUM_BASES = 6;
/** Six bases evenly around the rim; each faces the center. */
export const SPAWNS: SpawnPoint[] = Array.from({ length: NUM_BASES }, (_, i) => {
  const a = (i / NUM_BASES) * Math.PI * 2 - Math.PI / 2; // start at top, go CW
  const x = Math.cos(a) * SPAWN_RING;
  const y = Math.sin(a) * SPAWN_RING;
  return { slot: i, x, y, facing: Math.atan2(-y, -x) };
});

/** Catch-up delivery drop zones — between the bases, mid-field. */
export const DELIVERY_PADS: Vec2[] = Array.from({ length: 4 }, (_, i) => {
  const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
  return { x: Math.cos(a) * 24, y: Math.sin(a) * 24 };
});

/** Timed rune pickups (Phase 2 — positions reserved). */
export const RUNE_SPOTS: Vec2[] = Array.from({ length: 4 }, (_, i) => {
  const a = (i / 4) * Math.PI * 2;
  return { x: Math.cos(a) * 33, y: Math.sin(a) * 33 };
});

/** Neutral skeleton camps — PvE pockets in the outer dungeon, between bases. */
export type CampSpec = { id: string; x: number; y: number };
export const CAMPS: CampSpec[] = Array.from({ length: 6 }, (_, i) => {
  // radius 24 keeps camps clear of the pillar rings (16 & 30) so skeletons
  // don't spawn inside a column and grind against it
  const a = (i / 6) * Math.PI * 2 - Math.PI / 2 + Math.PI / 6; // offset from the bases
  return { id: `camp${i}`, x: Math.cos(a) * 24, y: Math.sin(a) * 24 };
});

export type Obstacle = { x: number; y: number; radius: number; height: number };

/** Cover pillars that break line of sight in the mid-ring. Kept off the
 *  base→center spokes so nobody spawns inside one. */
export const OBSTACLES: Obstacle[] = (() => {
  const out: Obstacle[] = [];
  // inner ring of 4 pillars guarding the throne approaches
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    out.push({ x: Math.cos(a) * 16, y: Math.sin(a) * 16, radius: 1.2, height: 4.5 });
  }
  // outer ring of 6 pillars between the bases
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    out.push({ x: Math.cos(a) * 30, y: Math.sin(a) * 30, radius: 1.1, height: 3.8 });
  }
  return out;
})();

// ── Pure spatial helpers ─────────────────────────────────────────────────────

export function isInThrone(x: number, y: number): boolean {
  return x * x + y * y <= THRONE_RADIUS * THRONE_RADIUS;
}

/** Clamp a point inside the (circular) arena, leaving a margin for the radius. */
export function clampToArena(x: number, y: number, radius = 0): Vec2 {
  const max = HALF - radius;
  const r = Math.sqrt(x * x + y * y);
  if (r <= max) return { x, y };
  const s = max / r;
  return { x: x * s, y: y * s };
}

/** Push a circle (cx,cy,cr) out of any overlapping obstacle / the boss dais.
 *  Returns the corrected position. Used by the sim for collision. */
export function resolveObstacles(cx: number, cy: number, cr: number): Vec2 {
  let x = cx;
  let y = cy;
  const solids = OBSTACLES;
  for (let pass = 0; pass < 2; pass++) {
    for (const o of solids) {
      const dx = x - o.x;
      const dy = y - o.y;
      const min = o.radius + cr;
      const d2 = dx * dx + dy * dy;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (min - d) / d;
        x += dx * push;
        y += dy * push;
      }
    }
    // boss dais
    const bx = x - BOSS_POS.x;
    const by = y - BOSS_POS.y;
    const bmin = BOSS_PLATFORM_RADIUS + cr;
    const bd2 = bx * bx + by * by;
    if (bd2 < bmin * bmin && bd2 > 1e-6) {
      const d = Math.sqrt(bd2);
      const push = (bmin - d) / d;
      x += bx * push;
      y += by * push;
    }
  }
  return { x, y };
}
