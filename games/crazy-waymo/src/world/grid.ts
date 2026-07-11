import { GRID_X, GRID_Z } from "../shared/constants";
import { SF_STREET_MASK, streetMaskAt } from "./sf-streets";
import { CUSTOM_MAP, loadLocalOverrides } from "./custom-map";
import { isLandCell } from "./sf-map";
import { parkCell, parkRoadCellKept } from "./park-clear";
import { type Dir, DIR_DELTA, E, type Mask, maskCount, maskHas, N, S, W } from "../shared/types";

export type CellKind = "road" | "lot" | "water";

// Road-cell shape class, from the 4-neighbour connection mask. Historical
// note: this used to carry a Kenney tile id + quarterTurns for a tile
// renderer that no longer exists (streets are procedural, world/roads.ts);
// gameplay only ever matched on the shape.
export type RoadKind = "straight" | "bend" | "tee" | "cross" | "end";
export type RoadResolved = { readonly kind: RoadKind };
export type BuildingCell = { readonly gx: number; readonly gz: number; readonly faceDir: Dir };
export type GreenCell = { readonly gx: number; readonly gz: number };

export type CityPlan = {
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly cells: readonly (readonly CellKind[])[];
  readonly roads: readonly (readonly (RoadResolved | null)[])[];
  readonly buildingCells: readonly BuildingCell[];
  readonly greenCells: readonly GreenCell[];
};

function resolveRoad(mask: Mask): RoadResolved {
  const count = maskCount(mask);
  if (count >= 4) return { kind: "cross" };
  if (count === 3) return { kind: "tee" };
  if (count === 2) {
    const opposite =
      (maskHas(mask, N) && maskHas(mask, S)) || (maskHas(mask, E) && maskHas(mask, W));
    return { kind: opposite ? "straight" : "bend" };
  }
  if (count === 1) return { kind: "end" };
  return { kind: "straight" };
}

function key(gx: number, gz: number): string {
  return `${gx},${gz}`;
}

export function generateCity(): CityPlan {
  // The road network IS the real San Francisco street grid (OpenStreetMap),
  // rasterized to this game grid by tools/sf-data/rasterize.mjs. The baked mask
  // must be generated at the same resolution as the grid, or streets misalign.
  if (SF_STREET_MASK.gx !== GRID_X || SF_STREET_MASK.gz !== GRID_Z) {
    throw new Error(
      `SF street mask is ${SF_STREET_MASK.gx}x${SF_STREET_MASK.gz} but grid is ${GRID_X}x${GRID_Z}; ` +
        `regenerate: node tools/sf-data/rasterize.mjs ${GRID_X} ${GRID_Z}`,
    );
  }

  // The mask is baked pre-thinned from the vector network (bake-network.mjs),
  // then hand edits apply on top: baked CUSTOM_MAP (shipped) + local editor
  // overrides (this browser only, via ?editor=1 Apply & reload).
  const local = loadLocalOverrides();
  const addSet = new Set<string>();
  const removeSet = new Set<string>();
  for (const [gx, gz] of [...CUSTOM_MAP.add, ...local.add]) addSet.add(key(gx, gz));
  for (const [gx, gz] of [...CUSTOM_MAP.remove, ...local.remove]) removeSet.add(key(gx, gz));
  const isRoadRaw = (gx: number, gz: number): boolean => {
    if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) return false;
    if (!isLandCell(gx, gz)) return false;
    if (removeSet.has(key(gx, gz))) return false;
    if (addSet.has(key(gx, gz))) return true; // hand edits always win
    if (!streetMaskAt(gx, gz)) return false;
    // Parks are car-free: interior streets are dropped (mirrors the vector
    // network's park-clear), only the crossing highway keeps its cells.
    if (parkCell(gx, gz) && !parkRoadCellKept(gx, gz)) return false;
    return true;
  };

  // The land clip can fragment the raster mask where a street grazes water —
  // keep the LARGEST 4-connected component (fares/spawns/traffic cells must
  // be mutually reachable, and a bad seed must never select a fragment).
  let mainRoads = new Set<string>();
  {
    const seen = new Set<string>();
    for (let sgx = 0; sgx < GRID_X; sgx++) {
      for (let sgz = 0; sgz < GRID_Z; sgz++) {
        if (!isRoadRaw(sgx, sgz) || seen.has(key(sgx, sgz))) continue;
        const comp = new Set<string>();
        const stack = [{ gx: sgx, gz: sgz }];
        comp.add(key(sgx, sgz));
        seen.add(key(sgx, sgz));
        while (stack.length > 0) {
          const cur = stack.pop();
          if (!cur) break;
          for (const d of [N, E, S, W] as const) {
            const [dx, dz] = DIR_DELTA[d];
            const nx = cur.gx + dx;
            const nz = cur.gz + dz;
            const k = key(nx, nz);
            if (!seen.has(k) && isRoadRaw(nx, nz)) {
              comp.add(k);
              seen.add(k);
              stack.push({ gx: nx, gz: nz });
            }
          }
        }
        if (comp.size > mainRoads.size) mainRoads = comp;
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

  for (let gx = 0; gx < GRID_X; gx++) {
    const cellCol: CellKind[] = [];
    const roadCol: (RoadResolved | null)[] = [];
    for (let gz = 0; gz < GRID_Z; gz++) {
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

  return { sizeX: GRID_X, sizeZ: GRID_Z, cells, roads, buildingCells, greenCells };
}
