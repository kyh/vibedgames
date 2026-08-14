#!/usr/bin/env node
/**
 * Export a Lua asset manifest (assets_index.lua) to a portable assets_index.json.
 *
 * Example:
 *   node asset_manifest_export_json.mjs \
 *     --manifest path/to/assets_index.lua \
 *     --out path/to/assets_index.json
 */
import { existsSync } from "node:fs";

import {
  exportManifest,
  fail,
  getFlag,
  getString,
  main,
  parseArgs,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2));
  const manifest = getString(args, "manifest");
  const out = getString(args, "out");
  if (!manifest) fail("--manifest is required (path to assets_index.lua or .json)");
  if (!out) fail("--out is required (output JSON path)");
  if (!existsSync(manifest)) fail(`Manifest not found: ${manifest}`);

  writeJsonFile(out, exportManifest(manifest, !getFlag(args, "keep-paths")));
  console.log(`Wrote ${out}`);
});
