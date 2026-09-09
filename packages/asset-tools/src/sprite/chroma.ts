import { Bitmap } from "../image/raster.js";
import type { RGB } from "../image/raster.js";

/**
 * Chroma matte cleanup: key a flat matte to transparency, sweep matte-tinted
 * fringe, and despill residual tint on the edge band.
 *
 * An alternative to segmentation background removal. Generate sprites on a
 * flat chroma matte (#00FF00 by default, #FF00FF when the subject is green),
 * key the matte out, then clean the fringe and despill.
 */

export const HIGH_FRINGE_REMOVAL_RATIO = 0.02;

export const colorDistance = (a: RGB, b: RGB): number =>
  // oxlint-disable-next-line unicorn/prefer-modern-math-apis -- Math.hypot rounds differently from sqrt of an exact integer sum; tolerance boundaries must match the Python original
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

export interface FringeChannels {
  dominant: number[];
  suppressed: number[];
}

/**
 * Split RGB channel indices into matte-dominant and matte-suppressed groups.
 * Throws when the matte cannot be split (grey or white), because fringe
 * detection needs at least one high and one low channel.
 */
export const chromaFringeChannels = (chroma: RGB): FringeChannels => {
  const dominant = [0, 1, 2].filter((i) => (chroma[i] ?? 0) >= 128);
  const suppressed = [0, 1, 2].filter((i) => (chroma[i] ?? 0) < 128);
  if (dominant.length === 0 || suppressed.length === 0) {
    throw new Error(
      `chroma (${chroma.join(", ")}) cannot be split into dominant/suppressed channels; ` +
        "fringe cleanup needs a saturated matte color such as #00FF00 or #FF00FF",
    );
  }
  return { dominant, suppressed };
};

/** Strongly green-dominant matte — the legacy green path. */
export const isGreenMatte = (chroma: RGB): boolean =>
  chroma[1] >= 180 && chroma[1] - Math.max(chroma[0], chroma[2]) >= 80;

/** Saturated enough for fringe cleanup. */
export const isKeyableFringeChroma = (chroma: RGB): boolean => {
  let split;
  try {
    split = chromaFringeChannels(chroma);
  } catch {
    return false;
  }
  const low = Math.min(...split.dominant.map((i) => chroma[i] ?? 0));
  const high = Math.max(...split.suppressed.map((i) => chroma[i] ?? 0));
  return low >= 180 && low - high >= 80;
};

export const fringeWarning = (removed: number, kept: number, chroma: RGB): string | null => {
  const total = removed + kept;
  if (total <= 0) {
    return null;
  }
  if (removed / total < HIGH_FRINGE_REMOVAL_RATIO) {
    return null;
  }
  return isGreenMatte(chroma)
    ? "high green-fringe removal ratio; green foreground details may have been removed. " +
        "Use a non-green matte such as #FF00FF, or pass --no-decontam to keep green specks."
    : "high fringe removal ratio; foreground details close to the matte color may have " +
        "been removed. Use a matte color absent from the sprite, or pass --no-decontam.";
};

/**
 * Flood transparency inward from the border, marking every transparent pixel
 * reachable from outside.
 *
 * This is what protects matte-coloured detail *inside* the sprite: a green
 * highlight enclosed by the character is transparent-eligible by colour but
 * unreachable from the edge, so it survives keying.
 *
 * `isFloodable(index)` reports whether a pixel counts as transparent.
 */
