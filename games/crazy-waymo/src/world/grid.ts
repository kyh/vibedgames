import { GRID_X, GRID_Z } from "../shared/constants";
import { SF_STREET_MASK, streetMaskAt } from "./sf-streets";
import { CUSTOM_MAP, loadLocalOverrides } from "./custom-map";
import { isLandCell } from "./sf-map";
import { DIR_DELTA, E, maskCount, maskHas, N, S, W } from "../shared/types";
import type { Dir, Mask } from "../shared/types";

export type CellKind = "road" | "lot" | "water";

export type RoadKind = "straight" | "bend" | "tee" | "cross" | "end";

export interface RoadResolved {
  readonly kind: RoadKind;
}

export interface BuildingCell {
  readonly gx: number;
  readonly gz: number;
  readonly faceDir: Dir;
}

export interface GreenCell {
  readonly gx: number;
  readonly gz: number;
}

export interface CityPlan {
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly cells: readonly (readonly CellKind[])[];
  readonly roads: readonly (readonly (RoadResolved | null)[])[];
  readonly buildingCells: readonly BuildingCell[];
  readonly greenCells: readonly GreenCell[];
}

const resolveRoad: (mask: Mask) => RoadResolved = (mask) => {
  const count = maskCount(mask);

  if (count >= 4) {
    return { kind: "cross" };
  }

  if (count === 3) {
    return { kind: "tee" };
  }

  if (count === 2) {
    const opposite =
      (maskHas(mask, N) && maskHas(mask, S)) || (maskHas(mask, E) && maskHas(mask, W));

    return { kind: opposite ? "straight" : "bend" };
  }

  if (count === 1) {
    return { kind: "end" };
  }

  return { kind: "straight" };
};

const key = (gx: number, gz: number) => `${gx},${gz}`;

export const generateCity = () => {
  if (SF_STREET_MASK.gx !== GRID_X || SF_STREET_MASK.gz !== GRID_Z) {
    throw new Error(
      `SF street mask is ${SF_STREET_MASK.gx}x${SF_STREET_MASK.gz} but grid is ${GRID_X}x${GRID_Z}; ` +
        `regenerate: node tools/sf-data/rasterize.mts ${GRID_X} ${GRID_Z}`,
    );
  }

  const local = loadLocalOverrides();
  const addSet = new Set<string>();
  const removeSet = new Set<string>();

  for (const [gx, gz] of [...CUSTOM_MAP.add, ...local.add]) {
    addSet.add(key(gx, gz));
  }

  for (const [gx, gz] of [...CUSTOM_MAP.remove, ...local.remove]) {
    removeSet.add(key(gx, gz));
  }

  const isRoadRaw = (gx: number, gz: number) => {
    if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) {
      return false;
    }

    if (!isLandCell(gx, gz)) {
      return false;
    }

    if (removeSet.has(key(gx, gz))) {
      return false;
    }

    if (addSet.has(key(gx, gz))) {
      return true;
    }

    if (!streetMaskAt(gx, gz)) {
      return false;
    }

    return true;
  };

  let mainRoads = new Set<string>();
  {
    const seen = new Set<string>();

    for (let sgx = 0; sgx < GRID_X; sgx += 1) {
      for (let sgz = 0; sgz < GRID_Z; sgz += 1) {
        if (!isRoadRaw(sgx, sgz) || seen.has(key(sgx, sgz))) {
          continue;
        }

        const comp = new Set<string>();
        const stack = [{ gx: sgx, gz: sgz }];
        comp.add(key(sgx, sgz));
        seen.add(key(sgx, sgz));

        while (stack.length > 0) {
          const cur = stack.pop();

          if (!cur) {
            break;
          }

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

        if (comp.size > mainRoads.size) {
          mainRoads = comp;
        }
      }
    }
  }

  const isRoad = (gx: number, gz: number) => mainRoads.has(key(gx, gz));

  const neighborMask = (gx: number, gz: number) => {
    let mask = 0;

    for (const d of [N, E, S, W] as const) {
      const [dx, dz] = DIR_DELTA[d];

      if (isRoad(gx + dx, gz + dz)) {
        // oxlint-disable-next-line no-bitwise -- connection masks are bit sets
        mask |= 1 << d;
      }
    }

    return mask;
  };

  const frontageDir = (gx: number, gz: number) => {
    for (const d of [S, E, N, W] as const) {
      const [dx, dz] = DIR_DELTA[d];

      if (isRoad(gx + dx, gz + dz)) {
        return d;
      }
    }

    return null;
  };

  const cells: CellKind[][] = [];
  const roads: (RoadResolved | null)[][] = [];
  const buildingCells: BuildingCell[] = [];
  const greenCells: GreenCell[] = [];

  for (let gx = 0; gx < GRID_X; gx += 1) {
    const cellCol: CellKind[] = [];
    const roadCol: (RoadResolved | null)[] = [];

    for (let gz = 0; gz < GRID_Z; gz += 1) {
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

        if (face === null) {
          greenCells.push({ gx, gz });
        } else {
          buildingCells.push({ faceDir: face, gx, gz });
        }
      }
    }

    cells[gx] = cellCol;
    roads[gx] = roadCol;
  }

  return { buildingCells, cells, greenCells, roads, sizeX: GRID_X, sizeZ: GRID_Z };
};
