import type { Blocker } from "../sim/grid";
import type { StructTier, Team } from "./config";
import type { Vec2 } from "../sim/math";

export const WORLD = { cell: 64, height: 3072, width: 4096 };
export const GRID = { cols: 64, rows: 48 };

/** Tile/cell size in px — the single source for every terrain grid (renderer +
 *  gallery import this instead of re-declaring a `64` literal). */
export const CELL = WORLD.cell;

const C = WORLD.cell;
const COLS = GRID.cols;
const ROWS = GRID.rows;

const leftEdge = (y: number) => {
  if (y <= 3 || y >= 44) {
    return -1;
  }

  if (y <= 5) {
    return 26;
  }

  if (y <= 11) {
    return 29;
  }

  if (y <= 14) {
    return 27;
  }

  if (y <= 18) {
    return 26;
  }

  if (y <= 29) {
    return 25;
  }

  if (y <= 33) {
    return 26;
  }

  if (y <= 36) {
    return 27;
  }

  if (y <= 42) {
    return 29;
  }

  return 26;
};

const leftInset = (y: number) => {
  if (y <= 4 || y >= 43) {
    return 4;
  }

  if (y <= 5 || y >= 42) {
    return 3;
  }

  if (y <= 6 || y >= 41) {
    return 2;
  }

  return 2;
};

const leftIslandCell = (x: number, y: number) => {
  const e = leftEdge(y);

  if (e < 0) {
    return false;
  }

  return x >= leftInset(y) && x <= e;
};

const centreIslandCell = (x: number, y: number) => {
  if (x < 28 || x > 35 || y < 20 || y > 27) {
    return false;
  }

  const cx = x === 28 || x === 35;
  const cy = y === 20 || y === 27;

  return !(cx && cy);
};

const ISLETS: [number, number, number, number][] = [
  [30, 3, 31, 4],
  [32, 43, 33, 44],
  [31, 14, 32, 15],
  [31, 32, 32, 33],
];

export const isLandCell = (x: number, y: number) => {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) {
    return false;
  }

  if (leftIslandCell(x, y)) {
    return true;
  }

  if (leftIslandCell(COLS - 1 - x, y)) {
    return true;
  }

  if (centreIslandCell(x, y)) {
    return true;
  }

  for (const [x0, y0, x1, y1] of ISLETS) {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
      return true;
    }
  }

  return false;
};

interface HighRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  walk: boolean;
}

const HIGH_RECTS: HighRect[] = [
  { walk: true, x0: 12, x1: 17, y0: 13, y1: 16 },
  { walk: true, x0: 12, x1: 17, y0: 31, y1: 34 },
  { walk: true, x0: 19, x1: 22, y0: 17, y1: 20 },
  { walk: true, x0: 19, x1: 22, y0: 27, y1: 30 },
  { walk: false, x0: 3, x1: 6, y0: 6, y1: 9 },
  { walk: false, x0: 3, x1: 6, y0: 38, y1: 41 },
  { walk: false, x0: 5, x1: 9, y0: 22, y1: 26 },
];

interface RampSpec {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dir: "N" | "S" | "E" | "W";
}

const MIRROR_DIR = { E: "W", N: "N", S: "S", W: "E" } satisfies Record<
  RampSpec["dir"],
  RampSpec["dir"]
>;

const RAMPS: RampSpec[] = [
  { dir: "W", x0: 18, x1: 18, y0: 14, y1: 15 },
  { dir: "W", x0: 18, x1: 18, y0: 32, y1: 33 },
  { dir: "W", x0: 23, x1: 23, y0: 18, y1: 19 },
  { dir: "W", x0: 23, x1: 23, y0: 28, y1: 29 },
];

const highRectAt = (x: number, y: number) => {
  if (!isLandCell(x, y)) {
    return null;
  }

  const mx = Math.min(x, COLS - 1 - x);

  for (const r of HIGH_RECTS) {
    if (mx >= r.x0 && mx <= r.x1 && y >= r.y0 && y <= r.y1) {
      return r;
    }
  }

  return null;
};

export const isHighCell = (x: number, y: number) => highRectAt(x, y) !== null;

/** High ground you can stand on (reached via ramps). */
export const isWalkableHighCell = (x: number, y: number) => highRectAt(x, y)?.walk === true;

/** High ground that fully blocks movement (deco rises, the ancient's keep). */
export const isBlockedHighCell = (x: number, y: number) => {
  const r = highRectAt(x, y);

  return r !== null && !r.walk;
};

