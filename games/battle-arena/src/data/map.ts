// The arena as DATA (build-doc §6). Both the sim and the renderer read this —
// nothing is hand-placed in the renderer. The arena is a regular HEXAGONAL
// dungeon hall (KayKit Dungeon Remastered interior) centered on the origin so
// the Throne sits at (0,0). Sim plane is (x, y); the renderer maps y → world-z.
//
// Hexagon convention: vertices at angles k·60° (vertex on the +x axis); edges
// centered at 30° + k·60°; center→vertex = HEX_R; center→edge (apothem)
// = HEX_R·cos(30°). The 6 spawn bases sit at the 6 edge midpoints.
import { THRONE_RADIUS } from "./config";
import type { Vec2 } from "../sim/math";
import type { MapData } from "./map-format";

export const HEX_R = 44; // center → vertex (units)
export const APOTHEM = HEX_R * Math.cos(Math.PI / 6); // center → edge ≈ 38.105
export const HALF = 44; // compat half-extent (== HEX_R) — coarse consumers only
export const ARENA = {
  half: HALF,
  hexR: HEX_R,
  apothem: APOTHEM,
  throne: { x: 0, y: 0, radius: THRONE_RADIUS },
} as const;

/** Outward unit normal of hex edge k (edge centered at 30° + k·60°). */
export const EDGE_ANGLES: number[] = Array.from({ length: 6 }, (_, k) => Math.PI / 6 + (k * Math.PI) / 3);

export const BOSS_POS: Vec2 = { x: 0, y: 0 };
export const BOSS_PLATFORM_RADIUS = 5.5; // raised dais the boss stands on
export const BOSS_HEIGHT = 1.6; // dais lift (render + the coin-throw origin)

export type SpawnPoint = { slot: number; x: number; y: number; facing: number };

const SPAWN_R = APOTHEM - 5; // ≈ 33.1 — base pad inset from its wall
/** Six bases at the six edge midpoints; each faces the center. */
export const SPAWNS: SpawnPoint[] = EDGE_ANGLES.map((a, i) => {
  const x = Math.cos(a) * SPAWN_R;
  const y = Math.sin(a) * SPAWN_R;
  return { slot: i, x, y, facing: Math.atan2(-y, -x) };
});

/** Catch-up delivery drop zones — on four of the six vertex axes, mid-field
 *  (between the dais ring and the vertex camps; point-symmetric pairs). */
const PAD_ANGLES = [0, 2, 3, 5].map((k) => (k * Math.PI) / 3);
export const DELIVERY_PADS: Vec2[] = PAD_ANGLES.map((a) => ({ x: Math.cos(a) * 18, y: Math.sin(a) * 18 }));

/** Timed rune pickups (Phase 2 — positions reserved): on the 45°+k·90°
 *  diagonals, off every base lane and vertex axis. */
export const RUNE_SPOTS: Vec2[] = Array.from({ length: 4 }, (_, i) => {
  const a = Math.PI / 4 + (i * Math.PI) / 2;
  return { x: Math.cos(a) * 25, y: Math.sin(a) * 25 };
});

/** Neutral skeleton camps — PvE pockets at the six hex vertices, between the
 *  bases. `pack` overrides the default skeleton lineup; `respawnSec` the
 *  cadence. */
export type CampSpec = { id: string; x: number; y: number; pack?: string[]; respawnSec?: number };
export const CAMPS: CampSpec[] = Array.from({ length: 6 }, (_, i) => {
  const a = (i * Math.PI) / 3; // the vertex axes (0° = +x)
  return { id: `camp${i}`, x: Math.cos(a) * 27, y: Math.sin(a) * 27 };
});
// Elite lair: the Frost Golem miniboss holds the NE vertex corner, deeper in
// behind camp1 — 9u behind the camp, clear of pads, bases, and rune spots.
CAMPS.push({ id: "golem", x: Math.cos(Math.PI / 3) * 35.5, y: Math.sin(Math.PI / 3) * 35.5, pack: ["frostgolem"], respawnSec: 90 });

/** `model` is a render hint only — the sim reads just x/y/radius. */
export type Obstacle = { x: number; y: number; radius: number; height: number; model?: string };

/** Interior partition-wall runs (image-1 sub-room stubs): straight rows of
 *  circle colliders the renderer dresses as continuous low wall segments.
 *  angle = outward angle of the run's center; the run extends tangentially. */
export type PartitionRun = { x: number; y: number; /** tangent direction (radians, sim plane) */ dir: number; /** collider centers along the tangent */ offsets: number[] };
export const PARTITION_RUNS: PartitionRun[] = Array.from({ length: 6 }, (_, k) => {
  // one cover run per sextant at 12° past each vertex axis, radius 22 —
  // breaks the dais↔camp sightline while keeping every base→center lane
  // (edge angles 30°+k·60°) ≥ 4u clear on both sides.
  const a = (k * Math.PI) / 3 + (12 * Math.PI) / 180;
  return {
    x: Math.cos(a) * 22,
    y: Math.sin(a) * 22,
    dir: a + Math.PI / 2,
    offsets: [-3, -1, 1, 3],
  };
});

/** Cover in the mid-ring: 4 throne-flank pillars + the partition runs +
 *  shrine statues watching the delivery pads. Kept off the base→center lanes
 *  so nobody spawns inside one. Exported separately from OBSTACLES so the map
 *  editor can recover the pristine default after a custom map was applied. */
