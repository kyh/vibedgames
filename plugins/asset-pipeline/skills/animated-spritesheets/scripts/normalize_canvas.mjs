#!/usr/bin/env node
/**
 * Shared-transform canvas normalization for a sliced pose-board action.
 *
 * Every frame gets the SAME crop and the SAME scale. Normalising each frame
 * against its own bounding box would centre the character in every cell and
 * cancel the motion, so the sprite would skate in place instead of moving. The
 * crop is therefore the union bbox across the whole clip, and the scale comes
 * from the median per-frame visible height — robust to a jump or lunge
 * inflating that union.
 *
 * The character is aimed at a fraction of the cell rather than filling it,
 * leaving headroom so an attack arc never clips.
 *
 * Examples:
 *   node normalize_canvas.mjs --input-dir sliced --out-dir runtime
 *   node normalize_canvas.mjs --input-dir sliced --out-dir runtime \
 *       --canvas 256x256 --pad 6 --target-height 128
 */
import {
  fail,
  failUsage,
  getFlag,
  getNumber,
  getString,
  main,
  normalizeCanvas,
  parseArgs,
} from "./_lib/asset-tools.mjs";

/** Parse a `WxH` canvas spec. */
function parseSize(text) {
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(text.trim());
  if (!match) fail(`--canvas must be WxH, e.g. 256x256 (got "${text}")`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) fail(`--canvas dimensions must be positive, got: "${text}"`);
  return { width, height };
}

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["canvas", "char-fill", "glob", "input-dir", "out-dir", "pad", "target-height"],
    booleans: ["no-upscale"],
  });
  const inputDir = getString(args, "input-dir");
  const outDir = getString(args, "out-dir");
  if (!inputDir || !outDir) failUsage("--input-dir and --out-dir are required");

  const pad = getNumber(args, "pad", 6);
  if (pad < 0) fail("--pad must be >= 0");

  const charFill = getNumber(args, "char-fill", 0.5);
  if (!(charFill > 0 && charFill <= 1)) fail("--char-fill must be in (0, 1]");

  const targetHeightSpec = getString(args, "target-height");
  const targetHeight = targetHeightSpec === undefined ? null : getNumber(args, "target-height", 0);
  if (targetHeight !== null && targetHeight <= 0) {
    fail("--target-height must be a positive integer");
  }

  const written = normalizeCanvas(inputDir, outDir, {
    glob: getString(args, "glob") ?? "frame-*.png",
    canvas: parseSize(getString(args, "canvas") ?? "256x256"),
    pad,
    allowUpscale: !getFlag(args, "no-upscale"),
    targetHeight,
    charFill,
  });

  console.log(outDir);
  console.log(`${written.length} frames`);
});
