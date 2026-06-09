// Map geometry: world dims, lane waypoints, tower/base placement, and the
// river + jungle that shape pathing. Lane waypoints + tower/base coords come
// from the design pass; the river is authored cleanly here as a band along the
// y=x diagonal with bridge gaps where each lane crosses it.

import type { Blocker } from "../sim/grid";
import type { StructTier, Team } from "./config";
import type { Vec2 } from "../sim/math";

export const WORLD = { width: 6400, height: 6400, cell: 64 };

export type LaneId = "top" | "mid" | "bottom";
export const LANE_IDS: LaneId[] = ["top", "mid", "bottom"];

// Radiant creeps walk these from radiant base -> dire ancient. Dire creeps walk
// the reverse. Authored to hug lane edges and route onto the bridges.
const RADIANT_LANES: Record<LaneId, Vec2[]> = {
  top: [
    { x: 760, y: 5640 },
    { x: 600, y: 4400 },
    { x: 600, y: 3000 },
    { x: 640, y: 1800 },
    { x: 760, y: 900 },
    { x: 1100, y: 700 },
    { x: 1800, y: 640 },
    { x: 3000, y: 600 },
    { x: 4400, y: 600 },
    { x: 5500, y: 760 },
    { x: 5640, y: 760 },
  ],
  mid: [
    { x: 900, y: 5500 },
    { x: 1600, y: 4800 },
    { x: 2400, y: 4000 },
    { x: 3000, y: 3400 },
    { x: 3200, y: 3200 },
    { x: 3400, y: 3000 },
    { x: 4000, y: 2400 },
    { x: 4800, y: 1600 },
    { x: 5500, y: 900 },
  ],
  bottom: [
    { x: 900, y: 5640 },
    { x: 1800, y: 5760 },
    { x: 3000, y: 5800 },
    { x: 4400, y: 5800 },
    { x: 5300, y: 5760 },
    { x: 5700, y: 5500 },
    { x: 5760, y: 4400 },
    { x: 5800, y: 3000 },
    { x: 5760, y: 1800 },
    { x: 5640, y: 900 },
  ],
};

export function lanePath(lane: LaneId, team: Team): Vec2[] {
  const base = RADIANT_LANES[lane];
  return team === "radiant" ? base.map((p) => ({ ...p })) : [...base].reverse().map((p) => ({ ...p }));
}

// ---- structures ------------------------------------------------------------
export type TowerSpec = { id: string; team: Team; lane: LaneId | "base"; tier: StructTier; x: number; y: number };

// Raw lane-tower positions (3 per team+lane). Tiers are assigned by distance
// from the team's own Ancient so t1 is always the FORWARD tower (the first one
// enemy creeps meet, and the first that becomes attackable) — independent of
// the order they're listed here.
const ANCIENT_POS: Record<Team, Vec2> = { radiant: { x: 760, y: 5640 }, dire: { x: 5640, y: 760 } };

const LANE_TOWER_POS: Record<Team, Record<LaneId, Vec2[]>> = {
  radiant: {
    top: [{ x: 640, y: 3000 }, { x: 640, y: 4000 }, { x: 760, y: 4900 }],
    mid: [{ x: 2700, y: 3700 }, { x: 1900, y: 4500 }, { x: 1250, y: 5150 }],
    bottom: [{ x: 3000, y: 5760 }, { x: 4000, y: 5760 }, { x: 4900, y: 5640 }],
  },
  dire: {
    top: [{ x: 3000, y: 640 }, { x: 2000, y: 640 }, { x: 1100, y: 760 }],
    mid: [{ x: 3700, y: 2700 }, { x: 4500, y: 1900 }, { x: 5150, y: 1250 }],
    bottom: [{ x: 5760, y: 3000 }, { x: 5760, y: 2000 }, { x: 5640, y: 1100 }],
  },
};

const BASE_TOWER_POS: Record<Team, Vec2[]> = {
  radiant: [{ x: 980, y: 5180 }, { x: 1180, y: 5380 }],
  dire: [{ x: 5420, y: 1020 }, { x: 5220, y: 1220 }],
};

function buildTowers(): TowerSpec[] {
  const out: TowerSpec[] = [];
  for (const team of ["radiant", "dire"] as Team[]) {
    const p = team === "radiant" ? "r" : "d";
    const anc = ANCIENT_POS[team];
    for (const lane of LANE_IDS) {
      const code = lane === "bottom" ? "bot" : lane;
      const sorted = [...LANE_TOWER_POS[team][lane]].sort(
        (a, b) => (b.x - anc.x) ** 2 + (b.y - anc.y) ** 2 - ((a.x - anc.x) ** 2 + (a.y - anc.y) ** 2),
      );
      const tiers: StructTier[] = ["t1", "t2", "t3"]; // t1 = furthest from own ancient = forward
      sorted.forEach((pos, i) => {
        out.push({ id: `${p}-${code}-${tiers[i]}`, team, lane, tier: tiers[i]!, x: pos.x, y: pos.y });
      });
    }
    BASE_TOWER_POS[team].forEach((pos, i) => {
      out.push({ id: `${p}-base-${i + 1}`, team, lane: "base", tier: "base", x: pos.x, y: pos.y });
    });
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
    ancient: { x: 760, y: 5640 },
    fountain: { x: 560, y: 5840 },
    fountainRadius: 380,
    heroSpawn: { x: 760, y: 5560 },
    shopRadius: 440,
    creepSpawn: { x: 900, y: 5570 },
  },
  dire: {
    team: "dire",
    ancient: { x: 5640, y: 760 },
    fountain: { x: 5840, y: 560 },
    fountainRadius: 380,
    heroSpawn: { x: 5640, y: 840 },
    shopRadius: 440,
    creepSpawn: { x: 5500, y: 830 },
  },
};

