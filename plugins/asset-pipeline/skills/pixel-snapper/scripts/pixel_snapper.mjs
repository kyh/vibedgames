#!/usr/bin/env node
/**
 * Recover the underlying low-resolution pixel-art grid from an upscaled or
 * AI-generated image. Port of Hugo-Dz/spritefusion-pixel-snapper.
 *
 * Output resolution is discovered, not requested, so the only signal that the
 * run went wrong is the dimensions — which is why an implausible result is
 * reported here instead of being left for the caller to notice.
 *
 * Usage:
 *   node pixel_snapper.mjs input.png output.png [--k-colors 256] [--seed 42]
 *   node pixel_snapper.mjs input.png output.png --strict   # exit 1 on a bad snap
 */
import {
  Bitmap,
  DEFAULT_SNAP_CONFIG,
  fail,
  failUsage,
  getFlag,
  getInt,
  main,
  parseArgs,
  snapImage,
  snapWarning,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["k-colors", "seed"],
    booleans: ["strict"],
  });
  const [input, output] = args.positionals;
  if (!input || !output) {
    failUsage("Usage: node pixel_snapper.mjs input.png output.png [--k-colors N] [--seed N]");
  }

  const kColors = getInt(args, "k-colors", 16);
  if (kColors <= 0) fail("--k-colors must be a positive integer");

  const config = { ...DEFAULT_SNAP_CONFIG, kColors, kSeed: getInt(args, "seed", 42) };
  const snapped = snapImage(input, config);
  snapped.toFile(output);
  console.log(`Snapped ${input} -> ${output} (${snapped.width}x${snapped.height})`);

  const warning = snapWarning(Bitmap.fromFile(input), snapped, config);
  if (warning) {
    console.error(`[pixel_snapper] warning: ${warning}`);
    if (getFlag(args, "strict")) process.exit(1);
  }
});
