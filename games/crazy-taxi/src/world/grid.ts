import {
  ROAD_BEND,
  ROAD_CROSSROAD,
  ROAD_END,
  ROAD_INTERSECTION,
  ROAD_STRAIGHT,
} from "../assets/manifest";
import { CITY_SEED, GRID } from "../shared/constants";
import { Rng } from "../shared/rng";
import { isLandCell } from "./sf-map";
import {
  type Dir,
  DIR_DELTA,
  E,
  type Mask,
  maskCount,
  maskHas,
  N,
  rotateMask,
  S,
  W,
} from "../shared/types";

export type CellKind = "road" | "lot" | "water";

export type RoadResolved = { readonly tile: string; readonly quarterTurns: number };
export type BuildingCell = { readonly gx: number; readonly gz: number; readonly faceDir: Dir };
export type GreenCell = { readonly gx: number; readonly gz: number };

export type CityPlan = {
  readonly size: number;
  readonly cells: readonly (readonly CellKind[])[];
  readonly roads: readonly (readonly (RoadResolved | null)[])[];
  readonly buildingCells: readonly BuildingCell[];
  readonly greenCells: readonly GreenCell[];
};

// Native connection masks (N=-Z,E=+X,S=+Z,W=-X), read tile-by-tile off the
// actual Kenney GLBs with the debug compass rack (__rack). Each tile has its
// own native rotation — there is NO uniform offset, so they were read directly.
const DEFAULT_MASK: Record<string, Mask> = {
  [ROAD_STRAIGHT]: (1 << E) | (1 << W), // runs East–West
  [ROAD_BEND]: (1 << S) | (1 << W), // curve connects South + West
  [ROAD_CROSSROAD]: (1 << N) | (1 << E) | (1 << S) | (1 << W),
  [ROAD_INTERSECTION]: (1 << E) | (1 << S) | (1 << W), // T closed on the North
  [ROAD_END]: 1 << W, // stub opening to the West
};

function resolveRoad(mask: Mask): RoadResolved {
  const count = maskCount(mask);
  let tile: string;
  if (count >= 4) tile = ROAD_CROSSROAD;
  else if (count === 3) tile = ROAD_INTERSECTION;
  else if (count === 2) {
    const opposite =
      (maskHas(mask, N) && maskHas(mask, S)) || (maskHas(mask, E) && maskHas(mask, W));
    tile = opposite ? ROAD_STRAIGHT : ROAD_BEND;
  } else if (count === 1) tile = ROAD_END;
  else tile = ROAD_STRAIGHT;

  const base = DEFAULT_MASK[tile] ?? 0;
  for (let q = 0; q < 4; q++) {
    if (rotateMask(base, q) === mask) return { tile, quarterTurns: q };
  }
  return { tile, quarterTurns: 0 };
}

// Road lines at irregular spacing — tight near the centre (downtown), sprawling
// toward the edges (suburbs). Always includes the perimeter.
function makeLines(rng: Rng): number[] {
  // Built in increasing order (gaps are always positive) so it needs no sort.
  const lines: number[] = [0];
  const center = (GRID - 1) / 2;
  let i = 0;
  while (i < GRID - 1) {
    const distFrac = Math.min(1, Math.abs(i - center) / center);
    const minGap = 2 + Math.round(distFrac * 2); // 2 core .. 4 edge
    const span = 2 + Math.round(distFrac * 3); // jitter widens outward
    i += minGap + rng.int(span);
    if (i > 0 && i < GRID - 1) lines.push(i);
  }
  lines.push(GRID - 1);
  return lines;
}

type Edge = { a: string; b: string; cells: { gx: number; gz: number }[]; removed: boolean };

function key(gx: number, gz: number): string {
  return `${gx},${gz}`;
}

