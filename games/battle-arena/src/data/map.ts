import { THRONE_RADIUS } from "./config";
import type { Vec2 } from "../sim/math";
import type { FloorType, MapData } from "./map-format";

export const HEX_R = 62;
export const APOTHEM = HEX_R * Math.cos(Math.PI / 6);
export const HALF = HEX_R;
const S = HEX_R / 44;

export const ARENA = {
  apothem: APOTHEM,
  half: HALF,
  hexR: HEX_R,
  throne: { radius: THRONE_RADIUS, x: 0, y: 0 },
} as const;

/** Outward unit normal of hex edge k (edge centered at 30° + k·60°). */
export const EDGE_ANGLES: number[] = Array.from(
  { length: 6 },
  (_, k) => Math.PI / 6 + (k * Math.PI) / 3,
);

export const BOSS_POS: Vec2 = { x: 0, y: 0 };
export const BOSS_PLATFORM_RADIUS = 5.5;
export const BOSS_HEIGHT = 1.6;

export interface SpawnPoint {
  slot: number;
  x: number;
  y: number;
  facing: number;
}

const SPAWN_R = APOTHEM - 5;

/** Six bases at the six edge midpoints; each faces the center. */
export const SPAWNS: SpawnPoint[] = EDGE_ANGLES.map((a, i) => {
  const x = Math.cos(a) * SPAWN_R;
  const y = Math.sin(a) * SPAWN_R;

  return { facing: Math.atan2(-y, -x), slot: i, x, y };
});

const PAD_ANGLES = [0, 2, 3, 5].map((k) => (k * Math.PI) / 3);

export const DELIVERY_PADS: Vec2[] = PAD_ANGLES.map((a) => ({
  x: Math.cos(a) * 18 * S,
  y: Math.sin(a) * 18 * S,
}));

/** Timed rune pickups (Phase 2 — positions reserved): on the 45°+k·90°
 *  diagonals, off every base lane and vertex axis. */
export const RUNE_SPOTS: Vec2[] = Array.from({ length: 4 }, (_, i) => {
  const a = Math.PI / 4 + (i * Math.PI) / 2;

  return { x: Math.cos(a) * 25 * S, y: Math.sin(a) * 25 * S };
});

/** Neutral skeleton camps — PvE pockets at the six hex vertices, between the
 *  bases. `pack` overrides the default skeleton lineup; `respawnSec` the
 *  cadence. */
export interface CampSpec {
  id: string;
  x: number;
  y: number;
  pack?: string[];
  respawnSec?: number;
}

export const CAMPS: CampSpec[] = Array.from({ length: 6 }, (_, i) => {
  const a = (i * Math.PI) / 3;

  return { id: `camp${i}`, x: Math.cos(a) * 27 * S, y: Math.sin(a) * 27 * S };
});

CAMPS.push({
  id: "golem",
  pack: ["frostgolem"],
  respawnSec: 90,
  x: Math.cos(Math.PI / 3) * 35.5 * S,
  y: Math.sin(Math.PI / 3) * 35.5 * S,
});

/** `model` is a render hint only — the sim reads just x/y/radius. */
export interface Obstacle {
  x: number;
  y: number;
  radius: number;
  height: number;
  model?: string;
}

/** Interior partition-wall runs (image-1 sub-room stubs): straight rows of
 *  circle colliders the renderer dresses as continuous low wall segments.
 *  angle = outward angle of the run's center; the run extends tangentially. */
export interface PartitionRun {
  x: number;
  y: number;
  /** tangent direction (radians, sim plane) */
  dir: number;
  /** collider centers along the tangent */
  offsets: number[];
}

export const PARTITION_RUNS: PartitionRun[] = Array.from({ length: 6 }, (_, k) => {
  const a = (k * Math.PI) / 3 + (12 * Math.PI) / 180;

  return {
    dir: a + Math.PI / 2,
    offsets: [-4.5, -2.7, -0.9, 0.9, 2.7, 4.5],
    x: Math.cos(a) * 22 * S,
    y: Math.sin(a) * 22 * S,
  };
});

/** Cover in the mid-ring: 4 throne-flank pillars + the partition runs +
 *  shrine statues watching the delivery pads. Kept off the base→center lanes
 *  so nobody spawns inside one. Exported separately from OBSTACLES so the map
 *  editor can recover the pristine default after a custom map was applied. */
