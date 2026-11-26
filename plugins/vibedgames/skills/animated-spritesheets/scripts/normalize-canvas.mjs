#!/usr/bin/env node
// @ts-check
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

const parseSize = (text = "256x256") => {
  const match = /^(?<w>\d+)\s*x\s*(?<h>\d+)$/iu.exec(text.trim());

  if (!match) {
    fail(`--canvas must be WxH, e.g. 256x256 (got "${text}")`);
  }

  const width = Number(match?.groups?.w);
  const height = Number(match?.groups?.h);

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

  const inputDir = getString(args, "input-dir") ?? "";
  const outDir = getString(args, "out-dir") ?? "";

  if (inputDir === "" || outDir === "") {
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
    canvas: parseSize(getString(args, "canvas")),
    charFill,
    glob: getString(args, "glob") ?? "frame-*.png",
    pad,
    targetHeight,
  });

  console.log(outDir);
  console.log(`${written.length} frames`);
});
