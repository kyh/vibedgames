import { Bitmap } from "../image/raster.js";

/**
 * Recover the underlying low-resolution pixel-art grid from an upscaled or
 * AI-generated image. Ported from the Python port of
 * Hugo-Dz/spritefusion-pixel-snapper.
 *
 * Pipeline:
 *   1. K-means quantize the palette.
 *   2. Compute 1-D edge-gradient profiles along x and y.
 *   3. Estimate the cell pitch as the median peak spacing per axis.
 *   4. Walk each axis placing cuts that snap to nearby edge peaks.
 *   5. Resample: one output pixel per cell, taking the majority colour.
 *
 * ONE DELIBERATE DEVIATION. The Python version seeds its k-means centroids
 * from `numpy.random.default_rng(seed).choice(...)`. Reproducing that stream
 * exactly would mean reimplementing numpy's SeedSequence and PCG64 bit for
 * bit, so this uses its own seeded generator instead. Everything downstream —
 * the gradient profiles, pitch estimation, cut walking and resampling — is a
 * faithful port, so the recovered grid (the point of the tool) is unchanged;
 * only which pixels seed the initial palette differs, and k-means converges
 * from there. Runs remain fully deterministic for a given `--seed`.
 */

export type SnapConfig = {
  kColors: number;
  kSeed: number;
  maxKmeansIterations: number;
  peakThresholdMultiplier: number;
  peakDistanceFilter: number;
  walkerSearchWindowRatio: number;
  walkerMinSearchWindow: number;
  walkerStrengthThreshold: number;
  fallbackTargetSegments: number;
  maxStepRatio: number;
};

export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  kColors: 16,
  kSeed: 42,
  maxKmeansIterations: 15,
  peakThresholdMultiplier: 0.2,
  peakDistanceFilter: 4,
  walkerSearchWindowRatio: 0.35,
  walkerMinSearchWindow: 2,
  walkerStrengthThreshold: 0.5,
  fallbackTargetSegments: 64,
  maxStepRatio: 1.8,
};

/** mulberry32 — small, fast, and fully determined by its seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` distinct indices below `limit`, via a partial Fisher-Yates shuffle. */
function sampleWithoutReplacement(limit: number, count: number, seed: number): number[] {
  const random = makeRandom(seed);
  const pool = new Int32Array(limit);
  for (let i = 0; i < limit; i += 1) pool[i] = i;
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(random() * (limit - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return Array.from(pool.subarray(0, count));
}

/** K-means over the opaque pixels; returns a palette-quantized copy. */
export function quantize(image: Bitmap, config: SnapConfig): Bitmap {
  const opaque: number[] = [];
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3]! > 0) opaque.push(i);
  }
  if (opaque.length === 0) return image.copy();

  const k = Math.min(config.kColors, opaque.length);
  const centers = sampleWithoutReplacement(opaque.length, k, config.kSeed).map((index) => {
    const p = opaque[index]!;
    return [image.data[p]!, image.data[p + 1]!, image.data[p + 2]!];
  });

  const labels = new Int32Array(opaque.length);
  for (let iteration = 0; iteration < config.maxKmeansIterations; iteration += 1) {
    for (let n = 0; n < opaque.length; n += 1) {
      const p = opaque[n]!;
      const r = image.data[p]!;
      const g = image.data[p + 1]!;
      const b = image.data[p + 2]!;
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centers.length; c += 1) {
        const center = centers[c]!;
        const dr = r - center[0]!;
        const dg = g - center[1]!;
        const db = b - center[2]!;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      labels[n] = best;
    }

    let moved = false;
    for (let c = 0; c < centers.length; c += 1) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let members = 0;
      for (let n = 0; n < opaque.length; n += 1) {
        if (labels[n] !== c) continue;
        const p = opaque[n]!;
        sumR += image.data[p]!;
        sumG += image.data[p + 1]!;
        sumB += image.data[p + 2]!;
        members += 1;
      }
      // An empty cluster keeps its centre rather than collapsing to the origin.
      if (members === 0) continue;
      const next = [sumR / members, sumG / members, sumB / members];
      const center = centers[c]!;
      // The original's convergence test: a centre that shifts less than half a
      // level counts as settled.
      if (next.some((value, i) => Math.abs(value - center[i]!) > 0.5)) moved = true;
      centers[c] = next;
    }
    if (!moved) break;
  }

  const out = image.copy();
  for (let n = 0; n < opaque.length; n += 1) {
    const p = opaque[n]!;
    const center = centers[labels[n]!]!;
    out.data[p] = Math.round(center[0]!);
    out.data[p + 1] = Math.round(center[1]!);
    out.data[p + 2] = Math.round(center[2]!);
  }
  return out;
}

