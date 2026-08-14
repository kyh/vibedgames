#!/usr/bin/env node
/**
 * List image dimensions for asset PNGs.
 *
 * Usage:
 *   node asset_sizes.mjs
 *   node asset_sizes.mjs --root assets --json tmp/sizes.json
 *   node asset_sizes.mjs --root path/to/assets --csv tmp/sizes.csv
 */
import { existsSync } from "node:fs";

import {
  collectSizes,
  defaultRoot,
  fail,
  getString,
  main,
  parseArgs,
  sizesToCsv,
  writeJsonFile,
  writeTextFile,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2));
  const root = defaultRoot(getString(args, "root"));
  if (!existsSync(root)) fail(`Root not found: ${root}`);

  const rows = collectSizes(root);
  for (const row of rows) console.log(`${row.width}x${row.height}\t${row.path}`);

  const csv = getString(args, "csv");
  if (csv) writeTextFile(csv, sizesToCsv(rows));
  const json = getString(args, "json");
  if (json) writeJsonFile(json, rows);
});
