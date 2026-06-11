// Map geometry: a two-lane battlefield — two big grass
// islands (radiant west, dire east) separated by a water channel, joined by a
// wooden bridge per lane plus a contested centre island (Roshan) reached by two
// short bridges. The land/elevation cell masks here are the single source of
// truth: the renderer paints from them and the nav grid blocks from them, so
// what you see is exactly what you can walk.

import type { Blocker } from "../sim/grid";
import type { StructTier, Team } from "./config";
import type { Vec2 } from "../sim/math";

export const WORLD = { width: 4096, height: 3072, cell: 64 };
export const GRID = { cols: 64, rows: 48 };

const C = WORLD.cell;
const COLS = GRID.cols;
const ROWS = GRID.rows;

// ---- land + elevation cell masks -------------------------------------------
// The left island's channel-side edge per row: land where x <= edge. Bulges out
// to meet the lane bridges (rows 6-11 / 37-42) and recesses at the middle so the
// centre island sits in open water. The right island is the exact x-mirror.
function leftEdge(y: number): number {
  if (y <= 3 || y >= 44) return -1; // open water rim top/bottom
  if (y <= 5) return 26;
  if (y <= 11) return 29; // top-lane bridge bulge
  if (y <= 14) return 27;
  if (y <= 18) return 26;
  if (y <= 29) return 25; // centre recess (channel widest here)
  if (y <= 33) return 26;
  if (y <= 36) return 27;
  if (y <= 42) return 29; // bottom-lane bridge bulge
  return 26;
}

/** Corner rounding for the left island's west coast: how far the coast pulls in. */
function leftInset(y: number): number {
  if (y <= 4 || y >= 43) return 4;
  if (y <= 5 || y >= 42) return 3;
  if (y <= 6 || y >= 41) return 2;
  return 2;
}

function leftIslandCell(x: number, y: number): boolean {
  const e = leftEdge(y);
  if (e < 0) return false;
  return x >= leftInset(y) && x <= e;
}

function centreIslandCell(x: number, y: number): boolean {
  if (x < 28 || x > 35 || y < 20 || y > 27) return false;
  // cut the four 1-cell corners for a rounded pit
  const cx = x === 28 || x === 35;
  const cy = y === 20 || y === 27;
  return !(cx && cy);
}

// Tiny decorative islets in the channel (walkable but unreachable — pure looks).
const ISLETS: Array<[number, number, number, number]> = [
  [30, 3, 31, 4],
  [32, 43, 33, 44],
  [31, 14, 32, 15],
  [31, 32, 32, 33],
];

export function isLandCell(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
  if (leftIslandCell(x, y)) return true;
  if (leftIslandCell(COLS - 1 - x, y)) return true; // mirrored right island
  if (centreIslandCell(x, y)) return true;
  for (const [x0, y0, x1, y1] of ISLETS) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
  return false;
}

// Raised plateaus (stone cliffs, unwalkable) for vertical depth in the jungle.
// Cell rects [x0,y0,x1,y1] inclusive, on the left island; mirrored to the right.
const HIGH_RECTS: Array<[number, number, number, number]> = [
  [12, 13, 17, 16], // north jungle plateau
  [12, 31, 17, 34], // south jungle plateau
  [3, 6, 6, 9], // NW corner rise
  [3, 38, 6, 41], // SW corner rise
  [5, 22, 9, 26], // castle outcrop — the ancient sits on this; its
  // big radius (config STRUCTS.ancient) lets attackers reach it from the flat edge
];

export function isHighCell(x: number, y: number): boolean {
  if (!isLandCell(x, y)) return false;
  const mx = Math.min(x, COLS - 1 - x); // mirror fold
  for (const [x0, y0, x1, y1] of HIGH_RECTS) {
    if (mx >= x0 && mx <= x1 && y >= y0 && y <= y1) return true;
  }
  return false;
}

/** The two rows of stone wall below a plateau's south edge (drawn as cliff face,
 *  blocked for movement so units never walk "through" the wall art). */
export function isCliffCell(x: number, y: number): boolean {
  if (!isLandCell(x, y) || isHighCell(x, y)) return false;
  if (isHighCell(x, y - 1)) return true;
  return isHighCell(x, y - 2) && !isHighCell(x, y - 1);
}

