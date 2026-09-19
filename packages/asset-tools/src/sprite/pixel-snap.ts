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
 * ONE DELIBERATE DEVIATION, with a measured blast radius. The Python version
 * seeds its k-means centroids from `numpy.random.default_rng(seed).choice(...)`.
 * Reproducing that stream exactly would mean reimplementing numpy's
 * SeedSequence and PCG64 bit for bit, so this uses its own seeded generator.
 * Everything downstream — gradient profiles, pitch estimation, cut walking,
 * resampling — is a faithful port.
 *
 * What that costs, measured against the Python original:
 *
 *  - On dense, high-contrast input (real pixel art, the intended use) output
 *    is byte-identical, including the recovered frame dimensions.
 *  - On input too sparse or low-contrast for the gradient profiles to show a
 *    clear pitch, the algorithm is hypersensitive to its palette and the two
 *    implementations can land on different cuts — and therefore different
 *    output dimensions. Neither result is meaningful there; the tool has
 *    failed to find a grid either way.
 *
 * So the deviation is invisible where the tool works and only surfaces where
 * it doesn't. Runs stay fully deterministic for a given `--seed`.
 */

export interface SnapConfig {
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
}

export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  fallbackTargetSegments: 64,
  kColors: 16,
  kSeed: 42,
  maxKmeansIterations: 15,
  maxStepRatio: 1.8,
  peakDistanceFilter: 4,
  peakThresholdMultiplier: 0.2,
  walkerMinSearchWindow: 2,
  walkerSearchWindowRatio: 0.35,
  walkerStrengthThreshold: 0.5,
};

/** mulberry32 — small, fast, and fully determined by its seed. */
/* oxlint-disable no-bitwise -- mulberry32 is defined on uint32 wraparound and xorshift mixing */
const makeRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};
/* oxlint-enable no-bitwise */

/** `count` distinct indices below `limit`, via a partial Fisher-Yates shuffle. */
const sampleWithoutReplacement = (limit: number, count: number, seed: number): number[] => {
  const random = makeRandom(seed);
  const pool = new Int32Array(limit);
  for (let i = 0; i < limit; i += 1) {
    pool[i] = i;
  }
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(random() * (limit - i));
    const tmp = pool[i] ?? 0;
    pool[i] = pool[j] ?? 0;
    pool[j] = tmp;
  }
  return [...pool.subarray(0, count)];
};

type Rgb = [number, number, number];

const rgbAt = (data: Uint8Array, p: number): Rgb => [
  data[p] ?? 0,
  data[p + 1] ?? 0,
  data[p + 2] ?? 0,
];

