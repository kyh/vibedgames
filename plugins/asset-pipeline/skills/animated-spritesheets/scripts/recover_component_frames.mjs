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
 *   node recover_component_frames.mjs board.png --rows 3 --cols 4 --frames 8 \
 *       --out-dir runs/hero-attack/recovered
 */
import { join } from "node:path";

import {
  fail,
  failUsage,
  getNumber,
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
  const sheet = args.positionals[0];
  if (!sheet) failUsage("A pose-board PNG path is required.");

  const outDir = getString(args, "out-dir");
  if (!outDir) failUsage("--out-dir is required");

  const rows = getNumber(args, "rows", 0);
  const cols = getNumber(args, "cols", 0);
  if (!rows || !cols) failUsage("--rows and --cols are required");

  const prefix = getString(args, "prefix") ?? "frame";
  const frames = getString(args, "frames") === undefined ? null : getNumber(args, "frames", 0);

  const { result, crops } = recoverFrames(sheet, {
    rows,
    cols,
    frames,
    threshold: getNumber(args, "threshold", 15),
  });

  for (const crop of crops) {
    const path = join(outDir, `${prefix}-${crop.label}.png`);
    crop.image.toFile(path);
    result.frames.push({
      frame: crop.label,
      bbox: crop.bbox,
      area: crop.area,
      center: crop.center,
      path,
    });
  }

  writeJsonFile(join(outDir, `${prefix}-metadata.json`), result);
  console.log(outDir);
});