/** Per-column and per-row edge-gradient sums; transparent pixels weigh zero. */
export function computeProfiles(image: Bitmap): { columns: Float64Array; rows: Float64Array } {
  const { width: w, height: h } = image;
  if (w < 3 || h < 3) throw new Error("Image too small (minimum 3x3)");

  const luma = new Float64Array(w * h);
  for (let i = 0; i < luma.length; i += 1) {
    const p = i * 4;
    if (image.data[p + 3] === 0) continue;
    luma[i] = 0.299 * image.data[p]! + 0.587 * image.data[p + 1]! + 0.114 * image.data[p + 2]!;
  }

  // Central differences, leaving the outermost row/column at zero.
  const columns = new Float64Array(w);
  for (let x = 1; x < w - 1; x += 1) {
    let sum = 0;
    for (let y = 0; y < h; y += 1) sum += Math.abs(luma[y * w + x + 1]! - luma[y * w + x - 1]!);
    columns[x] = sum;
  }

  const rows = new Float64Array(h);
  for (let y = 1; y < h - 1; y += 1) {
    let sum = 0;
    for (let x = 0; x < w; x += 1) sum += Math.abs(luma[(y + 1) * w + x]! - luma[(y - 1) * w + x]!);
    rows[y] = sum;
  }

  return { columns, rows };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median spacing between gradient peaks — the estimated cell pitch. */
export function estimateStepSize(profile: Float64Array, config: SnapConfig): number | null {
  if (profile.length === 0) return null;
  let max = 0;
  for (const value of profile) if (value > max) max = value;
  if (max === 0) return null;
  const threshold = max * config.peakThresholdMultiplier;

  const peaks: number[] = [];
  for (let i = 1; i < profile.length - 1; i += 1) {
    const value = profile[i]!;
    if (value > threshold && value > profile[i - 1]! && value > profile[i + 1]!) peaks.push(i);
  }
  if (peaks.length < 2) return null;

  // Collapse peaks that sit within the distance filter of the previous keeper,
  // so one thick edge does not read as several cells.
  const clean = [peaks[0]!];
  for (const peak of peaks.slice(1)) {
    if (peak - clean[clean.length - 1]! > config.peakDistanceFilter - 1) clean.push(peak);
  }
  if (clean.length < 2) return null;

  const diffs = clean.slice(1).map((value, i) => value - clean[i]!);
  return medianOf(diffs);
}

export function resolveStepSizes(
  sx: number | null,
  sy: number | null,
  width: number,
  height: number,
  config: SnapConfig,
): [number, number] {
  if (sx !== null && sy !== null) {
    // Wildly different pitches mean one axis was misread; trust the smaller.
    const ratio = Math.max(sx, sy) / Math.min(sx, sy);
    if (ratio > config.maxStepRatio) {
      const smaller = Math.min(sx, sy);
      return [smaller, smaller];
    }
    const average = (sx + sy) / 2;
    return [average, average];
  }
  if (sx !== null) return [sx, sx];
  if (sy !== null) return [sy, sy];
  const fallback = Math.max(Math.min(width, height) / config.fallbackTargetSegments, 1);
  return [fallback, fallback];
}

/** Place cuts one pitch apart, snapping each to a nearby gradient peak. */
export function walk(
  profile: Float64Array,
  stepSize: number,
  limit: number,
  config: SnapConfig,
): number[] {
  if (profile.length === 0) throw new Error("Empty profile");
  const cuts = [0];
  let pos = 0;
  const window = Math.max(stepSize * config.walkerSearchWindowRatio, config.walkerMinSearchWindow);
  const mean = profile.reduce((sum, v) => sum + v, 0) / profile.length;

  while (pos < limit) {
    const target = pos + stepSize;
    if (target >= limit) {
      cuts.push(limit);
      break;
    }
    const start = Math.max(Math.trunc(target - window), Math.trunc(pos + 1));
    const end = Math.min(Math.trunc(target + window), limit);
    if (end <= start) {
      pos = target;
      continue;
    }

    let localMax = -Infinity;
    let localIndex = start;
    for (let i = start; i < end; i += 1) {
      if (profile[i]! > localMax) {
        localMax = profile[i]!;
        localIndex = i;
      }
    }

    // Snap only to a genuinely strong edge; otherwise keep the ideal pitch, so
    // a flat region does not drag the grid off alignment.
    if (localMax > mean * config.walkerStrengthThreshold) {
      cuts.push(localIndex);
      pos = localIndex;
    } else {
      cuts.push(Math.trunc(target));
      pos = target;
    }
  }
  return cuts;
}

export function sanitizeCuts(cuts: number[], limit: number): number[] {
  const seen = [...new Set(cuts.filter((c) => c >= 0 && c <= limit))].sort((a, b) => a - b);
  if (seen.length === 0 || seen[0] !== 0) seen.unshift(0);
  if (seen[seen.length - 1] !== limit) seen.push(limit);

  const deduped: number[] = [];
  for (const cut of seen) {
    if (deduped.length === 0 || cut > deduped[deduped.length - 1]!) deduped.push(cut);
  }
  return deduped;
}

/** One output pixel per cell, taking the most common opaque colour. */
export function resample(image: Bitmap, colCuts: number[], rowCuts: number[]): Bitmap {
  const out = Bitmap.create(colCuts.length - 1, rowCuts.length - 1);
  for (let j = 0; j < out.height; j += 1) {
    const y0 = rowCuts[j]!;
    const y1 = rowCuts[j + 1]!;
    for (let i = 0; i < out.width; i += 1) {
      const x0 = colCuts[i]!;
      const x1 = colCuts[i + 1]!;
      const counts = new Map<number, { count: number; rgba: [number, number, number, number] }>();
      let first = true;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (!image.contains(x, y)) continue;
          const p = image.index(x, y);
          if (image.data[p + 3]! <= 0) continue;
          const rgba: [number, number, number, number] = [
            image.data[p]!,
            image.data[p + 1]!,
            image.data[p + 2]!,
            image.data[p + 3]!,
          ];
          const key = (rgba[0] << 24) | (rgba[1] << 16) | (rgba[2] << 8) | rgba[3];
          const entry = counts.get(key);
          if (entry) entry.count += 1;
          else counts.set(key, { count: 1, rgba });
          first = false;
        }
      }
      if (first) continue; // wholly transparent cell stays transparent

      // Ties go to the colour seen first, matching Counter.most_common.
      let best: { count: number; rgba: [number, number, number, number] } | null = null;
      for (const entry of counts.values()) {
        if (!best || entry.count > best.count) best = entry;
      }
      if (best) out.putPixel(i, j, best.rgba);
    }
  }
  return out;
}

/** Run the full pipeline, returning the snapped image. */
export function snapImage(inputPath: string, config: SnapConfig): Bitmap {
  const image = Bitmap.fromFile(inputPath);
  const quantized = quantize(image, config);
  const { columns, rows } = computeProfiles(quantized);
  const [stepX, stepY] = resolveStepSizes(
    estimateStepSize(columns, config),
    estimateStepSize(rows, config),
    image.width,
    image.height,
    config,
  );
  const colCuts = sanitizeCuts(walk(columns, stepX, image.width, config), image.width);
  const rowCuts = sanitizeCuts(walk(rows, stepY, image.height, config), image.height);
  return resample(quantized, colCuts, rowCuts);
}