export const backgroundReachable = (
  width: number,
  height: number,
  isFloodable: (index: number) => boolean,
): Uint8Array => {
  const reachable = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const enqueue = (x: number, y: number) => {
    const index = y * width + x;
    if (reachable[index] || !isFloodable(index)) {
      return;
    }
    reachable[index] = 1;
    queue[tail] = index;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (head < tail) {
    const index = queue[head] ?? 0;
    head += 1;
    const y = Math.floor(index / width);
    const x = index - y * width;
    if (x + 1 < width) {
      enqueue(x + 1, y);
    }
    if (x > 0) {
      enqueue(x - 1, y);
    }
    if (y + 1 < height) {
      enqueue(x, y + 1);
    }
    if (y > 0) {
      enqueue(x, y - 1);
    }
  }
  return reachable;
};

const hasBackgroundNeighbor = (
  reachable: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): boolean => {
  for (let ny = Math.max(0, y - radius); ny < Math.min(height, y + radius + 1); ny += 1) {
    for (let nx = Math.max(0, x - radius); nx < Math.min(width, x + radius + 1); nx += 1) {
      if (nx === x && ny === y) {
        continue;
      }
      if (reachable[ny * width + nx]) {
        return true;
      }
    }
  }
  return false;
};

/** Keep only connected opaque components of at least `minArea` pixels. */
export const keepLargestComponents = (image: Bitmap, minArea: number): Bitmap => {
  const { width, height } = image;
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const out = Bitmap.create(width, height);
  let head = 0;
  let tail = 0;
  const visit = (nx: number, ny: number) => {
    const n = ny * width + nx;
    if (seen[n] || image.data[n * 4 + 3] === 0) {
      return;
    }
    seen[n] = 1;
    queue[tail] = n;
    tail += 1;
  };

  for (let startY = 0; startY < height; startY += 1) {
    for (let startX = 0; startX < width; startX += 1) {
      const start = startY * width + startX;
      if (seen[start] || image.data[start * 4 + 3] === 0) {
        continue;
      }

      head = 0;
      tail = 0;
      queue[tail] = start;
      tail += 1;
      seen[start] = 1;
      const points: number[] = [];

      while (head < tail) {
        const index = queue[head] ?? 0;
        head += 1;
        points.push(index);
        const y = Math.floor(index / width);
        const x = index - y * width;
        if (x + 1 < width) {
          visit(x + 1, y);
        }
        if (x > 0) {
          visit(x - 1, y);
        }
        if (y + 1 < height) {
          visit(x, y + 1);
        }
        if (y > 0) {
          visit(x, y - 1);
        }
      }

      if (points.length >= minArea) {
        for (const index of points) {
          const p = index * 4;
          out.data[p] = image.data[p] ?? 0;
          out.data[p + 1] = image.data[p + 1] ?? 0;
          out.data[p + 2] = image.data[p + 2] ?? 0;
          out.data[p + 3] = image.data[p + 3] ?? 0;
        }
      }
    }
  }
  return out;
};

export interface KeyRecord {
  chromaRgb: number[];
  tolerance: number;
  keepLargest: boolean;
  minComponentArea: number | null;
  removedPixels: number;
  inToleranceCandidates: number;
  keptPixels: number;
  bbox: number[] | null;
}

export interface KeyMatteResult {
  image: Bitmap;
  record: KeyRecord;
}

/** 1 marks a transparent candidate; `count` is how many of those were opaque matte. */
const matteCandidates = (image: Bitmap, chroma: RGB, tolerance: number) => {
  const candidate = new Uint8Array(image.width * image.height);
  let count = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    const p = index * 4;
    if (image.data[p + 3] === 0) {
      candidate[index] = 1;
      continue;
    }
    const rgb: RGB = [image.data[p] ?? 0, image.data[p + 1] ?? 0, image.data[p + 2] ?? 0];
    if (colorDistance(rgb, chroma) <= tolerance) {
      candidate[index] = 1;
      count += 1;
    }
  }
  return { candidate, count };
};

/**
 * Key a flat chroma matte to transparency.
 *
 * Pixels within `tolerance` (Euclidean RGB distance) of the matte become
 * candidates; a flood from the border then confines removal to matte actually
 * reachable from outside, so enclosed matte-coloured sprite detail survives.
 */
export const keyMatte = (
  image: Bitmap,
  options: { chroma: RGB; tolerance?: number; keepLargest?: boolean; minComponentArea?: number },
): KeyMatteResult => {
  const { chroma, tolerance = 90, keepLargest = false, minComponentArea = 80 } = options;
  const { width, height } = image;
  const { candidate, count: candidates } = matteCandidates(image, chroma, tolerance);

  const reachable = backgroundReachable(width, height, (index) => candidate[index] === 1);

  let out = Bitmap.create(width, height);
  let removed = 0;
  let kept = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    const p = index * 4;
    const alpha = image.data[p + 3] ?? 0;
    if (reachable[index]) {
      if (alpha !== 0) {
        removed += 1;
      }
      continue;
    }
    if (alpha === 0) {
      continue;
    }
    out.data[p] = image.data[p] ?? 0;
    out.data[p + 1] = image.data[p + 1] ?? 0;
    out.data[p + 2] = image.data[p + 2] ?? 0;
    out.data[p + 3] = alpha;
    kept += 1;
  }

  if (keepLargest) {
    out = keepLargestComponents(out, minComponentArea);
  }
  const bbox = out.getBBox();

  return {
    image: out,
    record: {
      bbox: bbox ? [bbox.left, bbox.top, bbox.right, bbox.bottom] : null,
      chromaRgb: [...chroma],
      inToleranceCandidates: candidates,
      keepLargest,
      keptPixels: kept,
      minComponentArea: keepLargest ? minComponentArea : null,
      removedPixels: removed,
      tolerance,
    },
  };
};

