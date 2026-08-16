#!/usr/bin/env node
/**
 * Quality-control a packed spritesheet — the eval that tells an agent whether
 * to ship the sheet or regenerate the board.
 *
 * HARD checks (unambiguous defects -> "warn", and fail under --strict):
 *   empty       a frame is blank / near-blank
 *   clip        a frame's opaque pixels touch the cell border (cut off)
 *   baseline    the foot baseline jumps between frames
 *
 * SOFT hints (need an eyeball — the script can't know intent -> "review"):
 *   size        a frame's height is a strong outlier vs the median
 *   facing      a frame's horizontal mass is a strong outlier — the
 *               fingerprint of a mirrored cell
 *
 * Usage:
 *   node sheet_qc.mjs runs/hero-attack/spritesheet.png     # reads sibling .json
 *   node sheet_qc.mjs sheet.png --frame-width 256 --frame-height 256 --json
 *   node sheet_qc.mjs sheet.png --strict         # exit 1 if any HARD check fails
 *   node sheet_qc.mjs sheet.png --fail-on-hints  # exit 1 on soft hints too
 */
import {
  fail,
  failUsage,
  getFlag,
  getNumber,
  getString,
  main,
  parseArgs,
  runQc,
  toPythonJson,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["frame-height", "frame-width"],
    booleans: ["fail-on-hints", "json", "strict"],
  });
  const sheet = args.positionals[0];
  if (!sheet) failUsage("a spritesheet path is required");

  const frameWidth =
    getString(args, "frame-width") === undefined ? null : getNumber(args, "frame-width", 0);
  const frameHeight =
    getString(args, "frame-height") === undefined ? null : getNumber(args, "frame-height", 0);

  const report = runQc(sheet, frameWidth, frameHeight);

  if (getFlag(args, "json")) {
    console.log(toPythonJson(report));
  } else {
    console.log(
      `[${report.verdict.toUpperCase()}] ${report.sheet}` +
        `  (${report.frameCount} frames ${report.frameWidth}x${report.frameHeight})`,
    );
    for (const check of report.checks) {
      const marker = check.severity === "warn" ? "!" : "?";
      console.log(
        `  ${marker} ${check.check}: frames [${check.frames.join(", ")}] — ${check.detail}`,
      );
    }
    if (report.checks.length === 0) {
      console.log("  no issues: sizes consistent, facing consistent, no clipping or empty cells.");
    }
  }

  if (getFlag(args, "fail-on-hints") && report.verdict !== "clean") process.exit(1);
  if (getFlag(args, "strict") && report.verdict === "warn") process.exit(1);
});
