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
 *   node normalize-canvas.mjs --input-dir sliced --out-dir runtime
 *   node normalize-canvas.mjs --input-dir sliced --out-dir runtime \
 *       --canvas 256x256 --pad 6 --target-height 128
 */
import {
  fail,
  failUsage,
  getFlag,
  getInt,
  getNumber,
  getString,
  main,
  normalizeCanvas,
  parseArgs,
} from "./_lib/asset-tools.mjs";

/** Parse a `WxH` canvas spec. */
const parseSize = (text) => {
  const match = /^(?<w>\d+)\s*x\s*(?<h>\d+)$/iu.exec(text.trim());
  if (!match) {
    fail(`--canvas must be WxH, e.g. 256x256 (got "${text}")`);
  }
  const width = Number(match.groups?.w);
  const height = Number(match.groups?.h);
  if (width <= 0 || height <= 0) {
    fail(`--canvas dimensions must be positive, got: "${text}"`);
  }
  return { height, width };
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["no-upscale"],
    values: ["canvas", "char-fill", "glob", "input-dir", "out-dir", "pad", "target-height"],
  });
  const inputDir = getString(args, "input-dir");
  const outDir = getString(args, "out-dir");
  if (!inputDir || !outDir) {
    failUsage("--input-dir and --out-dir are required");
  }

  const pad = getInt(args, "pad", 6);
  if (pad < 0) {
    fail("--pad must be >= 0");
  }

  const charFill = getNumber(args, "char-fill", 0.5);
  if (!(charFill > 0 && charFill <= 1)) {
    fail("--char-fill must be in (0, 1]");
  }

  const targetHeightSpec = getString(args, "target-height");
  const targetHeight = targetHeightSpec === undefined ? null : getInt(args, "target-height", 0);
  if (targetHeight !== null && targetHeight <= 0) {
    fail("--target-height must be a positive integer");
  }

  const written = normalizeCanvas(inputDir, outDir, {
    allowUpscale: !getFlag(args, "no-upscale"),
    canvas: parseSize(getString(args, "canvas") ?? "256x256"),
    charFill,
    glob: getString(args, "glob") ?? "frame-*.png",
    pad,
    targetHeight,
  });

  console.log(outDir);
  console.log(`${written.length} frames`);
});
