#!/usr/bin/env node
// @ts-check
import { existsSync } from "node:fs";

import {
  exportManifest,
  fail,
  failUsage,
  getFlag,
  getString,
  main,
  parseArgs,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["keep-paths"],
    values: ["manifest", "out"],
  });

  const manifest = getString(args, "manifest") ?? "";
  const out = getString(args, "out") ?? "";

  if (manifest === "") {
    failUsage("--manifest is required (path to assets_index.lua or .json)");
  }

  if (out === "") {
    failUsage("--out is required (output JSON path)");
  }

  if (!existsSync(manifest)) {
    fail(`Manifest not found: ${manifest}`);
  }

  writeJsonFile(out, exportManifest(manifest, !getFlag(args, "keep-paths"), out));
  console.log(`Wrote ${out}`);
});
