import { pickGarageSpots } from "./garages";
import { generateCity } from "./grid";
import { makeGroundOffset, makeStandingSurface, makeTerracedDrapeField } from "./ground";
import { landmarkProtection } from "./landmarks";
import { RoadNetwork } from "./network";
import { planParcels } from "./parcel-plan";
import type { ParcelPlanResult } from "./parcel-plan";
import { decodeParcelSource } from "./parcel-source";
import { buildReservation } from "./reservation";
import { makeTerrain } from "./sf-map";

export interface ParcelWorkerRequest {
  readonly source: ArrayBuffer;
}

/** The plan with its Set flattened: structured clone carries arrays and typed arrays. */
export interface ParcelWorkerResponse {
  readonly plans: ParcelPlanResult["plans"];
  readonly lots: ParcelPlanResult["lots"];
  readonly stats: ParcelPlanResult["stats"];
  readonly covered: readonly number[];
  readonly ms: number;
}

self.addEventListener("message", (ev: MessageEvent<ParcelWorkerRequest>) => {
  const t0 = performance.now();
  const source = decodeParcelSource(ev.data.source);
  const plan = generateCity();
  const network = new RoadNetwork();
  const terrain = makeTerrain();
  const groundOffset = makeGroundOffset(network, terrain);
  const drape = makeTerracedDrapeField(network, terrain);
  const standAt = makeStandingSurface(network, terrain, groundOffset, drape);

  const reserved = buildReservation({
    clears: [],
    garages: pickGarageSpots(plan, terrain, network),
    landmarks: landmarkProtection(plan, network).reserved,
    plan,
    terrain,
  });

  const result = planParcels({ network, reserved, source, standAt, terrain });

  const response: ParcelWorkerResponse = {
    covered: [...result.covered],
    lots: result.lots,
    ms: Math.round(performance.now() - t0),
    plans: result.plans,
    stats: result.stats,
  };

  postMessage(response);
});