const nearestCenter = ([r, g, b]: Rgb, centers: Rgb[]): number => {
  let best = 0;
  let bestDist = Infinity;
  for (const [c, center] of centers.entries()) {
    const dr = r - center[0];
    const dg = g - center[1];
    const db = b - center[2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
};

/** Move every centre to its members' mean; reports whether any centre moved. */
const updateCenters = (
  image: Bitmap,
  opaque: number[],
  labels: Int32Array,
  centers: Rgb[],
): boolean => {
  let moved = false;
  for (const [c, center] of centers.entries()) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let members = 0;
    for (let n = 0; n < opaque.length; n += 1) {
      if (labels[n] !== c) {
        continue;
      }
      const [r, g, b] = rgbAt(image.data, opaque[n] ?? 0);
      sumR += r;
      sumG += g;
      sumB += b;
      members += 1;
    }
    // An empty cluster keeps its centre rather than collapsing to the origin.
    if (members === 0) {
      continue;
    }
    const next: Rgb = [sumR / members, sumG / members, sumB / members];
    // The original's convergence test: a centre that shifts less than half a
    // level counts as settled.
    if (
      Math.abs(next[0] - center[0]) > 0.5 ||
      Math.abs(next[1] - center[1]) > 0.5 ||
      Math.abs(next[2] - center[2]) > 0.5
    ) {
      moved = true;
    }
    centers[c] = next;
  }
  return moved;
};

/** K-means over the opaque pixels; returns a palette-quantized copy. */
export const quantize = (image: Bitmap, config: SnapConfig): Bitmap => {
  const opaque: number[] = [];
  for (let i = 0; i < image.data.length; i += 4) {
    if ((image.data[i + 3] ?? 0) > 0) {
      opaque.push(i);
    }
  }
  if (opaque.length === 0) {
    return image.copy();
  }

  const k = Math.min(config.kColors, opaque.length);
  const centers = sampleWithoutReplacement(opaque.length, k, config.kSeed).map((index) =>
    rgbAt(image.data, opaque[index] ?? 0),
  );

  const labels = new Int32Array(opaque.length);
  for (let iteration = 0; iteration < config.maxKmeansIterations; iteration += 1) {
    for (let n = 0; n < opaque.length; n += 1) {
      labels[n] = nearestCenter(rgbAt(image.data, opaque[n] ?? 0), centers);
    }
    if (!updateCenters(image, opaque, labels, centers)) {
      break;
    }
  }

  const out = image.copy();
  for (let n = 0; n < opaque.length; n += 1) {
    const p = opaque[n] ?? 0;
    const center = centers[labels[n] ?? 0];
    if (center === undefined) {
      continue;
    }
    out.data[p] = Math.round(center[0]);
    out.data[p + 1] = Math.round(center[1]);
    out.data[p + 2] = Math.round(center[2]);
  }
  return out;
};

export interface AxisProfiles {
  columns: Float64Array;
  rows: Float64Array;
}

/** Per-column and per-row edge-gradient sums; transparent pixels weigh zero. */
export const computeProfiles = (image: Bitmap): AxisProfiles => {
  const { width: w, height: h } = image;
  if (w < 3 || h < 3) {
    throw new Error("Image too small (minimum 3x3)");
  }

  const luma = new Float64Array(w * h);
  for (let i = 0; i < luma.length; i += 1) {
    const p = i * 4;
    if (image.data[p + 3] === 0) {
      continue;
    }
    luma[i] =
      0.299 * (image.data[p] ?? 0) +
      0.587 * (image.data[p + 1] ?? 0) +
      0.114 * (image.data[p + 2] ?? 0);
  }

  // Central differences, leaving the outermost row/column at zero.
  const columns = new Float64Array(w);
  for (let x = 1; x < w - 1; x += 1) {
    let sum = 0;
    for (let y = 0; y < h; y += 1) {
      sum += Math.abs((luma[y * w + x + 1] ?? 0) - (luma[y * w + x - 1] ?? 0));
    }
    columns[x] = sum;
  }

  const rows = new Float64Array(h);
  for (let y = 1; y < h - 1; y += 1) {
    let sum = 0;
    for (let x = 0; x < w; x += 1) {
      sum += Math.abs((luma[(y + 1) * w + x] ?? 0) - (luma[(y - 1) * w + x] ?? 0));
    }
    rows[y] = sum;
  }

  return { columns, rows };
};

const medianOf = (values: number[]): number => {
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
};

/** Median spacing between gradient peaks — the estimated cell pitch. */
export const estimateStepSize = (profile: Float64Array, config: SnapConfig): number | null => {
  if (profile.length === 0) {
    return null;
  }
  let max = 0;
  for (const value of profile) {
    if (value > max) {
      max = value;
    }
  }
  if (max === 0) {
    return null;
  }
  const threshold = max * config.peakThresholdMultiplier;

  const peaks: number[] = [];
  for (let i = 1; i < profile.length - 1; i += 1) {
    const value = profile[i] ?? 0;
    if (value > threshold && value > (profile[i - 1] ?? 0) && value > (profile[i + 1] ?? 0)) {
      peaks.push(i);
    }
  }
  if (peaks.length < 2) {
    return null;
  }

  // Collapse peaks that sit within the distance filter of the previous keeper,
  // so one thick edge does not read as several cells.
  const clean: number[] = [];
  for (const peak of peaks) {
    const last = clean.at(-1);
    if (last === undefined || peak - last > config.peakDistanceFilter - 1) {
      clean.push(peak);
    }
  }
  if (clean.length < 2) {
    return null;
  }

  const diffs = clean.slice(1).map((value, i) => value - (clean[i] ?? 0));
  return medianOf(diffs);
};

export const resolveStepSizes = (
  sx: number | null,
  sy: number | null,
  width: number,
  height: number,
  config: SnapConfig,
): [number, number] => {
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
  if (sx !== null) {
    return [sx, sx];
  }
  if (sy !== null) {
    return [sy, sy];
  }
  const fallback = Math.max(Math.min(width, height) / config.fallbackTargetSegments, 1);
  return [fallback, fallback];
};

/** Place cuts one pitch apart, snapping each to a nearby gradient peak. */
export const walk = (
  profile: Float64Array,
  stepSize: number,
  limit: number,
  config: SnapConfig,
): number[] => {
  if (profile.length === 0) {
    throw new Error("Empty profile");
  }
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
      const value = profile[i] ?? 0;
      if (value > localMax) {
        localMax = value;
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
};

export const sanitizeCuts = (cuts: number[], limit: number): number[] => {
  const seen = [...new Set(cuts.filter((c) => c >= 0 && c <= limit))].toSorted((a, b) => a - b);
  if (seen.length === 0 || seen[0] !== 0) {
    seen.unshift(0);
  }
  if (seen.at(-1) !== limit) {
    seen.push(limit);
  }

  const deduped: number[] = [];
  for (const cut of seen) {
    const last = deduped.at(-1);
    if (last === undefined || cut > last) {
      deduped.push(cut);
    }
  }
  return deduped;
};

type Rgba = [number, number, number, number];

/** The most common opaque colour in a cell, or null when it is wholly transparent. */
const majorityColor = (
  image: Bitmap,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): Rgba | null => {
  const counts = new Map<number, { count: number; rgba: Rgba }>();
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (!image.contains(x, y)) {
        continue;
      }
      const p = image.index(x, y);
      const alpha = image.data[p + 3] ?? 0;
      if (alpha <= 0) {
        continue;
      }
      const rgba: Rgba = [...rgbAt(image.data, p), alpha];
      const key = rgba[0] * 2 ** 24 + rgba[1] * 2 ** 16 + rgba[2] * 2 ** 8 + rgba[3];
      const entry = counts.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        counts.set(key, { count: 1, rgba });
      }
    }
  }

  // Ties go to the colour seen first, matching Counter.most_common.
  let best: { count: number; rgba: Rgba } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) {
      best = entry;
    }
  }
  return best ? best.rgba : null;
};

