import { ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { goldenGatePlan } from "./golden-gate";
import type { CityPlan } from "./grid";
import type { Terrain } from "./terrain";

export interface ReservationInput {
  readonly plan: CityPlan;
  readonly terrain: Terrain;
  /** landmarkProtection(plan, network).reserved — the landmark parcels. */
  readonly landmarks: ReadonlySet<string>;
  readonly garages: readonly {
    readonly x: number;
    readonly z: number;
    readonly padX: number;
    readonly padZ: number;
  }[];
  /** Editor "clear" cells; none on the worker path (edited cities plan on the main thread). */
  readonly clears: readonly (readonly [number, number])[];
}

const gridXOf = (x: number) => Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
const gridZOf = (z: number) => Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);
const worldX = (gx: number) => (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
const worldZ = (gz: number) => (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;

export const buildReservation = (input: ReservationInput) => {
  const reserved = new Set(input.landmarks);

  for (const [gx, gz] of input.clears) {
    reserved.add(`${gx},${gz}`);
  }

  const gg = goldenGatePlan({ plan: input.plan, terrain: input.terrain, worldX, worldZ });

  if (gg) {
    const gx0 = gridXOf(gg.ax - gg.half - ROAD_TILE * 0.5);
    const gx1 = gridXOf(gg.ax + gg.half + ROAD_TILE * 0.5);
    const gz0 = gridZOf(Math.min(gg.northEndZ, gg.shoreZ));
    const gz1 = gridZOf(Math.max(gg.northEndZ, gg.shoreZ));

    for (let gx = gx0; gx <= gx1; gx += 1) {
      for (let gz = gz0; gz <= gz1; gz += 1) {
        reserved.add(`${gx},${gz}`);
      }
    }
  }

  for (const g of input.garages) {
    reserved.add(`${gridXOf(g.x)},${gridZOf(g.z)}`);
    reserved.add(`${gridXOf(g.padX)},${gridZOf(g.padZ)}`);
  }

  return reserved;
};