// ---- bridges ----------------------------------------------------------------
// Cell rects (inclusive) spanning the channel; end columns sit on the land edge
// so the wooden caps overlap the grass. All are 2 rows tall = a 128px crossing.
export type BridgeSpec = { id: string; x0: number; y0: number; x1: number; y1: number };
export const BRIDGES: BridgeSpec[] = [
  { id: "bridge-top", x0: 29, y0: 8, x1: 34, y1: 9 },
  { id: "bridge-bottom", x0: 29, y0: 38, x1: 34, y1: 39 },
  { id: "bridge-mid-west", x0: 25, y0: 23, x1: 28, y1: 24 },
  { id: "bridge-mid-east", x0: 35, y0: 23, x1: 38, y1: 24 },
];

export function isBridge(x: number, y: number): boolean {
  const cx = Math.floor(x / C);
  const cy = Math.floor(y / C);
  for (const b of BRIDGES) if (cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1) return true;
  return false;
}

/** True where units must not stand: open water (bridges carve it back open). */
export function isWater(x: number, y: number): boolean {
  return !isLandCell(Math.floor(x / C), Math.floor(y / C)) && !isBridge(x, y);
}

// ---- lanes -------------------------------------------------------------------
export type LaneId = "top" | "bottom";
export const LANE_IDS: LaneId[] = ["top", "bottom"];

// Radiant creeps walk these west -> east; dire creeps walk the reverse. The two
// middle waypoints are the bridge mouths so the straight segment between them
// crosses on the planks.
const RADIANT_LANES: Record<LaneId, Vec2[]> = {
  top: [
    { x: 704, y: 1280 },
    { x: 560, y: 1056 },
    { x: 560, y: 736 },
    { x: 736, y: 580 },
    { x: 1280, y: 576 },
    { x: 1824, y: 576 },
    { x: 2272, y: 576 },
    { x: 2816, y: 576 },
    { x: 3360, y: 580 },
    { x: 3536, y: 736 },
    { x: 3536, y: 1056 },
    { x: 3392, y: 1280 },
  ],
  bottom: [
    { x: 704, y: 1792 },
    { x: 560, y: 2016 },
    { x: 560, y: 2336 },
    { x: 736, y: 2492 },
    { x: 1280, y: 2496 },
    { x: 1824, y: 2496 },
    { x: 2272, y: 2496 },
    { x: 2816, y: 2496 },
    { x: 3360, y: 2492 },
    { x: 3536, y: 2336 },
    { x: 3536, y: 2016 },
    { x: 3392, y: 1792 },
  ],
};

export function lanePath(lane: LaneId, team: Team): Vec2[] {
  const base = RADIANT_LANES[lane];
  return team === "radiant"
    ? base.map((p) => ({ ...p }))
    : [...base].reverse().map((p) => ({ ...p }));
}

// ---- structures ------------------------------------------------------------
export type TowerSpec = {
  id: string;
  team: Team;
  lane: LaneId | "base";
  tier: StructTier;
  x: number;
  y: number;
};

// Two towers per lane (t1 forward near the bridge, t2 guarding the lane bend),
// two base towers in front of the castle, and the ancient. Dire is the x-mirror.
const RADIANT_TOWERS: Array<{ lane: LaneId | "base"; tier: StructTier; x: number; y: number }> = [
  { lane: "top", tier: "t1", x: 1640, y: 470 },
  { lane: "top", tier: "t2", x: 740, y: 730 },
  { lane: "bottom", tier: "t1", x: 1640, y: 2602 },
  { lane: "bottom", tier: "t2", x: 740, y: 2342 },
  { lane: "base", tier: "base", x: 832, y: 1280 },
  { lane: "base", tier: "base", x: 832, y: 1792 },
];

function buildTowers(): TowerSpec[] {
  const out: TowerSpec[] = [];
  for (const team of ["radiant", "dire"] as Team[]) {
    const p = team === "radiant" ? "r" : "d";
    let baseIdx = 0;
    for (const t of RADIANT_TOWERS) {
      const x = team === "radiant" ? t.x : WORLD.width - t.x;
      const id =
        t.tier === "base"
          ? `${p}-base-${++baseIdx}`
          : `${p}-${t.lane === "bottom" ? "bot" : t.lane}-${t.tier}`;
      out.push({ id, team, lane: t.lane, tier: t.tier, x, y: t.y });
    }
  }
  return out;
}

export const TOWERS: TowerSpec[] = buildTowers();

export type BaseSpec = {
  team: Team;
  ancient: Vec2;
  fountain: Vec2;
  fountainRadius: number;
  heroSpawn: Vec2;
  shopRadius: number;
  // where creeps of this team spawn (just outside the ancient)
  creepSpawn: Vec2;
};

