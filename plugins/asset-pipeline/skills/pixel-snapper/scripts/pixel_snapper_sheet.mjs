#!/usr/bin/env node
/**
 * Spritesheet-aware variant of pixel_snapper.mjs.
 *
 * Takes a sheet whose layout (cols, rows) is known, crops it into frames,
 * snaps all frames to ONE shared pixel grid, and reassembles a fresh sheet.
 *
 * Cropping before snapping is the point: a raw sheet has two competing scales
 * — the frame size and the intra-frame pixel cell — which confuse step-size
 * detection. Cropping removes the frame-grid scale, and snapping the packed
 * strip once leaves a single intra-frame pitch to recover, so every frame ends
 * up at the same scale with no size drift.
 *
 * Algorithm and parameter defaults are by Hugo Duprez (MIT) — see the parent
 * skill's references/credits.md.
 *
 * Usage:
 *   node pixel_snapper_sheet.mjs input.png output.png --cols 6 --rows 1 [--k-colors 256]
 */
import {
  Bitmap,
  DEFAULT_SNAP_CONFIG,
  fail,
  failUsage,
  getNumber,
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
    failUsage("Usage: node pixel_snapper_sheet.mjs input.png output.png --cols N --rows N");
  }

  const cols = getNumber(args, "cols", 0);
  const rows = getNumber(args, "rows", 0);
  if (cols <= 0 || rows <= 0) fail("--cols and --rows must be positive integers");

  const kColors = getNumber(args, "k-colors", 256);
  if (kColors <= 0) fail("--k-colors must be a positive integer");

  const { image, info } = snapSheet(Bitmap.fromFile(input), cols, rows, {
    ...DEFAULT_SNAP_CONFIG,
    kColors,
    kSeed: getNumber(args, "seed", 42),
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
