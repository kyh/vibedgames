// Installed-artifact audit: pnpm exec vite-node tools/audit-trees.mts
// Redirect stdout to retain the complete, revision-tagged overlap evidence.
import { auditTreeClearance } from "./test-tree-clearance.mts";
import { loadBakedRest, buildAuditWorld, loadParcelSource } from "./geometry-audit.mts";
import { landmarkProtection } from "../src/world/landmarks.ts";
import { planParcels } from "../src/world/parcel-plan.ts";

const world = buildAuditWorld();
const { rev, rest } = await loadBakedRest();
const parcels = planParcels({
  source: loadParcelSource(),
  network: world.network,
  terrain: world.terrain,
  reserved: landmarkProtection(world.plan, world.network).reserved,
  standAt: world.standAt,
});
const report = await auditTreeClearance(rest, parcels.plans);
console.log(JSON.stringify({ rev, ...report }, null, 2));
if (report.blocked.length > 0 || report.missingEmbeddedColliders > 0) process.exitCode = 1;
