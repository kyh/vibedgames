// Installed-artifact audit: pnpm exec vite-node tools/audit-trees.mts
// Redirect stdout to retain the complete, revision-tagged overlap evidence.
import { auditTreeClearance } from "./test-tree-clearance.mts";
import { loadBakedRest, buildAuditWorld, loadParcelSource } from "./geometry-audit.mts";
import { buildLandmarks, landmarkProtection } from "../src/world/landmarks.ts";
import { planParcels } from "../src/world/parcel-plan.ts";

import { ModelCache } from "../src/assets/loader.ts";
import type { WaterBody } from "../src/world/water.ts";

const world = buildAuditWorld();
const { rev, rest } = await loadBakedRest();
const parcels = planParcels({
  source: loadParcelSource(),
  network: world.network,
  terrain: world.terrain,
  reserved: landmarkProtection(world.plan, world.network).reserved,
  standAt: world.standAt,
});
const water: WaterBody[] = [];
buildLandmarks(world.terrain, new ModelCache(), world.network, undefined, (body) =>
  water.push(body),
);
const report = await auditTreeClearance(rest, parcels.plans, water);
console.log(JSON.stringify({ rev, ...report }, null, 2));
if (
  report.blocked.length > 0 ||
  report.missingEmbeddedColliders > 0 ||
  report.waterRoots.length > 0
)
  process.exitCode = 1;