export interface FringeRecord {
  chromaRgb: number[];
  removedFringePixels: number;
  keptPixels: number;
  removedToKeptRatio: number;
  minLevel: number;
  dominance: number;
  edgeRadius: number;
  bbox: number[] | null;
  warning: string | null;
}

export interface FringeCleanResult {
  image: Bitmap;
  record: FringeRecord;
}

/**
 * Remove matte-tinted fringe pixels that touch background-reachable
 * transparency — the antialiased halo left where the sprite met the matte.
 *
 * A pixel is fringe when every matte-dominant channel is at least `minLevel`
 * and exceeds every suppressed channel by `dominance`. For a green matte this
 * reduces exactly to the legacy green-fringe test.
 */
export const removeChromaFringe = (
  image: Bitmap,
  options: { chroma: RGB; minLevel?: number; dominance?: number; edgeRadius?: number },
): FringeCleanResult => {
  const { chroma, minLevel = 70, dominance = 24, edgeRadius = 1 } = options;
  const { dominant, suppressed } = chromaFringeChannels(chroma);
  const { width, height } = image;

  const reachable = backgroundReachable(width, height, (index) => image.data[index * 4 + 3] === 0);
  const out = Bitmap.create(width, height);
  let removed = 0;
  let kept = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = image.index(x, y);
      const alpha = image.data[p + 3] ?? 0;
      if (alpha === 0) {
        continue;
      }
      const rgb: RGB = [image.data[p] ?? 0, image.data[p + 1] ?? 0, image.data[p + 2] ?? 0];
      const low = Math.min(...dominant.map((i) => rgb[i] ?? 0));
      const high = Math.max(...suppressed.map((i) => rgb[i] ?? 0));

      if (
        hasBackgroundNeighbor(reachable, x, y, width, height, edgeRadius) &&
        low >= minLevel &&
        low - high >= dominance
      ) {
        removed += 1;
        continue;
      }
      [out.data[p], out.data[p + 1], out.data[p + 2]] = rgb;
      out.data[p + 3] = alpha;
      kept += 1;
    }
  }

  const bbox = out.getBBox();
  return {
    image: out,
    record: {
      bbox: bbox ? [bbox.left, bbox.top, bbox.right, bbox.bottom] : null,
      chromaRgb: [...chroma],
      dominance,
      edgeRadius,
      keptPixels: kept,
      minLevel,
      removedFringePixels: removed,
      removedToKeptRatio: removed / Math.max(1, kept),
      warning: fringeWarning(removed, kept, chroma),
    },
  };
};

/** Pixels within `radius` (4-connected) of a transparent pixel. */
const nearTransparentMask = (image: Bitmap, radius: number): Uint8Array => {
  const { width, height } = image;
  let near = new Uint8Array(width * height);
  for (let i = 0; i < near.length; i += 1) {
    near[i] = image.data[i * 4 + 3] === 0 ? 1 : 0;
  }

  for (let step = 0; step < Math.max(0, radius); step += 1) {
    const grown = Uint8Array.from(near);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!near[y * width + x]) {
          continue;
        }
        if (y + 1 < height) {
          grown[(y + 1) * width + x] = 1;
        }
        if (y > 0) {
          grown[(y - 1) * width + x] = 1;
        }
        if (x + 1 < width) {
          grown[y * width + x + 1] = 1;
        }
        if (x > 0) {
          grown[y * width + x - 1] = 1;
        }
      }
    }
    near = grown;
  }
  return near;
};

export interface DespillRecord {
  chromaRgb: number[];
  edgeRadius: number;
  bandOnly: boolean;
  despilledPixels: number;
  spillRemoved: number;
}

export interface DespillResult {
  image: Bitmap;
  record: DespillRecord;
}