/** Ramp at this cell (in ACTUAL world-cell coords), or null. Handles the mirror. */
export const rampAt = (x: number, y: number) => {
  for (const r of RAMPS) {
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) {
      return r;
    }

    const mx0 = COLS - 1 - r.x1;
    const mx1 = COLS - 1 - r.x0;

    if (x >= mx0 && x <= mx1 && y >= r.y0 && y <= r.y1) {
      return { dir: MIRROR_DIR[r.dir], x0: mx0, x1: mx1, y0: r.y0, y1: r.y1 };
    }
  }

  return null;
};

export const isRampCell = (x: number, y: number) => rampAt(x, y) !== null;

/** Cell elevation level for nav (1 = walkable high ground, 0 = low). Ramp cells
 *  read as 0 here; the ramp FLAG is what permits the cross-elevation step. */
export const cellElev = (x: number, y: number) => (isWalkableHighCell(x, y) ? 1 : 0);

export const ELEV_LIFT = 48;

/** Continuous render height 0..1 at a world point: 1 on a plateau top, ramped
 *  across a ramp, 0 on flat ground. View multiplies by the plateau lift height. */
export const elevationFrac = (x: number, y: number) => {
  const cx = Math.floor(x / C);
  const cy = Math.floor(y / C);

  if (isWalkableHighCell(cx, cy)) {
    return 1;
  }

  const r = rampAt(cx, cy);

  if (!r) {
    return 0;
  }

  const w = (r.x1 - r.x0 + 1) * C;
  const h = (r.y1 - r.y0 + 1) * C;
  let f = 0;

  if (r.dir === "N") {
    f = ((r.y1 + 1) * C - y) / h;
  } else if (r.dir === "S") {
    f = (y - r.y0 * C) / h;
  } else if (r.dir === "W") {
    f = ((r.x1 + 1) * C - x) / w;
  } else {
    f = (x - r.x0 * C) / w;
  }

  return Math.max(0, Math.min(1, f));
};

/** Stone wall below a `walk:false` plateau's south edge (blocked + drawn as the
 *  cliff face). Walkable plateaus use the elevation edge rule + ramps instead. */
export const isCliffCell = (x: number, y: number) => {
  if (!isLandCell(x, y) || isHighCell(x, y)) {
    return false;
  }

  if (isBlockedHighCell(x, y - 1)) {
    return true;
  }

  return isBlockedHighCell(x, y - 2) && !isBlockedHighCell(x, y - 1);
};