export const BASES: Record<Team, BaseSpec> = {
  radiant: {
    team: "radiant",
    ancient: { x: 480, y: 1536 },
    fountain: { x: 720, y: 1700 }, // healing pool at the foot of the castle outcrop
    fountainRadius: 280,
    heroSpawn: { x: 820, y: 1536 },
    shopRadius: 420,
    creepSpawn: { x: 704, y: 1536 },
  },
  dire: {
    team: "dire",
    ancient: { x: 3616, y: 1536 },
    fountain: { x: 3376, y: 1700 },
    fountainRadius: 280,
    heroSpawn: { x: 3276, y: 1536 },
    shopRadius: 420,
    creepSpawn: { x: 3392, y: 1536 },
  },
};

// ---- neutral jungle camps + Roshan ----------------------------------------
// Camps sit in jungle pockets between the lanes; Roshan holds the centre island
// (the risky shortcut between the two lanes) and drops an Aegis.
export type NeutralKind = "small" | "medium" | "large" | "roshan";
export type NeutralCampSpec = Vec2 & { id: string; kind: NeutralKind };
export const NEUTRAL_CAMPS: NeutralCampSpec[] = [
  { id: "camp-lt", x: 1216, y: 1056, kind: "medium" }, // radiant north jungle
  { id: "camp-lb", x: 1216, y: 2016, kind: "large" }, // radiant south jungle
  { id: "camp-lc", x: 1504, y: 1504, kind: "small" }, // west centre-bridge mouth
  { id: "camp-rt", x: 2880, y: 1056, kind: "medium" }, // dire north jungle
  { id: "camp-rb", x: 2880, y: 2016, kind: "large" }, // dire south jungle
  { id: "camp-rc", x: 2592, y: 1504, kind: "small" }, // east centre-bridge mouth
  { id: "roshan", x: 2048, y: 1504, kind: "roshan" }, // centre island pit
];

export type TreeCluster = Vec2 & { r: number };

const LEFT_TREES: TreeCluster[] = [
  { x: 420, y: 480, r: 180 }, // over the NW rise
  { x: 1408, y: 320, r: 150 }, // north rim
  { x: 420, y: 2592, r: 180 }, // over the SW rise
  { x: 1408, y: 2752, r: 150 }, // south rim
  { x: 1024, y: 1152, r: 130 }, // north jungle pocket
  { x: 1024, y: 1920, r: 130 }, // south jungle pocket
];

export const TREE_CLUSTERS: TreeCluster[] = [
  ...LEFT_TREES,
  ...LEFT_TREES.map((t) => ({ x: WORLD.width - t.x, y: t.y, r: t.r })),
];

/**
 * Blockers for the NavGrid, derived from the same masks the renderer paints:
 * water cells and plateau cells block; bridges carve walkability back in;
 * tree clusters block; a 1-cell border wall rings the world.
 */
export function buildBlockers(): Blocker[] {
  const out: Blocker[] = [];

  // Water + plateaus + their cliff walls: one rect per horizontal run.
  for (let cy = 0; cy < ROWS; cy++) {
    let run = -1;
    for (let cx = 0; cx <= COLS; cx++) {
      const blocked =
        cx < COLS && (!isLandCell(cx, cy) || isHighCell(cx, cy) || isCliffCell(cx, cy));
      if (blocked && run < 0) run = cx;
      if (!blocked && run >= 0) {
        out.push({ kind: "rect", x: run * C, y: cy * C, w: (cx - run) * C, h: C });
        run = -1;
      }
    }
  }

  // Tree clusters block.
  for (const t of TREE_CLUSTERS) out.push({ kind: "circle", x: t.x, y: t.y, r: t.r * 0.78 });

  // Bridges re-open the water (gaps are applied after blockers in NavGrid).
  for (const b of BRIDGES) {
    out.push({
      kind: "gap",
      x: b.x0 * C,
      y: b.y0 * C,
      w: (b.x1 - b.x0 + 1) * C,
      h: (b.y1 - b.y0 + 1) * C,
    });
  }

  // Map border: a 1-cell wall so units never leave the world.
  const W = WORLD.width;
  const H = WORLD.height;
  out.push({ kind: "rect", x: 0, y: 0, w: W, h: C });
  out.push({ kind: "rect", x: 0, y: H - C, w: W, h: C });
  out.push({ kind: "rect", x: 0, y: 0, w: C, h: H });
  out.push({ kind: "rect", x: W - C, y: 0, w: C, h: H });

  return out;
}

export function towerSpec(id: string): TowerSpec | undefined {
  return TOWERS.find((t) => t.id === id);
}
