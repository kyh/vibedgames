#!/usr/bin/env node
/**
 * Recover individual poses from a generated pose board by connected component,
 * instead of slicing the grid uniformly.
 *
 * Image models rarely land poses on an exact grid — a character drifts out of
 * its cell, or an attack arc overhangs the next one — and uniform slicing then
 * cuts limbs in half. This finds each pose as a blob of non-background pixels
 * and crops it to its own bounds.
 *
 * Example:
 *   node recover-component-frames.mjs board.png --rows 3 --cols 4 --frames 8 \
 *       --out-dir runs/hero-attack/recovered
 */
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
  const [sheet] = args.positionals;
  if (!sheet) {
    failUsage("A pose-board PNG path is required.");
  }

  const outDir = getString(args, "out-dir");
  if (!outDir) {
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