// ---- river + jungle --------------------------------------------------------
// River runs along the line y = x from corner (0,0) to (W,W). Bridges where
// each lane crosses it (computed from the lane polylines).
export const RIVER_HALF_WIDTH = 200;
export const BRIDGES: Array<Vec2 & { r: number }> = [
  { x: 848, y: 848, r: 320 }, // top lane crossing
  { x: 3200, y: 3200, r: 360 }, // mid lane crossing
  { x: 5560, y: 5560, r: 320 }, // bottom lane crossing
];

// ---- neutral jungle camps + Roshan ----------------------------------------
// Camps sit in jungle clearings (near, but outside, the tree blockers) and off
// the creep lanes. Roshan holds a pit by the river and drops an Aegis.
export type NeutralKind = "small" | "medium" | "large" | "roshan";
export type NeutralCampSpec = Vec2 & { id: string; kind: NeutralKind };
export const NEUTRAL_CAMPS: NeutralCampSpec[] = [
  { id: "camp-rt", x: 1850, y: 4250, kind: "medium" }, // radiant top jungle
  { id: "camp-rb", x: 3250, y: 5250, kind: "large" }, // radiant bottom jungle
  { id: "camp-dt", x: 3150, y: 1150, kind: "large" }, // dire top jungle
  { id: "camp-db", x: 4550, y: 2150, kind: "medium" }, // dire bottom jungle
  { id: "camp-nw", x: 1550, y: 1050, kind: "small" }, // top-left grove
  { id: "camp-se", x: 4850, y: 5350, kind: "small" }, // bottom-right grove
  { id: "roshan", x: 2250, y: 2650, kind: "roshan" }, // river pit
];

export type TreeCluster = Vec2 & { r: number };
export const TREE_CLUSTERS: TreeCluster[] = [
  { x: 1850, y: 4550, r: 300 }, // radiant top jungle
  { x: 2950, y: 5250, r: 300 }, // radiant bottom jungle
  { x: 4550, y: 1850, r: 300 }, // dire bottom jungle
  { x: 3250, y: 1950, r: 300 }, // dire top jungle
  { x: 1300, y: 1300, r: 240 }, // top-left grove
  { x: 5100, y: 5100, r: 240 }, // bottom-right grove
];

/** Distance from a point to the river centre-line y=x. */
export function distToRiverLine(x: number, y: number): number {
  return Math.abs(x - y) / Math.SQRT2;
}

export function onBridge(x: number, y: number): boolean {
  for (const b of BRIDGES) {
    const dx = x - b.x;
    const dy = y - b.y;
    if (dx * dx + dy * dy <= b.r * b.r) return true;
  }
  return false;
}

export function isRiver(x: number, y: number): boolean {
  return distToRiverLine(x, y) <= RIVER_HALF_WIDTH && !onBridge(x, y);
}

/**
 * Blockers for the NavGrid: the river (as overlapping circles along the
 * diagonal), bridge gaps that re-open it, tree clusters, and the map border.
 * Structures are NOT grid blockers — units soft-separate around them instead,
 * so creeps never deadlock on their own lane towers.
 */
export function buildBlockers(): Blocker[] {
  const out: Blocker[] = [];
  const W = WORLD.width;

  // River: walk the diagonal stamping circles. Radius slightly > half-width so
  // the diagonal band is solid.
  const step = 80;
  const r = RIVER_HALF_WIDTH + 24;
  for (let d = -200; d <= W + 200; d += step) {
    out.push({ kind: "circle", x: d, y: d, r });
  }

  // Tree clusters block.
  for (const t of TREE_CLUSTERS) out.push({ kind: "circle", x: t.x, y: t.y, r: t.r * 0.78 });

  // Bridges re-open the river (applied after blockers in NavGrid).
  for (const b of BRIDGES) out.push({ kind: "gap", x: b.x - b.r, y: b.y - b.r, w: b.r * 2, h: b.r * 2 });

  // Map border: a 1-cell wall so units never leave the world.
  const c = WORLD.cell;
  out.push({ kind: "rect", x: 0, y: 0, w: W, h: c });
  out.push({ kind: "rect", x: 0, y: W - c, w: W, h: c });
  out.push({ kind: "rect", x: 0, y: 0, w: c, h: W });
  out.push({ kind: "rect", x: W - c, y: 0, w: c, h: W });

  return out;
}

export function towerSpec(id: string): TowerSpec | undefined {
  return TOWERS.find((t) => t.id === id);
}
