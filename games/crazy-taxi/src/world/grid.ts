import { BLOCK, GRID } from "../shared/constants";
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
import {
  ROAD_BEND,
  ROAD_CROSSROAD,
  ROAD_END,
  ROAD_INTERSECTION,
  ROAD_STRAIGHT,
} from "../assets/manifest";

export type CellKind = "road" | "lot";

export type RoadResolved = { readonly tile: string; readonly quarterTurns: number };

export type BuildingCell = { readonly gx: number; readonly gz: number; readonly faceDir: Dir };

export type CityPlan = {
  readonly size: number;
  readonly cells: readonly (readonly CellKind[])[];
  readonly roads: readonly (readonly (RoadResolved | null)[])[];
  readonly buildingCells: readonly BuildingCell[];
};

// Default connection masks in each tile's native (unrotated) orientation.
// N=-Z, E=+X, S=+Z, W=-X. Verified/adjusted against the actual GLBs.
const DEFAULT_MASK: Record<string, Mask> = {
  [ROAD_STRAIGHT]: (1 << N) | (1 << S), // runs along Z
  [ROAD_BEND]: (1 << N) | (1 << E), // L connecting N and E
  [ROAD_CROSSROAD]: (1 << N) | (1 << E) | (1 << S) | (1 << W),
  [ROAD_INTERSECTION]: (1 << E) | (1 << S) | (1 << W), // T, flat side faces N
  [ROAD_END]: 1 << S, // stub approached from S
};

function isRoadCell(gx: number, gz: number): boolean {
  if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return false;
  return gx % BLOCK === 0 || gz % BLOCK === 0;
}

function neighborMask(gx: number, gz: number): Mask {
  let mask = 0;
  for (const d of [N, E, S, W] as const) {
    const [dx, dz] = DIR_DELTA[d];
    if (isRoadCell(gx + dx, gz + dz)) mask |= 1 << d;
  }
  return mask;
}

// Choose the base tile by connection count, then find the quarter-turn whose
// rotated default mask equals the required mask.
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

// The direction from a lot cell toward an adjacent road (its street frontage).
function frontageDir(gx: number, gz: number): Dir | null {
  for (const d of [S, E, N, W] as const) {
    const [dx, dz] = DIR_DELTA[d];
    if (isRoadCell(gx + dx, gz + dz)) return d;
  }
  return null;
}

export function generateCity(): CityPlan {
  const cells: CellKind[][] = [];
  const roads: (RoadResolved | null)[][] = [];
  const buildingCells: BuildingCell[] = [];

  for (let gx = 0; gx < GRID; gx++) {
    const cellCol: CellKind[] = [];
    const roadCol: (RoadResolved | null)[] = [];
    for (let gz = 0; gz < GRID; gz++) {
      if (isRoadCell(gx, gz)) {
        cellCol[gz] = "road";
        roadCol[gz] = resolveRoad(neighborMask(gx, gz));
      } else {
        cellCol[gz] = "lot";
        roadCol[gz] = null;
        const face = frontageDir(gx, gz);
        if (face !== null) buildingCells.push({ gx, gz, faceDir: face });
      }
    }
    cells[gx] = cellCol;
    roads[gx] = roadCol;
  }

  return { size: GRID, cells, roads, buildingCells };
}

// Is this grid cell drivable (a road)? Used by collision + spawn placement.
export function planIsRoad(plan: CityPlan, gx: number, gz: number): boolean {
  if (gx < 0 || gz < 0 || gx >= plan.size || gz >= plan.size) return false;
  return plan.cells[gx]?.[gz] === "road";
}