/**
 * Neutralize matte-colour spill by clamping matte-dominant channels down to
 * the suppressed level — for a green matte, the classic `g = min(g, max(r,b))`.
 *
 * Unlike fringe removal this deletes nothing and changes no geometry. With
 * `bandOnly` (the default) it only touches opaque pixels near transparency, so
 * genuinely matte-coloured interior detail is left intact.
 */
export const despillChroma = (
  image: Bitmap,
  options: { chroma: RGB; edgeRadius?: number; bandOnly?: boolean },
): DespillResult => {
  const { chroma, edgeRadius = 2, bandOnly = true } = options;
  const { dominant, suppressed } = chromaFringeChannels(chroma);
  const out = image.copy();
  const near = bandOnly ? nearTransparentMask(image, edgeRadius) : null;

  let despilled = 0;
  let spillRemoved = 0;

  for (let index = 0; index < image.width * image.height; index += 1) {
    const p = index * 4;
    if (image.data[p + 3] === 0) {
      continue;
    }
    if (near && !near[index]) {
      continue;
    }

    const high = Math.max(...suppressed.map((i) => image.data[p + i] ?? 0));
    let changed = false;
    let delta = 0;
    for (const channel of dominant) {
      const original = image.data[p + channel] ?? 0;
      const clamped = Math.min(original, high);
      if (clamped !== original) {
        changed = true;
        delta += original - clamped;
      }
      out.data[p + channel] = clamped;
    }
    if (changed) {
      despilled += 1;
      spillRemoved += delta;
    }
  }

  return {
    image: out,
    record: {
      bandOnly,
      chromaRgb: [...chroma],
      despilledPixels: despilled,
      edgeRadius,
      spillRemoved,
    },
  };
};

export interface DecontamRecord {
  specksRemoved: number;
}
export interface DecontamResult {
  image: Bitmap;
  record: DecontamRecord;
}

/**
 * Drop leftover near-pure-matte specks anywhere on the sprite, not just the
 * edge band.
 *
 * A dark subject keyed against a bright matte leaves antialiased matte-tinted
 * pixels the edge despill misses. A real character colour — a red shirt under
 * a magenta matte — is not near-pure matte and survives.
 */
export const decontaminateMatte = (
  image: Bitmap,
  options: { chroma: RGB; excess?: number; minLevel?: number },
): DecontamResult => {
  const { chroma, excess = 50, minLevel = 100 } = options;
  const { dominant, suppressed } = chromaFringeChannels(chroma);
  const out = image.copy();
  let removed = 0;

  for (let index = 0; index < image.width * image.height; index += 1) {
    const p = index * 4;
    if ((image.data[p + 3] ?? 0) <= 0) {
      continue;
    }
    const domMin = Math.min(...dominant.map((i) => image.data[p + i] ?? 0));
    const supMax = Math.max(...suppressed.map((i) => image.data[p + i] ?? 0));
    if (domMin - supMax > excess && domMin > minLevel) {
      out.data[p + 3] = 0;
      removed += 1;
    }
  }
  return { image: out, record: { specksRemoved: removed } };
};

export interface ChromaCleanResult {
  image: Bitmap;
  key: KeyRecord;
  fringe: FringeRecord;
  despill: DespillRecord;
  decontam: DecontamRecord | { skipped: true };
}

/** Key, then de-fringe, then despill, then decontaminate — the full path. */
export const cleanChroma = (
  image: Bitmap,
  options: {
    chroma: RGB;
    tolerance?: number;
    fringeRadius?: number;
    despillRadius?: number;
    decontam?: boolean;
  },
): ChromaCleanResult => {
  const { chroma, tolerance = 90, fringeRadius = 1, despillRadius = 2, decontam = true } = options;

  const keyed = keyMatte(image, { chroma, tolerance });
  const defringed = removeChromaFringe(keyed.image, { chroma, edgeRadius: fringeRadius });
  const despilled = despillChroma(defringed.image, { chroma, edgeRadius: despillRadius });

  let result = despilled.image;
  let decontamRecord: { specksRemoved: number } | { skipped: true } = { skipped: true };
  if (decontam && isKeyableFringeChroma(chroma)) {
    const cleaned = decontaminateMatte(result, { chroma });
    result = cleaned.image;
    decontamRecord = cleaned.record;
  }

  return {
    decontam: decontamRecord,
    despill: despilled.record,
    fringe: defringed.record,
    image: result,
    key: keyed.record,
  };
};
