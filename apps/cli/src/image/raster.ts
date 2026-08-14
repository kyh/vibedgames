import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { decodePng, encodePng, readPngSize } from "./png.js";

/**
 * The raster primitives the asset-pipeline skills need, sized to replace the
 * exact Pillow surface those scripts used: open/new/convert/crop/resize/paste/
 * split/getbbox/copy/alpha_composite/get-put-pixel/save. Everything is 8-bit
 * straight-alpha RGBA in a flat row-major buffer, which keeps the ported
 * pixel maths a direct transcription of the numpy indexing it replaces.
 */

export type Rect = { left: number; top: number; right: number; bottom: number };

export type ResampleMode = "nearest" | "bilinear" | "bicubic" | "lanczos";

export class Bitmap {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  readonly data: Uint8Array;

  constructor(width: number, height: number, data?: Uint8Array) {
    if (width < 0 || height < 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
      throw new Error(`Invalid bitmap size ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8Array(width * height * 4);
    if (this.data.length !== width * height * 4) {
      throw new Error(`Bitmap buffer is ${this.data.length} bytes, expected ${width * height * 4}`);
    }
  }

  /** A blank bitmap filled with `fill` (defaults to fully transparent). */
  static create(width: number, height: number, fill: RGBA = [0, 0, 0, 0]): Bitmap {
    const bmp = new Bitmap(width, height);
    if (fill[0] || fill[1] || fill[2] || fill[3]) bmp.fill(fill);
    return bmp;
  }

  static fromFile(path: string): Bitmap {
    const buffer = readFileSync(path);
    const { width, height, data } = decodePng(buffer);
    return new Bitmap(width, height, data);
  }

  toFile(path: string): void {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(path, encodePng({ width: this.width, height: this.height, data: this.data }));
  }

  toBuffer(): Buffer {
    return encodePng({ width: this.width, height: this.height, data: this.data });
  }

  copy(): Bitmap {
    return new Bitmap(this.width, this.height, Uint8Array.from(this.data));
  }

  /** Byte offset of pixel (x, y). Callers are expected to bounds-check. */
  index(x: number, y: number): number {
    return (y * this.width + x) * 4;
  }

  contains(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  getPixel(x: number, y: number): RGBA {
    const i = this.index(x, y);
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!, this.data[i + 3]!];
  }

  putPixel(x: number, y: number, [r, g, b, a]: RGBA): void {
    if (!this.contains(x, y)) return;
    const i = this.index(x, y);
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  fill([r, g, b, a]: RGBA): void {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = a;
    }
  }

  /**
   * Pillow's `crop`: the box may extend past the edges, and anything outside
   * the source reads as transparent rather than clamping or throwing. The
   * spritesheet slicers lean on that when a frame cell overhangs the sheet.
   */
  crop(box: Rect): Bitmap {
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    const out = new Bitmap(Math.max(0, width), Math.max(0, height));
    for (let y = 0; y < out.height; y += 1) {
      const sy = box.top + y;
      if (sy < 0 || sy >= this.height) continue;
      for (let x = 0; x < out.width; x += 1) {
        const sx = box.left + x;
        if (sx < 0 || sx >= this.width) continue;
        const si = this.index(sx, sy);
        const di = out.index(x, y);
        out.data[di] = this.data[si]!;
        out.data[di + 1] = this.data[si + 1]!;
        out.data[di + 2] = this.data[si + 2]!;
        out.data[di + 3] = this.data[si + 3]!;
      }
    }
    return out;
  }

  /**
   * Paste `src` at (left, top), replacing destination pixels outright. This
   * mirrors Pillow's maskless `paste` — alpha is copied, not blended. Use
   * `alphaComposite` when you want blending.
   */
  paste(src: Bitmap, left: number, top: number): void {
    for (let y = 0; y < src.height; y += 1) {
      const dy = top + y;
      if (dy < 0 || dy >= this.height) continue;
      for (let x = 0; x < src.width; x += 1) {
        const dx = left + x;
        if (dx < 0 || dx >= this.width) continue;
        const si = src.index(x, y);
        const di = this.index(dx, dy);
        this.data[di] = src.data[si]!;
        this.data[di + 1] = src.data[si + 1]!;
        this.data[di + 2] = src.data[si + 2]!;
        this.data[di + 3] = src.data[si + 3]!;
      }
    }
  }

  /**
   * Pillow's three-argument `paste(im, box, mask)`, which is a lerp rather
   * than a composite: every destination band, *alpha included*, is blended as
   * `dst * (1 - m) + src * m`.
   *
   * When the mask is the source's own alpha — which is how the sprite scripts
   * always call it — that squares the alpha and premultiplies the colour of
   * partially transparent pixels. It is almost certainly not what the original
   * author intended, but hard-alpha sprites (the overwhelming majority) are
   * unaffected, and every sheet these skills have shipped was produced this
   * way. Reproduced deliberately so ported output stays identical; see
   * `alphaComposite` for the well-behaved operation.
   */
  pasteMasked(src: Bitmap, left: number, top: number, mask: Uint8Array): void {
    for (let y = 0; y < src.height; y += 1) {
      const dy = top + y;
      if (dy < 0 || dy >= this.height) continue;
      for (let x = 0; x < src.width; x += 1) {
        const dx = left + x;
        if (dx < 0 || dx >= this.width) continue;
        const m = mask[y * src.width + x]! / 255;
        const si = src.index(x, y);
        const di = this.index(dx, dy);
        for (let c = 0; c < 4; c += 1) {
          this.data[di + c] = Math.round(this.data[di + c]! * (1 - m) + src.data[si + c]! * m);
        }
      }
    }
  }

  /** Source-over blend of `src` onto this bitmap at (left, top). */
  alphaComposite(src: Bitmap, left = 0, top = 0): void {
    for (let y = 0; y < src.height; y += 1) {
      const dy = top + y;
      if (dy < 0 || dy >= this.height) continue;
      for (let x = 0; x < src.width; x += 1) {
        const dx = left + x;
        if (dx < 0 || dx >= this.width) continue;
        const si = src.index(x, y);
        const di = this.index(dx, dy);
        const sa = src.data[si + 3]! / 255;
        if (sa === 0) continue;
        const da = this.data[di + 3]! / 255;
        const outA = sa + da * (1 - sa);
        if (outA === 0) {
          this.data[di] = this.data[di + 1] = this.data[di + 2] = this.data[di + 3] = 0;
          continue;
        }
        for (let c = 0; c < 3; c += 1) {
          const s = src.data[si + c]!;
          const d = this.data[di + c]!;
          this.data[di + c] = Math.round((s * sa + d * da * (1 - sa)) / outA);
        }
        this.data[di + 3] = Math.round(outA * 255);
      }
    }
  }

  /**
   * Pillow's `getbbox`: the tightest box containing every pixel that is not
   * fully transparent, or null for an entirely empty image. Frame slicing,
   * baseline alignment and QC all pivot on this.
   */
  getBBox(alphaThreshold = 0): Rect | null {
    let minX = this.width;
    let minY = this.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (this.data[this.index(x, y) + 3]! <= alphaThreshold) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 };
  }

  /** Extract one channel as a width*height byte array (Pillow's `split`). */
  channel(offset: 0 | 1 | 2 | 3): Uint8Array {
    const out = new Uint8Array(this.width * this.height);
    for (let i = 0; i < out.length; i += 1) out[i] = this.data[i * 4 + offset]!;
    return out;
  }

  /** Rec. 601 luma per pixel — Pillow's `convert("L")`. */
  luma(): Uint8Array {
    const out = new Uint8Array(this.width * this.height);
    for (let i = 0; i < out.length; i += 1) {
      const p = i * 4;
      out[i] = Math.round(
        this.data[p]! * 0.299 + this.data[p + 1]! * 0.587 + this.data[p + 2]! * 0.114,
      );
    }
    return out;
  }

  /** Composite onto an opaque background — Pillow's `convert("RGB")`. */
  flatten(background: RGB = [0, 0, 0]): Bitmap {
    const out = new Bitmap(this.width, this.height);
    for (let i = 0; i < this.data.length; i += 4) {
      const a = this.data[i + 3]! / 255;
      for (let c = 0; c < 3; c += 1) {
        out.data[i + c] = Math.round(this.data[i + c]! * a + background[c]! * (1 - a));
      }
      out.data[i + 3] = 255;
    }
    return out;
  }

  resize(width: number, height: number, mode: ResampleMode = "nearest"): Bitmap {
    if (width === this.width && height === this.height) return this.copy();
    if (mode === "nearest") return this.resizeNearest(width, height);
    return this.resampleFiltered(width, height, mode);
  }

  private resizeNearest(width: number, height: number): Bitmap {
    const out = new Bitmap(width, height);
    const xRatio = this.width / width;
    const yRatio = this.height / height;
    for (let y = 0; y < height; y += 1) {
      // Sample the source pixel under the centre of the destination pixel,
      // which is what Pillow's NEAREST does and what keeps integer upscales
      // of pixel art exactly blocky.
      const sy = Math.min(this.height - 1, Math.floor((y + 0.5) * yRatio));
      for (let x = 0; x < width; x += 1) {
        const sx = Math.min(this.width - 1, Math.floor((x + 0.5) * xRatio));
        const si = this.index(sx, sy);
        const di = out.index(x, y);
        out.data[di] = this.data[si]!;
        out.data[di + 1] = this.data[si + 1]!;
        out.data[di + 2] = this.data[si + 2]!;
        out.data[di + 3] = this.data[si + 3]!;
      }
    }
    return out;
  }

  /**
   * Separable filtered resampling, transcribed from Pillow's
   * `ImagingResampleHorizontal` so ported scripts keep producing the images
   * they produced before. Three details matter for that parity and are each
   * easy to "improve" into a mismatch:
   *
   *  - Downscaling widens the filter support by the scale factor, so the
   *    result is area-averaged rather than point-sampled and aliased.
   *  - Pillow resamples RGBA through its premultiplied `RGBa` mode, so colour
   *    does not bleed out of transparent pixels.
   *  - That premultiplication round-trips through *8-bit* storage. At very low
   *    alpha the premultiplied colour truncates to zero and un-premultiplying
   *    cannot bring it back, so Pillow quietly blackens near-invisible pixels.
   *    Keeping the intermediate in float would be more accurate and would
   *    disagree with every sprite these skills have produced to date, so the
   *    8-bit round trip is reproduced deliberately.
   */
  private resampleFiltered(
    width: number,
    height: number,
    mode: Exclude<ResampleMode, "nearest">,
  ): Bitmap {
    const { kernel, support } = FILTERS[mode];
    const horizontal = resamplePass(
      premultiply(this.data),
      this.width,
      this.height,
      width,
      kernel,
      support,
    );
    // Pillow's horizontal pass writes into a fresh 8-bit image before the
    // vertical pass reads it, so the intermediate is quantized. Carrying full
    // float precision across both passes drifts by a level or two.
    quantizeInPlace(horizontal);
    const vertical = resamplePass(
      transpose(horizontal, width, this.height),
      this.height,
      width,
      height,
      kernel,
      support,
    );
    const planar = transpose(vertical, height, width);

    const out = new Bitmap(width, height);
    unpremultiply(planar, out.data);
    return out;
  }
}

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

function clamp8(value: number): number {
  return value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
}

/**
 * Filter kernels and their support radii, matching Pillow's definitions.
 * `support` is the half-width of the kernel in source pixels before the
 * downscale widening is applied.
 */
const FILTERS: Record<
  Exclude<ResampleMode, "nearest">,
  {
    kernel: (x: number) => number;
    support: number;
  }
> = {
  bilinear: {
    support: 1,
    kernel: (x) => {
      const t = Math.abs(x);
      return t < 1 ? 1 - t : 0;
    },
  },
  bicubic: {
    support: 2,
    // Catmull-Rom variant with a = -0.5, which is Pillow's BICUBIC and the
    // default filter for `Image.resize`.
    kernel: (x) => {
      const a = -0.5;
      const t = Math.abs(x);
      if (t < 1) return ((a + 2) * t - (a + 3)) * t * t + 1;
      if (t < 2) return (((t - 5) * t + 8) * t - 4) * a;
      return 0;
    },
  },
  lanczos: {
    support: 3,
    kernel: (x) => {
      const t = Math.abs(x);
      if (t === 0) return 1;
      if (t >= 3) return 0;
      const pix = Math.PI * t;
      return (3 * Math.sin(pix) * Math.sin(pix / 3)) / (pix * pix);
    },
  },
};

/**
 * Multiply by 255 with round-to-nearest using only integer ops — Pillow's
 * `MULDIV255`. Plain `Math.round(v * a / 255)` disagrees on a handful of
 * values, which is enough to shift a resampled sprite by one level.
 */
function mulDiv255(value: number, alpha: number): number {
  const tmp = value * alpha + 128;
  return (tmp + (tmp >> 8)) >> 8;
}

/** RGBA -> premultiplied RGBa in 8-bit, as Pillow does before resampling. */
function premultiply(data: Uint8Array): Float64Array {
  const out = new Float64Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    out[i] = mulDiv255(data[i]!, a);
    out[i + 1] = mulDiv255(data[i + 1]!, a);
    out[i + 2] = mulDiv255(data[i + 2]!, a);
    out[i + 3] = a;
  }
  return out;
}

/** Clip a float working buffer back to the 8-bit range, in place. */
function quantizeInPlace(buffer: Float64Array): void {
  for (let i = 0; i < buffer.length; i += 1) buffer[i] = clamp8(buffer[i]!);
}

/** Premultiplied RGBa -> straight RGBA. Pillow truncates the division. */
function unpremultiply(src: Float64Array, out: Uint8Array): void {
  for (let i = 0; i < src.length; i += 4) {
    const a = clamp8(src[i + 3]!);
    out[i + 3] = a;
    if (a === 0) {
      out[i] = out[i + 1] = out[i + 2] = 0;
      continue;
    }
    for (let c = 0; c < 3; c += 1) {
      const premul = clamp8(src[i + c]!);
      out[i + c] = Math.min(255, Math.floor((premul * 255) / a));
    }
  }
}

/** Resample every row of a planar RGBA float buffer from `srcW` to `dstW`. */
function resamplePass(
  src: Float64Array,
  srcW: number,
  rows: number,
  dstW: number,
  kernel: (x: number) => number,
  support: number,
): Float64Array {
  const out = new Float64Array(dstW * rows * 4);
  const scale = srcW / dstW;
  // Downscaling widens the filter footprint; upscaling keeps the base support.
  const filterScale = Math.max(1, scale);
  const radius = support * filterScale;

  for (let x = 0; x < dstW; x += 1) {
    const center = (x + 0.5) * scale;
    // Pillow truncates toward zero on both bounds after the +0.5 nudge; using
    // floor/ceil instead shifts the footprint and drifts from its output.
    const start = Math.max(0, Math.trunc(center - radius + 0.5));
    const end = Math.min(srcW, Math.trunc(center + radius + 0.5));

    const weights: number[] = [];
    let total = 0;
    for (let sx = start; sx < end; sx += 1) {
      const w = kernel((sx + 0.5 - center) / filterScale);
      weights.push(w);
      total += w;
    }
    if (total === 0) {
      // Degenerate footprint (possible at extreme ratios): fall back to the
      // nearest source column rather than emitting a transparent stripe.
      const nearest = Math.min(srcW - 1, Math.max(0, Math.floor(center)));
      for (let y = 0; y < rows; y += 1) {
        for (let c = 0; c < 4; c += 1) {
          out[(y * dstW + x) * 4 + c] = src[(y * srcW + nearest) * 4 + c]!;
        }
      }
      continue;
    }

    for (let y = 0; y < rows; y += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < weights.length; i += 1) {
        const w = weights[i]! / total;
        const si = (y * srcW + start + i) * 4;
        r += src[si]! * w;
        g += src[si + 1]! * w;
        b += src[si + 2]! * w;
        a += src[si + 3]! * w;
      }
      const di = (y * dstW + x) * 4;
      out[di] = r;
      out[di + 1] = g;
      out[di + 2] = b;
      out[di + 3] = a;
    }
  }
  return out;
}

function transpose(src: Float64Array, width: number, height: number): Float64Array {
  const out = new Float64Array(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const si = (y * width + x) * 4;
      const di = (x * height + y) * 4;
      out[di] = src[si]!;
      out[di + 1] = src[si + 1]!;
      out[di + 2] = src[si + 2]!;
      out[di + 3] = src[si + 3]!;
    }
  }
  return out;
}

/** Read image dimensions without decoding pixels. PNG, JPEG, GIF and WebP. */
export function readImageSize(path: string): { width: number; height: number } | null {
  const buffer = readFileSync(path);
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return readPngSize(buffer);
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return readJpegSize(buffer);
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return readWebpSize(buffer);
  }
  return null;
}

function readJpegSize(buffer: Buffer): { width: number; height: number } | null {
  let pos = 2;
  while (pos + 9 < buffer.length) {
    if (buffer[pos] !== 0xff) {
      pos += 1;
      continue;
    }
    const marker = buffer[pos + 1]!;
    // SOF0-SOF15, excluding the non-frame markers DHT (c4), JPG (c8), DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(pos + 5), width: buffer.readUInt16BE(pos + 7) };
    }
    pos += 2 + buffer.readUInt16BE(pos + 2);
  }
  return null;
}

function readWebpSize(buffer: Buffer): { width: number; height: number } | null {
  const format = buffer.subarray(12, 16).toString("ascii");
  if (format === "VP8X") {
    return {
      width: 1 + (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16)),
      height: 1 + (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16)),
    };
  }
  if (format === "VP8 ") {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}