export interface BridgeSpec {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const BRIDGES: BridgeSpec[] = [
  { id: "bridge-top", x0: 29, x1: 34, y0: 8, y1: 9 },
  { id: "bridge-bottom", x0: 29, x1: 34, y0: 38, y1: 39 },
  { id: "bridge-mid-west", x0: 25, x1: 28, y0: 23, y1: 24 },
  { id: "bridge-mid-east", x0: 35, x1: 38, y0: 23, y1: 24 },
];

export const isBridge = (x: number, y: number) => {
  const cx = Math.floor(x / C);
  const cy = Math.floor(y / C);

  for (const b of BRIDGES) {
    if (cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1) {
      return true;
    }
  }

  return false;
};

/** True where units must not stand: open water (bridges carve it back open). */
export const isWater = (x: number, y: number) =>
  !isLandCell(Math.floor(x / C), Math.floor(y / C)) && !isBridge(x, y);

export type LaneId = "top" | "bottom";

export const LANE_IDS: LaneId[] = ["top", "bottom"];

const RADIANT_LANES = {
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
} satisfies Record<LaneId, Vec2[]>;

export const lanePath = (lane: LaneId, team: Team) => {
  const base = RADIANT_LANES[lane];

  return team === "radiant"
    ? base.map((p) => ({ ...p }))
    : [...base].toReversed().map((p) => ({ ...p }));
};

export interface TowerSpec {
  id: string;
  team: Team;
  lane: LaneId | "base";
  tier: StructTier;
  x: number;
  y: number;
}

const RADIANT_TOWERS: { lane: LaneId | "base"; tier: StructTier; x: number; y: number }[] = [
  { lane: "top", tier: "t1", x: 1640, y: 470 },
  { lane: "top", tier: "t2", x: 740, y: 730 },
  { lane: "bottom", tier: "t1", x: 1640, y: 2602 },
  { lane: "bottom", tier: "t2", x: 740, y: 2342 },
  { lane: "base", tier: "base", x: 832, y: 1280 },
  { lane: "base", tier: "base", x: 832, y: 1792 },
];

const buildTowers = () => {
  const out: TowerSpec[] = [];

  for (const team of ["radiant", "dire"] satisfies Team[]) {
    const p = team === "radiant" ? "r" : "d";
    let baseIdx = 0;

    for (const t of RADIANT_TOWERS) {
      const x = team === "radiant" ? t.x : WORLD.width - t.x;

      const id =
        t.tier === "base"
          ? `${p}-base-${(baseIdx += 1)}`
          : `${p}-${t.lane === "bottom" ? "bot" : t.lane}-${t.tier}`;

      out.push({ id, lane: t.lane, team, tier: t.tier, x, y: t.y });
    }
  }

  return out;
};

export const TOWERS: TowerSpec[] = buildTowers();

export interface BaseSpec {
  team: Team;
  ancient: Vec2;
  fountain: Vec2;
  fountainRadius: number;
  heroSpawn: Vec2;
  shopRadius: number;
  creepSpawn: Vec2;
}

export const BASES = {
  dire: {
    ancient: { x: 3616, y: 1536 },
    creepSpawn: { x: 3392, y: 1536 },
    fountain: { x: 3376, y: 1700 },
    fountainRadius: 280,
    heroSpawn: { x: 3276, y: 1536 },
    shopRadius: 420,
    team: "dire",
  },
  radiant: {
    ancient: { x: 480, y: 1536 },
    creepSpawn: { x: 704, y: 1536 },
    fountain: { x: 720, y: 1700 },
    fountainRadius: 280,
    heroSpawn: { x: 820, y: 1536 },
    shopRadius: 420,
    team: "radiant",
  },
} satisfies Record<Team, BaseSpec>;

export type NeutralKind = "small" | "medium" | "large" | "roshan";

export type NeutralCampSpec = Vec2 & { id: string; kind: NeutralKind };

export const NEUTRAL_CAMPS: NeutralCampSpec[] = [
  { id: "camp-lt", kind: "medium", x: 1216, y: 1056 },
  { id: "camp-lb", kind: "large", x: 1216, y: 2016 },
  { id: "camp-lc", kind: "small", x: 1504, y: 1504 },
  { id: "camp-rt", kind: "medium", x: 2880, y: 1056 },
  { id: "camp-rb", kind: "large", x: 2880, y: 2016 },
  { id: "camp-rc", kind: "small", x: 2592, y: 1504 },
  { id: "roshan", kind: "roshan", x: 2048, y: 1504 },
];

export type TreeCluster = Vec2 & { r: number };

const LEFT_TREES: TreeCluster[] = [
  { r: 180, x: 420, y: 480 },
  { r: 150, x: 1408, y: 320 },
  { r: 180, x: 420, y: 2592 },
  { r: 150, x: 1408, y: 2752 },
  { r: 130, x: 1024, y: 1152 },
  { r: 130, x: 1024, y: 1920 },
];

export const TREE_CLUSTERS: TreeCluster[] = [
  ...LEFT_TREES,
  ...LEFT_TREES.map((t) => ({ r: t.r, x: WORLD.width - t.x, y: t.y })),
];

/**
 * Blockers for the NavGrid, derived from the same masks the renderer paints:
 * water cells and plateau cells block; bridges carve walkability back in;
 * tree clusters block; a 1-cell border wall rings the world.
 */
export const buildBlockers = () => {
  const out: Blocker[] = [];

  for (let cy = 0; cy < ROWS; cy += 1) {
    let run = -1;

    for (let cx = 0; cx <= COLS; cx += 1) {
      const blocked =
        cx < COLS && (!isLandCell(cx, cy) || isBlockedHighCell(cx, cy) || isCliffCell(cx, cy));

      if (blocked && run < 0) {
        run = cx;
      }

      if (!blocked && run >= 0) {
        out.push({ h: C, kind: "rect", w: (cx - run) * C, x: run * C, y: cy * C });
        run = -1;
      }
    }
  }

  for (const t of TREE_CLUSTERS) {
    out.push({ kind: "circle", r: t.r * 0.78, x: t.x, y: t.y });
  }

  for (let cy = 0; cy < ROWS; cy += 1) {
    for (let cx = 0; cx < COLS; cx += 1) {
      if (isWalkableHighCell(cx, cy) || isRampCell(cx, cy)) {
        out.push({ h: C - 1, kind: "gap", w: C - 1, x: cx * C, y: cy * C });
      }
    }
  }

  for (const b of BRIDGES) {
    out.push({
      h: (b.y1 - b.y0 + 1) * C,
      kind: "gap",
      w: (b.x1 - b.x0 + 1) * C,
      x: b.x0 * C,
      y: b.y0 * C,
    });
  }

  const W = WORLD.width;
  const H = WORLD.height;
  out.push(
    { h: C, kind: "rect", w: W, x: 0, y: 0 },
    { h: C, kind: "rect", w: W, x: 0, y: H - C },
    { h: H, kind: "rect", w: C, x: 0, y: 0 },
    { h: H, kind: "rect", w: C, x: W - C, y: 0 },
  );

  return out;
};
