import { makeGroundOffset, makeStandingSurface, makeTerracedDrapeField } from "./ground";
import { RoadNetwork } from "./network";
import { type ParcelPlanResult, planParcels } from "./parcel-plan";
import { decodeParcelSource } from "./parcel-source";
import { makeTerrain } from "./sf-map";

// The parcel PLAN, off the main thread. 147k footprints take a few seconds to
// clip, seat and classify — long enough to freeze the title screen — and the
// plan is pure (parcel-plan.ts), so it runs here against the same baked
// network and terrain the city builds, from the reservation the city's
// phase 1 already assembled. Edited cities (a grid-derived network) never
// reach this worker: the city plans them itself.

export type ParcelWorkerRequest = {
  readonly source: ArrayBuffer;
  readonly reserved: readonly string[];
};

/** The plan with its Set flattened: structured clone carries arrays and typed arrays. */
export type ParcelWorkerResponse = {
  readonly plans: ParcelPlanResult["plans"];
  readonly lots: ParcelPlanResult["lots"];
  readonly stats: ParcelPlanResult["stats"];
  readonly covered: readonly number[];
  readonly ms: number;
};

self.onmessage = (ev: MessageEvent<ParcelWorkerRequest>): void => {
  const t0 = performance.now();
  const source = decodeParcelSource(ev.data.source);
  const network = new RoadNetwork();
  const terrain = makeTerrain();
  const groundOffset = makeGroundOffset(network, terrain);
  const drape = makeTerracedDrapeField(network, terrain);
  const standAt = makeStandingSurface(network, terrain, groundOffset, drape);
  const result = planParcels({
    source,
    network,
    terrain,
    reserved: new Set(ev.data.reserved),
    standAt,
  });
  const response: ParcelWorkerResponse = {
    plans: result.plans,
    lots: result.lots,
    stats: result.stats,
    covered: [...result.covered],
    ms: Math.round(performance.now() - t0),
  };
  postMessage(response);
};