/** One output pixel per cell, taking the most common opaque colour. */
export const resample = (image: Bitmap, colCuts: number[], rowCuts: number[]): Bitmap => {
  const out = Bitmap.create(colCuts.length - 1, rowCuts.length - 1);
  for (let j = 0; j < out.height; j += 1) {
    const y0 = rowCuts[j] ?? 0;
    const y1 = rowCuts[j + 1] ?? 0;
    for (let i = 0; i < out.width; i += 1) {
      const x0 = colCuts[i] ?? 0;
      const x1 = colCuts[i + 1] ?? 0;
      const color = majorityColor(image, x0, x1, y0, y1);
      if (color) {
        out.putPixel(i, j, color);
      }
    }
  }
  return out;
};

/** Run the full pipeline, returning the snapped image. */
export const snapImage = (inputPath: string, config: SnapConfig): Bitmap => {
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
};

/**
 * Below this the "recovered grid" is not a sprite. It happens when the image is
 * mostly flat — a lone figure on an unkeyed matte, say — and the only strong
 * edges are the few the background contributes, so the walker finds two or three
 * cuts across the whole picture.
 */
const DEGENERATE_SIDE = 8;

/**
 * Why the caller should distrust a snap result, or null when it looks sane.
 *
 * The snapper cannot fail loudly on its own — a 2x2 output is a legal image and
 * writing it is a legal outcome — so the judgement has to live next to the
 * dimensions rather than inside the pipeline.
 */
