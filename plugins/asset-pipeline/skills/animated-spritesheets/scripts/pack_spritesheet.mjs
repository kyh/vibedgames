#!/usr/bin/env node
/**
 * Pack runtime frames into an engine-loadable spritesheet + manifest.
 *
 * This is the step that turns loose `runtime/frame-*.png` into ONE packed PNG
 * (uniform grid, exact frame cells, no labels, no gaps, transparent
 * background) plus a JSON manifest an engine loads directly. It is an
 * engine-loadable sheet, not a labelled contact sheet.
 *
 * The default layout is a single horizontal strip, which loads cleanly with
 * Phaser's `load.spritesheet(key, url, { frameWidth, frameHeight })` plus
 * `anims.generateFrameNumbers(key, { start: 0, end: N-1 })`. Use --columns for
 * a grid when a strip would be too wide.
 *
 * Examples:
 *   node pack_spritesheet.mjs --input-dir runtime --out sheet.png
 *   node pack_spritesheet.mjs --input-dir runtime --out sheet.png --columns 5 --json-out sheet.json
 */
import {
  getInt,
  getString,
  fail,
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
  if (!inputDir || !out) failUsage("--input-dir and --out are required");

  const columnsSpec = getString(args, "columns");
  const { manifest, sheet } = packSpritesheet(inputDir, out, {
    glob: getString(args, "glob") ?? "frame-*.png",
    columns: columnsSpec === undefined ? null : getInt(args, "columns", 0),
    fps: getInt(args, "fps", 10),
    action: getString(args, "action") ?? "anim",
  });

  sheet.toFile(out);
  const manifestPath = getString(args, "json-out") ?? out.replace(/\.png$/i, ".json");
  writeJsonFile(manifestPath, manifest);

  console.log(
    JSON.stringify({ ...manifest, _manifestPath: manifestPath, _sheetPath: out }, null, 2),
  );
});
