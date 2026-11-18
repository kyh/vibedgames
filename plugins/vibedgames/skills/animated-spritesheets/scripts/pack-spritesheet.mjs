#!/usr/bin/env node
import {
  getInt,
  getString,
  failUsage,
  main,
  packSpritesheet,
  parseArgs,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["action", "columns", "fps", "glob", "input-dir", "json-out", "out"],
  });

  const inputDir = getString(args, "input-dir");
  const out = getString(args, "out");

  if (!inputDir || !out) {
    failUsage("--input-dir and --out are required");
  }

  const columnsSpec = getString(args, "columns");

  const { manifest, sheet } = packSpritesheet(inputDir, out, {
    action: getString(args, "action") ?? "anim",
    columns: columnsSpec === undefined ? null : getInt(args, "columns", 0),
    fps: getInt(args, "fps", 10),
    glob: getString(args, "glob") ?? "frame-*.png",
  });

  sheet.toFile(out);
  const manifestPath = getString(args, "json-out") ?? out.replace(/\.png$/iu, ".json");
  writeJsonFile(manifestPath, manifest);

  console.log(
    JSON.stringify({ ...manifest, _manifestPath: manifestPath, _sheetPath: out }, null, 2),
  );
});
