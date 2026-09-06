import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { Rng } from "../shared/rng";
import type { CityPlan } from "./grid";
import type { RoadNetwork } from "./network";
import type { Terrain } from "./terrain";

// The robotaxi depots: where the skin-swap garages stand. Pure in plan,
// terrain and network, so the city's phase 1 and the parcel worker pick the
// same seven spots and reserve the same cells around them.

// A robotaxi garage: the depot building plus the drive-in pad in front where
// the skin-swap UI opens. Spots are derived deterministically from the plan,
// so BOTH the generated and the baked-artifact boot paths agree on them.
export type Garage = { x: number; z: number; yaw: number; padX: number; padZ: number };

const GARAGE_COUNT = 7;
const GARAGE_MIN_DIST = 350;

export function pickGarageSpots(plan: CityPlan, terrain: Terrain, network: RoadNetwork): Garage[] {
  const cells = plan.cells;
  const dirs: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const cellAt = (gx: number, gz: number): string | undefined => cells[gx]?.[gz];
  type Cand = { gx: number; gz: number; dx: number; dz: number };
  const cands: Cand[] = [];
  for (let gx = 4; gx < GRID_X - 4; gx += 2) {
    for (let gz = 4; gz < GRID_Z - 4; gz += 2) {
      if (cellAt(gx, gz) !== "lot") continue;
      for (const [dx, dz] of dirs) {
        if (cellAt(gx + dx, gz + dz) !== "road") continue;
        // depth: the cell behind must be lot too (the depot is deep)
        if (cellAt(gx - dx, gz - dz) !== "lot") continue;
        const wx = (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
        const wz = (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
        const r = ROAD_TILE;
        const hs = [
          terrain.heightAt(wx - r, wz - r),
          terrain.heightAt(wx + r, wz - r),
          terrain.heightAt(wx - r, wz + r),
          terrain.heightAt(wx + r, wz + r),
        ];
        if (Math.max(...hs) - Math.min(...hs) > 1.4) continue; // flat pads only
        cands.push({ gx, gz, dx, dz });
        break;
      }
    }
  }
  // Seeded shuffle, then greedy max-spread accept.
  const rng = new Rng(424242);
  for (let i = cands.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = cands[i];
    const b = cands[j];
    if (a && b) {
      cands[i] = b;
      cands[j] = a;
    }
  }
  const picked: Garage[] = [];
  for (const c of cands) {
    if (picked.length >= GARAGE_COUNT) break;
    const wx = (c.gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
    const wz = (c.gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
    if (picked.some((g) => Math.hypot(g.x - wx, g.z - wz) < GARAGE_MIN_DIST)) continue;
    // Depot footprint must not clip a vector lane: the grid says "lot" but
    // straightened OSM centrelines cut lot cells, and a depot corner in the
    // roadway is an (invisible from the lane) wall.
    const dh = ROAD_TILE * 0.42 + 0.3;
    let clipsLane = false;
    for (const [ox, oz] of [
      [-dh, -dh],
      [dh, -dh],
      [-dh, dh],
      [dh, dh],
    ] as const) {
      const hit = network.nearest(wx + ox, wz + oz, ROAD_TILE * 1.4);
      if (hit && hit.dist < hit.edge.half + 0.2) {
        clipsLane = true;
        break;
      }
    }
    if (clipsLane) continue;
    picked.push({
      x: wx,
      z: wz,
      yaw: Math.atan2(c.dx, c.dz), // model faces +Z — turn it toward the road
      padX: wx + c.dx * ROAD_TILE * 1.15,
      padZ: wz + c.dz * ROAD_TILE * 1.15,
    });
  }
  return picked;
}