export const snapWarning = (input: Bitmap, output: Bitmap, config: SnapConfig): string | null => {
  if (output.width < DEGENERATE_SIDE || output.height < DEGENERATE_SIDE) {
    return (
      `recovered grid collapsed to ${output.width}x${output.height} from ` +
      `${input.width}x${input.height} — there was no pixel grid to find. Key the ` +
      `background out first (a flat matte hides the grid), or the source is not ` +
      `upscaled pixel art at all`
    );
  }
  const fallback = config.fallbackTargetSegments;
  if (output.width === fallback && output.height === fallback) {
    return (
      `output is exactly ${fallback}x${fallback}: step detection found no structure ` +
      `and fell back to a fixed segment count, so these are not the source's own pixels`
    );
  }
  return null;
};

export interface SheetSnapInfo {
  inputDims: [number, number];
  inputFrameDims: [number, number];
  targetFrameDims: [number, number];
  outputDims: [number, number];
}

export interface SheetSnapResult {
  image: Bitmap;
  info: SheetSnapInfo;
}

/**
 * Spritesheet-aware snapping: crop the sheet into frames, snap them all to ONE
 * shared pixel grid, and reassemble.
 *
 * Cropping first matters. A raw sheet has two competing scales — the frame
 * size and the intra-frame pixel cell — and step-size detection cannot tell
 * them apart. Cropping removes the frame-grid scale; tight-packing the crops
 * into a single strip and snapping that once leaves one pitch to recover, so
 * every frame lands at the same scale with no size drift between them.
 */
export const snapSheet = (
  image: Bitmap,
  cols: number,
  rows: number,
  config: SnapConfig,
): SheetSnapResult => {
  const { width: W, height: H } = image;
  if (W % cols !== 0 || H % rows !== 0) {
    throw new Error(
      `Sheet ${W}x${H} is not divisible by cols=${cols} rows=${rows}; ` +
        "frames would be non-integer dimensions.",
    );
  }

  const fw = W / cols;
  const fh = H / rows;
  const count = cols * rows;

  // Lay the frames out in one tight strip, row-major.
  const strip = Bitmap.create(fw * count, fh);
  for (let index = 0; index < count; index += 1) {
    const r = Math.floor(index / cols);
    const c = index - r * cols;
    strip.paste(
      image.crop({ bottom: (r + 1) * fh, left: c * fw, right: (c + 1) * fw, top: r * fh }),
      index * fw,
      0,
    );
  }

  const quantized = quantize(strip, config);
  const { columns, rows: rowProfile } = computeProfiles(quantized);
  const [stepX, stepY] = resolveStepSizes(
    estimateStepSize(columns, config),
    estimateStepSize(rowProfile, config),
    strip.width,
    strip.height,
    config,
  );
  const snapped = resample(
    quantized,
    sanitizeCuts(walk(columns, stepX, strip.width, config), strip.width),
    sanitizeCuts(walk(rowProfile, stepY, strip.height, config), strip.height),
  );

  // Shared native frame width; trailing remainder columns are empty margin.
  const tw = Math.floor(snapped.width / count);
  const sh = snapped.height;

  const out = Bitmap.create(tw * cols, sh * rows);
  for (let index = 0; index < count; index += 1) {
    const r = Math.floor(index / cols);
    const c = index - r * cols;
    out.paste(
      snapped.crop({ bottom: sh, left: index * tw, right: (index + 1) * tw, top: 0 }),
      c * tw,
      r * sh,
    );
  }

  return {
    image: out,
    info: {
      inputDims: [W, H],
      inputFrameDims: [fw, fh],
      outputDims: [tw * cols, sh * rows],
      targetFrameDims: [tw, sh],
    },
  };
};
