#!/usr/bin/env node
import {
  Bitmap,
  DEFAULT_SNAP_CONFIG,
  fail,
  failUsage,
  getInt,
  main,
  parseArgs,
  snapSheet,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["cols", "k-colors", "rows", "seed"],
  });

  const [input, output] = args.positionals;

  if (!input || !output) {
    failUsage("Usage: node pixel-snapper-sheet.mjs input.png output.png --cols N --rows N");
  }

  const cols = getInt(args, "cols", 0);
  const rows = getInt(args, "rows", 0);

  if (cols <= 0 || rows <= 0) {
    fail("--cols and --rows must be positive integers");
  }

  const kColors = getInt(args, "k-colors", 256);

  if (kColors <= 0) {
    fail("--k-colors must be a positive integer");
  }

  const { image, info } = snapSheet(Bitmap.fromFile(input), cols, rows, {
    ...DEFAULT_SNAP_CONFIG,
    kColors,
    kSeed: getInt(args, "seed", 42),
  });

  image.toFile(output);

  const [fw, fh] = info.targetFrameDims;
  const [ow, oh] = info.outputDims;
  console.log(`Snapped sheet ${input} -> ${output}`);
  console.log(
    `  input: ${info.inputDims[0]}x${info.inputDims[1]}` +
      ` (${cols}x${rows} of ${info.inputFrameDims[0]}x${info.inputFrameDims[1]})`,
  );
  console.log(`  target frame: ${fw}x${fh} (shared pitch across all frames)`);
  console.log(`  output: ${ow}x${oh}`);
});
