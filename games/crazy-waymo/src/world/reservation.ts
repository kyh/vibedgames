import { ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { goldenGatePlan } from "./golden-gate";
import type { CityPlan } from "./grid";
import type { Terrain } from "./terrain";

// The RESERVATION: every "gx,gz" cell no procedural placement may touch —
// landmark parcels, the Golden Gate corridor, the robotaxi depots and their
// drive-in pads, and the editor's cleared cells. One function, because two
// callers assemble it: the city's phase 1 (which every later pass reads) and
// the parcel worker, which starts before phase 1 exists and must plan against
// exactly the same set or its buildings land on a landmark's lawn.

export type ReservationInput = {
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
};

const gridXOf = (x: number): number => Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
const gridZOf = (z: number): number => Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);
const worldX = (gx: number): number => (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
const worldZ = (gz: number): number => (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;

export function buildReservation(input: ReservationInput): Set<string> {
  const reserved = new Set(input.landmarks);
  for (const [gx, gz] of input.clears) reserved.add(`${gx},${gz}`);
  // The Golden Gate corridor. buildGoldenGate runs LAST (phase 3), so its
  // deck does not exist yet when the vegetation and furniture passes seat
  // props — and the deck is not network asphalt, so `onAsphalt` cannot see it
  // either. The result was a kit conifer planted on the deck centreline at
  // the bridge axis, straddling both lanes. Reserving the corridor up front
  // is the only place that knowledge can live for every later pass.
  const gg = goldenGatePlan({ plan: input.plan, terrain: input.terrain, worldX, worldZ });
  if (gg) {
    const gx0 = gridXOf(gg.ax - gg.half - ROAD_TILE * 0.5);
    const gx1 = gridXOf(gg.ax + gg.half + ROAD_TILE * 0.5);
    const gz0 = gridZOf(Math.min(gg.northEndZ, gg.shoreZ));
    const gz1 = gridZOf(Math.max(gg.northEndZ, gg.shoreZ));
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) reserved.add(`${gx},${gz}`);
    }
  }
  // Garages claim their own cell AND their drive-in pad before anything else
  // builds (or dresses) there.
  for (const g of input.garages) {
    reserved.add(`${gridXOf(g.x)},${gridZOf(g.z)}`);
    reserved.add(`${gridXOf(g.padX)},${gridZOf(g.padZ)}`);
  }
  return reserved;
}
