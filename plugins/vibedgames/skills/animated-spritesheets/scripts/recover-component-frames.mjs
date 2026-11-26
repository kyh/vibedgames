#!/usr/bin/env node
// @ts-check
import path from "node:path";

import {
  failUsage,
  getInt,
  getString,
  main,
  parseArgs,
  recoverFrames,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["cols", "frames", "out-dir", "prefix", "rows", "threshold"],
  });

  const [sheet = ""] = args.positionals;

  if (sheet === "") {
    failUsage("A pose-board PNG path is required.");
  }

  const outDir = getString(args, "out-dir") ?? "";

  if (outDir === "") {
    failUsage("--out-dir is required");
  }

  const rows = getInt(args, "rows", 0);
  const cols = getInt(args, "cols", 0);

  if (!rows || !cols) {
    failUsage("--rows and --cols are required");
  }

  const prefix = getString(args, "prefix") ?? "frame";
  const frames = getString(args, "frames") === undefined ? null : getInt(args, "frames", 0);

  const { result, crops } = recoverFrames(sheet, {
    cols,
    frames,
    rows,
    threshold: getInt(args, "threshold", 15),
  });

  for (const crop of crops) {
    const outPath = path.join(outDir, `${prefix}-${crop.label}.png`);
    crop.image.toFile(outPath);
    result.frames.push({
      area: crop.area,
      bbox: crop.bbox,
      center: crop.center,
      frame: crop.label,
      path: outPath,
    });
  }

  writeJsonFile(path.join(outDir, `${prefix}-metadata.json`), result);
  console.log(outDir);
});