export function buildDefaultObstacles(): Obstacle[] {
  const out: Obstacle[] = [];
  // inner ring of 4 pillars flanking the throne approaches (45° diagonals —
  // 15° off the nearest base lane)
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    out.push({ x: Math.cos(a) * 16, y: Math.sin(a) * 16, radius: 1.2, height: 4.5 });
  }
  // partition-wall colliders (rendered as continuous wall_half runs — the
  // "wall_run" hint tells the renderer to skip per-circle models)
  for (const run of PARTITION_RUNS) {
    const tx = Math.cos(run.dir);
    const ty = Math.sin(run.dir);
    for (const t of run.offsets) {
      out.push({ x: run.x + tx * t, y: run.y + ty * t, radius: 1.1, height: 2.4, model: "wall_run" });
    }
  }
  // shrine statues on the delivery-pad axes, behind each pad (r21.5 vs pad
  // r18) — outside the coin ring and ≥11u off the nearest base lane
  for (const a of PAD_ANGLES) {
    out.push({
      x: Math.cos(a) * 21.5,
      y: Math.sin(a) * 21.5,
      radius: 0.55,
      height: 2.6,
      model: "paladin_statue",
    });
  }
  return out;
}

export const OBSTACLES: Obstacle[] = buildDefaultObstacles();

// ── Custom maps (map-format.ts / the ?editor=1 editor) ──────────────────────

let customMap = false;

/** True once applyMapData replaced the default arena colliders. */
export function hasCustomMap(): boolean {
  return customMap;
}

/** Replace the arena colliders with a custom map's — IN PLACE, because the sim
 *  (resolveObstacles) and the renderer both hold references to OBSTACLES. Must
 *  run before world creation and before Environment.setup. */
export function applyMapData(data: MapData): void {
  customMap = true;
  OBSTACLES.length = 0;
  for (const c of data.colliders) {
    OBSTACLES.push({ x: c.x, y: c.y, radius: c.radius, height: c.height, model: c.model });
  }
}

/** Partition runs the renderer dresses as continuous walls. The default arena
 *  uses the authored PARTITION_RUNS; custom maps reconstruct straight runs
 *  from their "wall_run" colliders (greedy chain clustering — circles within
 *  2.6u link into a run, singletons become short stubs). For the default
 *  collider set the reconstruction reproduces PARTITION_RUNS exactly. */
export function activePartitionRuns(): PartitionRun[] {
  if (!customMap) return PARTITION_RUNS;
  const pts = OBSTACLES.filter((o) => o.model === "wall_run");
  const used = new Set<number>();
  const runs: PartitionRun[] = [];
  for (let i = 0; i < pts.length; i++) {
    const seed = pts[i];
    if (!seed || used.has(i)) continue;
    used.add(i);
    const chain: Obstacle[] = [seed];
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < pts.length; j++) {
        const p = pts[j];
        if (!p || used.has(j)) continue;
        const head = chain[0];
        const tail = chain[chain.length - 1];
        if (!head || !tail) continue;
        if (Math.hypot(p.x - tail.x, p.y - tail.y) <= 2.6) {
          chain.push(p);
          used.add(j);
          grew = true;
        } else if (Math.hypot(p.x - head.x, p.y - head.y) <= 2.6) {
          chain.unshift(p);
          used.add(j);
          grew = true;
        }
      }
    }
    let cx = 0;
    let cy = 0;
    for (const p of chain) {
      cx += p.x;
      cy += p.y;
    }
    cx /= chain.length;
    cy /= chain.length;
    const head = chain[0];
    const tail = chain[chain.length - 1];
    let dir = 0;
    if (head && tail && chain.length > 1) {
      dir = Math.atan2(tail.y - head.y, tail.x - head.x);
      if (dir < 0) dir += Math.PI; // normalize to [0, π) — offsets are symmetric
    }
    const offsets = chain
      .map((p) => (p.x - cx) * Math.cos(dir) + (p.y - cy) * Math.sin(dir))
      .sort((a, b) => a - b);
    runs.push({ x: cx, y: cy, dir, offsets });
  }
  return runs;
}

// ── Pure spatial helpers ─────────────────────────────────────────────────────

export function isInThrone(x: number, y: number): boolean {
  return x * x + y * y <= THRONE_RADIUS * THRONE_RADIUS;
}

/** Signed distance helpers for the hex edge half-planes (edge normals at
 *  30° + k·60°). Precomputed — clampToArena runs per unit per tick. */
const EDGE_NX = EDGE_ANGLES.map((a) => Math.cos(a));
const EDGE_NY = EDGE_ANGLES.map((a) => Math.sin(a));

/** Clamp a point inside the hexagonal arena, leaving a margin for the radius.
 *  Two passes over the 6 edge half-planes so vertex corners resolve cleanly. */
export function clampToArena(x: number, y: number, radius = 0): Vec2 {
  const max = APOTHEM - radius;
  let px = x;
  let py = y;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < 6; k++) {
      const nx = EDGE_NX[k] ?? 0;
      const ny = EDGE_NY[k] ?? 0;
      const d = px * nx + py * ny;
      if (d > max) {
        px -= nx * (d - max);
        py -= ny * (d - max);
      }
    }
  }
  return { x: px, y: py };
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
