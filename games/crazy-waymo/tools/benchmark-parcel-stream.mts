// Actual parcel plans and Three geometry, without a GPU or frame throttling.
// Run alone: pnpm exec vite-node tools/benchmark-parcel-stream.mts
// Add --cost to compare direct construction, generator resumption and clock checks.
import { Group } from "three";
import { landmarkProtection } from "../src/world/landmarks.ts";
import { planParcels } from "../src/world/parcel-plan.ts";
import {
  ParcelStreamer,
  streamRadiusFor,
  streamCells,
  parcelDetailForDistance,
  STREAM_CELL,
} from "../src/world/parcel-stream.ts";
import { buildParcelGeometry, buildParcelGeometrySteps } from "../src/world/parcel-mesh.ts";
import { visibleParcelPlans } from "../src/world/parcel-visibility.ts";
import { WORLD_HALF_X, WORLD_HALF_Z } from "../src/shared/constants.ts";
import { buildAuditWorld, loadParcelSource } from "./geometry-audit.mts";

const world = buildAuditWorld();
const parcels = planParcels({
  source: loadParcelSource(),
  network: world.network,
  terrain: world.terrain,
  standAt: world.standAt,
  reserved: landmarkProtection(world.plan, world.network).reserved,
});
const fabric = visibleParcelPlans(parcels.plans).filter((p) => p.height < 13);
const summary = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
};

if (process.argv.includes("--cost")) {
  const cells = [...streamCells(fabric, parcels.lots)]
    .map(([key, cell]) => {
      const x = (Math.floor(key / 4096) + 0.5) * STREAM_CELL - WORLD_HALF_X;
      const z = ((key % 4096) + 0.5) * STREAM_CELL - WORLD_HALF_Z;
      const distance = Math.hypot(x + 740, z - 604.5);
      return {
        plans: cell.plans,
        lots: cell.lots,
        distance,
        detail: parcelDetailForDistance(distance, 1),
      };
    })
    .filter((cell) => cell.distance < streamRadiusFor(1, 1))
    .toSorted((a, b) => a.distance - b.distance);
  const modes = ["direct", "generator", "clock-per-parcel"];
  const times = new Map<string, number[]>();
  for (let round = 0; round < 6; round++) {
    for (let index = 0; index < modes.length; index++) {
      const mode = modes[(index + round) % modes.length];
      if (!mode) continue;
      let vertices = 0;
      const started = performance.now();
      for (const cell of cells) {
        if (mode === "direct") {
          vertices += (await buildParcelGeometry(cell.plans, cell.detail, undefined, cell.lots))
            .stats.vertices;
        } else {
          const steps = buildParcelGeometrySteps(cell.plans, cell.detail, cell.lots);
          let next = steps.next();
          while (!next.done) {
            if (mode === "clock-per-parcel" && performance.now() === Infinity)
              throw new Error("Invalid clock");
            next = steps.next();
          }
          vertices += next.value.stats.vertices;
        }
      }
      const elapsed = performance.now() - started;
      if (round > 0) {
        const samples = times.get(mode) ?? [];
        samples.push(elapsed);
        times.set(mode, samples);
      }
      console.log(JSON.stringify({ round, mode, elapsed, vertices }));
    }
  }
  console.log(
    JSON.stringify({
      cells: cells.length,
      parcels: cells.reduce((n, c) => n + c.plans.length, 0),
      near: cells.filter((c) => c.detail > 0).length,
      estimatedFirstMissingAfter44: cells[44]?.distance,
      summary: [...times].map(([mode, samples]) => ({ mode, timing: summary(samples) })),
    }),
  );
} else
  for (let run = 0; run < 3; run++) {
    const group = new Group();
    const stream = new ParcelStreamer(group, fabric, parcels.lots, 1);
    const radius = streamRadiusFor(1, 1);
    stream.update(-740, 604.5, radius);
    const x = (0.738 * 2 - 1) * WORLD_HALF_X;
    const z = (0.19 * 2 - 1) * WORLD_HALF_Z;
    const samples: number[] = [];
    let first = stream.stats();
    let settledAt = 0;
    let detailedAt = 0;
    const states: {
      readonly frame: number;
      readonly resident: number;
      readonly detailed: number;
    }[] = [];
    for (let frame = 0; frame < 240; frame++) {
      const before = performance.now();
      stream.update(x, z, radius);
      samples.push(performance.now() - before);
      if (frame === 0) first = stream.stats();
      const state = stream.stats();
      if (state.pending === 0 && settledAt === 0) settledAt = frame + 1;
      states.push({ frame: frame + 1, resident: state.resident, detailed: state.detailedCells });
    }
    detailedAt =
      states.find((state) => state.detailed === stream.stats().detailedCells)?.frame ?? 0;
    console.log(
      JSON.stringify({
        run,
        firstMs: samples[0],
        first,
        updates: summary(samples),
        detailedAt,
        settledAt,
        settled: stream.stats(),
      }),
    );
    stream.update(WORLD_HALF_X * 10, WORLD_HALF_Z * 10, 0);
  }