export const buildDefaultObstacles = () => {
  const out: Obstacle[] = [];

  for (const run of PARTITION_RUNS) {
    const tx = Math.cos(run.dir);
    const ty = Math.sin(run.dir);

    for (const t of run.offsets) {
      out.push({
        height: 2.4,
        model: "wall_run",
        radius: 1.1,
        x: run.x + tx * t,
        y: run.y + ty * t,
      });
    }
  }

  for (const a of PAD_ANGLES) {
    out.push({
      height: 2.6,
      model: "paladin_statue",
      radius: 0.55,
      x: Math.cos(a) * 21.5 * S,
      y: Math.sin(a) * 21.5 * S,
    });
  }

  return out;
};

export const OBSTACLES: Obstacle[] = buildDefaultObstacles();

let customMap = false;

/** True once applyMapData replaced the default arena colliders. */
export const hasCustomMap = () => customMap;

/** Painted floor cells (render-only): "gx,gz" on the 4u tile grid → tile band.
 *  Filled by applyMapData / the editor; Environment.buildFloor consults it. */
export const FLOOR_OVERRIDES = new Map<string, FloorType>();
export const floorKey = (gx: number, gz: number) => `${gx},${gz}`;

/** Replace the arena colliders with a custom map's — IN PLACE, because the sim
 *  (resolveObstacles) and the renderer both hold references to OBSTACLES. Must
 *  run before world creation and before Environment.setup. */
export const applyMapData = (data: MapData) => {
  customMap = true;
  OBSTACLES.length = 0;

  for (const c of data.colliders) {
    OBSTACLES.push({ height: c.height, model: c.model, radius: c.radius, x: c.x, y: c.y });
  }

  FLOOR_OVERRIDES.clear();

  for (const f of data.floor ?? []) {
    FLOOR_OVERRIDES.set(floorKey(f.x, f.y), f.t);
  }
};

/** Partition runs the renderer dresses as continuous walls. The default arena
 *  uses the authored PARTITION_RUNS; custom maps reconstruct straight runs
 *  from their "wall_run" colliders (greedy chain clustering — circles within
 *  2.6u link into a run, singletons become short stubs). For the default
 *  collider set the reconstruction reproduces PARTITION_RUNS exactly. */
export const activePartitionRuns = () => {
  if (!customMap) {
    return PARTITION_RUNS;
  }

  const pts = OBSTACLES.filter((o) => o.model === "wall_run");
  const used = new Set<number>();
  const runs: PartitionRun[] = [];

  for (let i = 0; i < pts.length; i += 1) {
    const seed = pts[i];

    if (!seed || used.has(i)) {
      continue;
    }

    used.add(i);
    const chain: Obstacle[] = [seed];
    let grew = true;

    while (grew) {
      grew = false;

      for (let j = 0; j < pts.length; j += 1) {
        const p = pts[j];

        if (!p || used.has(j)) {
          continue;
        }

        const [head] = chain;
        const tail = chain.at(-1);

        if (!head || !tail) {
          continue;
        }

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
    const [head] = chain;
    const tail = chain.at(-1);
    let dir = 0;

    if (head && tail && chain.length > 1) {
      dir = Math.atan2(tail.y - head.y, tail.x - head.x);

      if (dir < 0) {
        dir += Math.PI;
      }
    }

    const offsets = chain
      .map((p) => (p.x - cx) * Math.cos(dir) + (p.y - cy) * Math.sin(dir))
      .toSorted((a, b) => a - b);

    runs.push({ dir, offsets, x: cx, y: cy });
  }

  return runs;
};

export const isInThrone = (x: number, y: number) => x * x + y * y <= THRONE_RADIUS * THRONE_RADIUS;

const EDGE_NX = EDGE_ANGLES.map((a) => Math.cos(a));
const EDGE_NY = EDGE_ANGLES.map((a) => Math.sin(a));

/** Clamp a point inside the hexagonal arena, leaving a margin for the radius.
 *  Two passes over the 6 edge half-planes so vertex corners resolve cleanly. */
export const clampToArena = (x: number, y: number, radius = 0) => {
  const max = APOTHEM - radius;
  let px = x;
  let py = y;

  for (let pass = 0; pass < 2; pass += 1) {
    for (let k = 0; k < 6; k += 1) {
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
};

/** Push a circle (cx,cy,cr) out of any overlapping obstacle / the boss dais.
 *  Returns the corrected position. Used by the sim for collision. */
export const resolveObstacles = (cx: number, cy: number, cr: number) => {
  let x = cx;
  let y = cy;
  const solids = OBSTACLES;

  for (let pass = 0; pass < 2; pass += 1) {
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
};
