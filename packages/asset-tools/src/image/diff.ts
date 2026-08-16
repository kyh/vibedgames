import { Bitmap } from "./raster.js";

/**
 * Absolute per-channel difference between two images, plus the overall RMS —
 * the visual-regression comparison behind the playwright skill's screenshot
 * assertions.
 */

export type DiffResult = {
  image: Bitmap;
  /** Root-mean-square across all four channels, 0 when identical. */
  rms: number;
  /** Per-channel RMS in R, G, B, A order. */
  channelRms: number[];
};

export function diffImages(baseline: Bitmap, current: Bitmap): DiffResult {
  if (baseline.width !== current.width || baseline.height !== current.height) {
    throw new Error(
      `Different sizes: (${baseline.width}, ${baseline.height}) vs (${current.width}, ${current.height})`,
    );
  }

  const out = new Bitmap(baseline.width, baseline.height);
  // Squared error per channel, accumulated over every pixel — this is what
  // `ImageStat.Stat(diff).rms` reports for the difference image.
  const sums = [0, 0, 0, 0];
  for (let i = 0; i < out.data.length; i += 1) {
    const delta = Math.abs(baseline.data[i]! - current.data[i]!);
    out.data[i] = delta;
    sums[i % 4]! += delta * delta;
  }

  const pixels = baseline.width * baseline.height;
  const channelRms = sums.map((sum) => Math.sqrt(sum / pixels));
  const rms = Math.sqrt(channelRms.reduce((sum, v) => sum + v * v, 0) / channelRms.length);
  return { image: out, rms, channelRms };
}
