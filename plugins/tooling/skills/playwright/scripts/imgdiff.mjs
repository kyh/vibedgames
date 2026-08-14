#!/usr/bin/env node
/**
 * Compare two screenshots and report whether they differ.
 *
 * Exit codes:
 *   0 = images match within --max-rms
 *   1 = images differ (or have different sizes)
 *   2 = error (unreadable images, bad arguments)
 *
 * Usage:
 *   node imgdiff.mjs baseline.png current.png --out diff.png
 *   node imgdiff.mjs baseline.png current.png --max-rms 2.0
 */
import { Bitmap, diffImages, getNumber, getString, parseArgs } from "./_lib/asset-tools.mjs";

const args = parseArgs(process.argv.slice(2));
const [baselinePath, currentPath] = args.positionals;
if (!baselinePath || !currentPath) {
  process.stderr.write("Usage: node imgdiff.mjs <baseline> <current> [--out diff.png]\n");
  process.exit(2);
}

const out = getString(args, "out") ?? "diff.png";
const maxRms = getNumber(args, "max-rms", 0);

let baseline;
let current;
try {
  baseline = Bitmap.fromFile(baselinePath);
  current = Bitmap.fromFile(currentPath);
} catch (error) {
  process.stderr.write(
    `Failed to read images: ${error instanceof Error ? error.message : error}\n`,
  );
  process.exit(2);
}

if (baseline.width !== current.width || baseline.height !== current.height) {
  process.stderr.write(
    `Different sizes: (${baseline.width}, ${baseline.height}) vs (${current.width}, ${current.height})\n`,
  );
  process.exit(1);
}

const { image, rms } = diffImages(baseline, current);
// Only worth writing a diff when there is something to look at.
if (rms > 0) image.toFile(out);

if (rms <= maxRms) process.exit(0);
console.log(`Images differ (RMS=${rms.toFixed(4)}, threshold=${maxRms.toFixed(4)}). Wrote ${out}`);
process.exit(1);
