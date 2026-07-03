import {
  ROAD_BEND,
  ROAD_CROSSROAD,
  ROAD_END,
  ROAD_INTERSECTION,
  ROAD_STRAIGHT,
} from "../assets/manifest";
import { GRID } from "../shared/constants";
import { SF_STREET_MASK, streetMaskAt } from "./sf-streets";
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

// Native connection masks (N=-Z,E=+X,S=+Z,W=-X) for the KayKit street tiles,
// verified visually in-game. KayKit ships no dead-end piece, so a count-1 cell
// lays the straight along its single connection instead.
const DEFAULT_MASK: Record<string, Mask> = {
  [ROAD_STRAIGHT]: (1 << N) | (1 << S), // runs North–South
  [ROAD_BEND]: (1 << S) | (1 << W), // curve connects South + West
  [ROAD_CROSSROAD]: (1 << N) | (1 << E) | (1 << S) | (1 << W),
  [ROAD_INTERSECTION]: (1 << E) | (1 << S) | (1 << W), // T closed on the North
};

function resolveRoad(mask: Mask): RoadResolved {
  const count = maskCount(mask);
  let tile: string;
  let matchMask = mask;
  if (count >= 4) tile = ROAD_CROSSROAD;
  else if (count === 3) tile = ROAD_INTERSECTION;
  else if (count === 2) {
    const opposite =
      (maskHas(mask, N) && maskHas(mask, S)) || (maskHas(mask, E) && maskHas(mask, W));
    tile = opposite ? ROAD_STRAIGHT : ROAD_BEND;
  } else if (count === 1) {
    // Dead end: no stub piece — align a straight along the one connection.
    tile = ROAD_END;
    matchMask = mask | rotateMask(mask, 2);
  } else tile = ROAD_STRAIGHT;

  const base = DEFAULT_MASK[tile] ?? DEFAULT_MASK[ROAD_STRAIGHT] ?? 0;
  for (let q = 0; q < 4; q++) {
    if (rotateMask(base, q) === matchMask) return { tile, quarterTurns: q };
  }
  return { tile, quarterTurns: 0 };
}

function key(gx: number, gz: number): string {
  return `${gx},${gz}`;
}

export function generateCity(): CityPlan {
  // The road network IS the real San Francisco street grid (OpenStreetMap),
  // rasterized to this game grid by tools/sf-data/rasterize.mjs. The baked mask
  // must be generated at the same resolution as GRID, or streets misalign.
  if (SF_STREET_MASK.gx !== GRID || SF_STREET_MASK.gz !== GRID) {
    throw new Error(
      `SF street mask is ${SF_STREET_MASK.gx}x${SF_STREET_MASK.gz} but GRID is ${GRID}; ` +
        `regenerate: node tools/sf-data/rasterize.mjs ${GRID} ${GRID}`,
    );
  }

  const isRoadRaw = (gx: number, gz: number): boolean => {
    if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return false;
    if (!isLandCell(gx, gz)) return false; // roads stop at the shoreline
    return streetMaskAt(gx, gz);
  };

  // The real street grid is one connected network, but the shoreline cut above
  // can still split it (water inlets sever whole fingers, e.g. Treasure Island
  // or the bridge approaches that rasterize onto water). Keep only the component
  // containing the map centre — every fare, spawn and traffic cell must be
  // mutually reachable.
  const mainRoads = new Set<string>();
  {
    const c = (GRID - 1) / 2;
    let seed: { gx: number; gz: number } | null = null;
    let bd = Infinity;
    for (let gx = 0; gx < GRID; gx++) {
      for (let gz = 0; gz < GRID; gz++) {
        if (!isRoadRaw(gx, gz)) continue;
        const d = Math.abs(gx - c) + Math.abs(gz - c);
        if (d < bd) {
          bd = d;
          seed = { gx, gz };
        }
      }
    }
    if (seed) {
      const stack = [seed];
      mainRoads.add(key(seed.gx, seed.gz));
      while (stack.length > 0) {
        const cur = stack.pop();
        if (!cur) break;
        for (const d of [N, E, S, W] as const) {
          const [dx, dz] = DIR_DELTA[d];
          const nx = cur.gx + dx;
          const nz = cur.gz + dz;
          const k = key(nx, nz);
          if (!mainRoads.has(k) && isRoadRaw(nx, nz)) {
            mainRoads.add(k);
            stack.push({ gx: nx, gz: nz });
          }
        }
      }
    }
  }
  const isRoad = (gx: number, gz: number): boolean => mainRoads.has(key(gx, gz));

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