// Carve organic variety into the lattice: remove a fraction of road segments,
// but only when both endpoints stay connected — yielding T-junctions, bends,
// the odd cul-de-sac and large green super-blocks, never an unreachable island.
function carve(vLines: number[], hLines: number[], rng: Rng): Set<string> {
  const edges: Edge[] = [];
  const adj = new Map<string, Edge[]>();
  const push = (id: string, e: Edge): void => {
    const list = adj.get(id);
    if (list) list.push(e);
    else adj.set(id, [e]);
  };
  const link = (a: string, b: string, cells: { gx: number; gz: number }[]): void => {
    const e: Edge = { a, b, cells, removed: false };
    edges.push(e);
    push(a, e);
    push(b, e);
  };

  for (const gz of hLines) {
    for (let k = 0; k + 1 < vLines.length; k++) {
      const a = vLines[k];
      const b = vLines[k + 1];
      if (a === undefined || b === undefined) continue;
      const cells: { gx: number; gz: number }[] = [];
      for (let gx = a + 1; gx < b; gx++) cells.push({ gx, gz });
      link(key(a, gz), key(b, gz), cells);
    }
  }
  for (const gx of vLines) {
    for (let k = 0; k + 1 < hLines.length; k++) {
      const a = hLines[k];
      const b = hLines[k + 1];
      if (a === undefined || b === undefined) continue;
      const cells: { gx: number; gz: number }[] = [];
      for (let gz = a + 1; gz < b; gz++) cells.push({ gx, gz });
      link(key(gx, a), key(gx, b), cells);
    }
  }

  const connected = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined) break;
      if (cur === to) return true;
      for (const e of adj.get(cur) ?? []) {
        if (e.removed) continue;
        const next = e.a === cur ? e.b : e.a;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  };

  // Fisher-Yates with our deterministic RNG.
  for (let i = edges.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = edges[i];
    const other = edges[j];
    if (tmp && other) {
      edges[i] = other;
      edges[j] = tmp;
    }
  }

  const removedCells = new Set<string>();
  for (const e of edges) {
    if (!rng.chance(0.26)) continue;
    e.removed = true;
    if (connected(e.a, e.b)) {
      for (const c of e.cells) removedCells.add(key(c.gx, c.gz));
    } else {
      e.removed = false; // would isolate — keep it
    }
  }
  return removedCells;
}

export function generateCity(): CityPlan {
  const rng = new Rng(CITY_SEED);
  const vLines = makeLines(rng);
  const hLines = makeLines(rng);
  const vSet = new Set(vLines);
  const hSet = new Set(hLines);
  const removed = carve(vLines, hLines, rng);

  const isRoad = (gx: number, gz: number): boolean => {
    if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return false;
    if (!isLandCell(gx, gz)) return false; // roads stop at the shoreline
    if (!(vSet.has(gx) || hSet.has(gz))) return false;
    return !removed.has(key(gx, gz));
  };

  const neighborMask = (gx: number, gz: number): Mask => {
    let mask = 0;
    for (const d of [N, E, S, W] as const) {
      const [dx, dz] = DIR_DELTA[d];
      if (isRoad(gx + dx, gz + dz)) mask |= 1 << d;
    }
    return mask;
  };
  const frontageDir = (gx: number, gz: number): Dir | null => {
    for (const d of [S, E, N, W] as const) {
      const [dx, dz] = DIR_DELTA[d];
      if (isRoad(gx + dx, gz + dz)) return d;
    }
    return null;
  };

  const cells: CellKind[][] = [];
  const roads: (RoadResolved | null)[][] = [];
  const buildingCells: BuildingCell[] = [];
  const greenCells: GreenCell[] = [];

  for (let gx = 0; gx < GRID; gx++) {
    const cellCol: CellKind[] = [];
    const roadCol: (RoadResolved | null)[] = [];
    for (let gz = 0; gz < GRID; gz++) {
      if (!isLandCell(gx, gz)) {
        cellCol[gz] = "water";
        roadCol[gz] = null;
      } else if (isRoad(gx, gz)) {
        cellCol[gz] = "road";
        roadCol[gz] = resolveRoad(neighborMask(gx, gz));
      } else {
        cellCol[gz] = "lot";
        roadCol[gz] = null;
        const face = frontageDir(gx, gz);
        if (face !== null) buildingCells.push({ gx, gz, faceDir: face });
        else greenCells.push({ gx, gz });
      }
    }
    cells[gx] = cellCol;
    roads[gx] = roadCol;
  }

  return { size: GRID, cells, roads, buildingCells, greenCells };
}
