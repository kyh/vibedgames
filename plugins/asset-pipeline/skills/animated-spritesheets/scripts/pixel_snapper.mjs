#!/usr/bin/env node
/**
 * Recover the underlying low-resolution pixel-art grid from an upscaled or
 * AI-generated image. Port of Hugo-Dz/spritefusion-pixel-snapper.
 *
 * Usage:
 *   node pixel_snapper.mjs input.png output.png [--k-colors 256] [--seed 42]
 */
import {
  DEFAULT_SNAP_CONFIG,
  fail,
  getNumber,
  main,
  parseArgs,
  snapImage,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2));
  const [input, output] = args.positionals;
  if (!input || !output) {
    fail("Usage: node pixel_snapper.mjs input.png output.png [--k-colors N] [--seed N]");
  }

  const kColors = getNumber(args, "k-colors", 16);
  if (kColors <= 0) fail("--k-colors must be a positive integer");

  const snapped = snapImage(input, {
    ...DEFAULT_SNAP_CONFIG,
    kColors,
    kSeed: getNumber(args, "seed", 42),
  });
  snapped.toFile(output);
  console.log(`Snapped ${input} -> ${output} (${snapped.width}x${snapped.height})`);
});
