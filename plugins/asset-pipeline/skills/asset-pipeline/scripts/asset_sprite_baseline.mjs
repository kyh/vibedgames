#!/usr/bin/env node
/**
 * Audit and optionally normalize visible sprite baselines inside spritesheet frames.
 *
 * A character whose feet land on a different scanline in each frame bobs when
 * the animation plays. This measures that drift and can rewrite the sheet with
 * every sprite aligned to one baseline.
 *
 * Examples:
 *   node asset_sprite_baseline.mjs public/assets/kaede --frame 256x256
 *   node asset_sprite_baseline.mjs public/assets/kaede/attack-n.png --frame 256x256 \
 *       --target-bottom 255 --out fixed/attack-n.png
 *   node asset_sprite_baseline.mjs public/assets/kaede --frame 256x256 \
 *       --target-bottom 255 --out-dir fixed/kaede --json tmp/baselines.json
 */
import { statSync } from "node:fs";
import { basename, join, relative } from "node:path";

import {
  analyzeBaseline,
  fail,
  failUsage,
  getInt,
  getString,
  main,
  parseArgs,
  parseFrame,
  resolveTargets,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["frame", "json", "out", "out-dir", "target-bottom", "target-center-x"],
  });
  const input = args.positionals[0];
  if (!input) failUsage("A PNG file or folder path is required.");

  const frameSpec = getString(args, "frame");
  if (!frameSpec) failUsage("--frame is required, e.g. --frame 256x256");
  const frame = parseFrame(frameSpec);

  const targetBottom = getInt(args, "target-bottom", frame.height - 1);
  const targetCenterX =
    getString(args, "target-center-x") === undefined ? null : getInt(args, "target-center-x", 0);

  const targets = resolveTargets(input);
  if (targets.length === 0) fail(`No PNG files found in ${input}`);

  const out = getString(args, "out");
  const outDir = getString(args, "out-dir");
  if (out && outDir) fail("Use either --out or --out-dir, not both.");
  if (out && targets.length !== 1) {
    fail("--out can only be used with a single PNG input; use --out-dir for folders.");
  }

  const inputIsFile = statSync(input).isFile();
  const range = (value) => (value ? `[${value.join(", ")}]` : "None");

  const reports = targets.map((target) => {
    let outPath = null;
    if (out) outPath = out;
    else if (outDir)
      outPath = join(outDir, inputIsFile ? basename(target) : relative(input, target));

    const report = analyzeBaseline(target, frame, targetBottom, targetCenterX, outPath);
    console.log(
      `${target} frame=${frame.width}x${frame.height}` +
        ` bottom_range=${range(report.visibleBottomYRange)}` +
        ` shift_y_range=${range(report.shiftYRange)}`,
    );
    return report;
  });

  const json = getString(args, "json");
  if (json) writeJsonFile(json, reports);
});
