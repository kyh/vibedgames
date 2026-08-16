#!/usr/bin/env node
/**
 * Verify that all PNGs are referenced by the asset manifest and vice versa.
 *
 * Usage:
 *   node asset_manifest_check.mjs
 *   node asset_manifest_check.mjs --manifest path/to/assets_index.lua --root assets
 *   node asset_manifest_check.mjs --manifest path/to/assets_index.lua --root assets --json tmp/check.json
 *   node asset_manifest_check.mjs --strict     # exit 1 if anything is missing or extra
 */
import { existsSync } from "node:fs";

import {
  autoDetectManifest,
  checkManifest,
  defaultRoot,
  fail,
  getFlag,
  getString,
  main,
  MANIFEST_CANDIDATES,
  parseArgs,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["json", "manifest", "root"],
    booleans: ["strict"],
  });
  const root = defaultRoot(getString(args, "root"));
  if (!existsSync(root)) fail(`Root not found: ${root}`);

  const manifest = getString(args, "manifest") ?? autoDetectManifest();
  if (!manifest || !existsSync(manifest)) {
    fail(`Manifest not found. Pass --manifest or create one of: ${MANIFEST_CANDIDATES.join(", ")}`);
  }

  const report = checkManifest(manifest, root);
  console.log(`manifest paths: ${report.manifest_paths}`);
  console.log(`actual pngs:    ${report.actual_pngs}`);
  console.log(`missing:        ${report.missing.length}`);
  for (const path of report.missing) console.log(`  MISSING ${path}`);
  console.log(`extra:          ${report.extra.length}`);
  for (const path of report.extra) console.log(`  EXTRA ${path}`);

  const json = getString(args, "json");
  if (json) writeJsonFile(json, report);

  if (getFlag(args, "strict") && report.missing.length + report.extra.length > 0) process.exit(1);
});
