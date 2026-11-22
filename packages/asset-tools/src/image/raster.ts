import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { decodePng, encodePng, readPngSize } from "./png.js";

/**
 * The raster primitives the asset-pipeline skills need, sized to replace the
 * exact Pillow surface those scripts used: open/new/convert/crop/resize/paste/
 * split/getbbox/copy/alpha_composite/get-put-pixel/save. Everything is 8-bit
 * straight-alpha RGBA in a flat row-major buffer, which keeps the ported
 * pixel maths a direct transcription of the numpy indexing it replaces.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type ResampleMode = "nearest" | "bilinear" | "bicubic" | "lanczos";

const at = (buffer: Uint8Array | Float64Array, i: number) => buffer[i] ?? 0;

const clamp8 = (value: number) => {
  if (value <= 0) {
    return 0;
  }

  if (value >= 255) {
    return 255;
  }

  return Math.round(value);
};

const FILTERS = {
  bicubic: {
    kernel: (x) => {
      const a = -0.5;
      const t = Math.abs(x);

      if (t < 1) {
        return ((a + 2) * t - (a + 3)) * t * t + 1;
      }

      if (t < 2) {
        return (((t - 5) * t + 8) * t - 4) * a;
      }

      return 0;
    },
    support: 2,
  },
  bilinear: {
    kernel: (x) => {
      const t = Math.abs(x);

      return t < 1 ? 1 - t : 0;
    },
    support: 1,
  },
  lanczos: {
    kernel: (x) => {
      const t = Math.abs(x);

      if (t === 0) {
        return 1;
      }

      if (t >= 3) {
        return 0;
      }

      const pix = Math.PI * t;

      return (3 * Math.sin(pix) * Math.sin(pix / 3)) / (pix * pix);
    },
    support: 3,
  },
} satisfies Record<
  Exclude<ResampleMode, "nearest">,
  { kernel: (x: number) => number; support: number }
>;

const mulDiv255 = (value: number, alpha: number) => {
  const tmp = value * alpha + 128;

  return Math.floor((tmp + Math.floor(tmp / 256)) / 256);
};

const premultiply = (data: Uint8Array) => {
  const out = new Float64Array(data.length);

  for (let i = 0; i < data.length; i += 4) {
    const a = at(data, i + 3);
    out[i] = mulDiv255(at(data, i), a);
    out[i + 1] = mulDiv255(at(data, i + 1), a);
    out[i + 2] = mulDiv255(at(data, i + 2), a);
    out[i + 3] = a;
  }

  return out;
};

const quantizeInPlace = (buffer: Float64Array) => {
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = clamp8(at(buffer, i));
  }
};

const unpremultiply = (src: Float64Array, out: Uint8Array) => {
  for (let i = 0; i < src.length; i += 4) {
    const a = clamp8(at(src, i + 3));
    out[i + 3] = a;

    if (a === 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      continue;
    }

    for (let c = 0; c < 3; c += 1) {
      const premul = clamp8(at(src, i + c));
      out[i + c] = Math.min(255, Math.floor((premul * 255) / a));
    }
  }
};

const resamplePass = (
  src: Float64Array,
  srcW: number,
  rows: number,
  dstW: number,
  kernel: (x: number) => number,
  support: number,
) => {
  const out = new Float64Array(dstW * rows * 4);
  const scale = srcW / dstW;
  const filterScale = Math.max(1, scale);
  const radius = support * filterScale;

  for (let x = 0; x < dstW; x += 1) {
    const center = (x + 0.5) * scale;
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
      const nearest = Math.min(srcW - 1, Math.max(0, Math.floor(center)));

      for (let y = 0; y < rows; y += 1) {
        for (let c = 0; c < 4; c += 1) {
          out[(y * dstW + x) * 4 + c] = at(src, (y * srcW + nearest) * 4 + c);
        }
      }

      continue;
    }

    for (let y = 0; y < rows; y += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (const [i, weight] of weights.entries()) {
        const w = weight / total;
        const si = (y * srcW + start + i) * 4;
        r += at(src, si) * w;
        g += at(src, si + 1) * w;
        b += at(src, si + 2) * w;
        a += at(src, si + 3) * w;
      }

      const di = (y * dstW + x) * 4;
      out[di] = r;
      out[di + 1] = g;
      out[di + 2] = b;
      out[di + 3] = a;
    }
  }

  return out;
};

const transpose = (src: Float64Array, width: number, height: number) => {
  const out = new Float64Array(src.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const si = (y * width + x) * 4;
      const di = (x * height + y) * 4;
      out[di] = at(src, si);
      out[di + 1] = at(src, si + 1);
      out[di + 2] = at(src, si + 2);
      out[di + 3] = at(src, si + 3);
    }
  }

  return out;
};

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
  static create(width: number, height: number, fill: RGBA = [0, 0, 0, 0]) {
    const bmp = new Bitmap(width, height);

    if (fill[0] || fill[1] || fill[2] || fill[3]) {
      bmp.fill(fill);
    }

    return bmp;
  }

  static fromFile(file: string) {
    const buffer = readFileSync(file);
    const { width, height, data } = decodePng(buffer);

    return new Bitmap(width, height, data);
  }

  toFile(file: string) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    writeFileSync(file, encodePng({ data: this.data, height: this.height, width: this.width }));
  }

  toBuffer() {
    return encodePng({ data: this.data, height: this.height, width: this.width });
  }

  copy() {
    return new Bitmap(this.width, this.height, Uint8Array.from(this.data));
  }

  /** Byte offset of pixel (x, y). Callers are expected to bounds-check. */
  index(x: number, y: number) {
    return (y * this.width + x) * 4;
  }

  contains(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  getPixel(x: number, y: number) {
    const i = this.index(x, y);

    return [
      at(this.data, i),
      at(this.data, i + 1),
      at(this.data, i + 2),
      at(this.data, i + 3),
    ] satisfies RGBA;
  }

  putPixel(x: number, y: number, [r, g, b, a]: RGBA) {
    if (!this.contains(x, y)) {
      return;
    }

    const i = this.index(x, y);
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  fill([r, g, b, a]: RGBA) {
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
  crop(box: Rect) {
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    const out = new Bitmap(Math.max(0, width), Math.max(0, height));

    for (let y = 0; y < out.height; y += 1) {
      const sy = box.top + y;

      if (sy < 0 || sy >= this.height) {
        continue;
      }

      for (let x = 0; x < out.width; x += 1) {
        const sx = box.left + x;

        if (sx < 0 || sx >= this.width) {
          continue;
        }

        const si = this.index(sx, sy);
        const di = out.index(x, y);
        out.data[di] = at(this.data, si);
        out.data[di + 1] = at(this.data, si + 1);
        out.data[di + 2] = at(this.data, si + 2);
        out.data[di + 3] = at(this.data, si + 3);
      }
    }

    return out;
  }

  /**
   * Paste `src` at (left, top), replacing destination pixels outright. This
   * mirrors Pillow's maskless `paste` — alpha is copied, not blended. Use
   * `alphaComposite` when you want blending.
   */
  paste(src: Bitmap, left: number, top: number) {
    for (let y = 0; y < src.height; y += 1) {
      const dy = top + y;

      if (dy < 0 || dy >= this.height) {
        continue;
      }

      for (let x = 0; x < src.width; x += 1) {
        const dx = left + x;

        if (dx < 0 || dx >= this.width) {
          continue;
        }

        const si = src.index(x, y);
        const di = this.index(dx, dy);
        this.data[di] = at(src.data, si);
        this.data[di + 1] = at(src.data, si + 1);
        this.data[di + 2] = at(src.data, si + 2);
        this.data[di + 3] = at(src.data, si + 3);
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
  pasteMasked(src: Bitmap, left: number, top: number, mask: Uint8Array) {
    for (let y = 0; y < src.height; y += 1) {
      const dy = top + y;

      if (dy < 0 || dy >= this.height) {
        continue;
      }

      for (let x = 0; x < src.width; x += 1) {
        const dx = left + x;

        if (dx < 0 || dx >= this.width) {
          continue;
        }

        const m = at(mask, y * src.width + x) / 255;
        const si = src.index(x, y);
        const di = this.index(dx, dy);

        for (let c = 0; c < 4; c += 1) {
          this.data[di + c] = Math.round(
            at(this.data, di + c) * (1 - m) + at(src.data, si + c) * m,
          );
        }
      }
    }
  }

  /** Source-over blend of `src` onto this bitmap at (left, top). */
  alphaComposite(src: Bitmap, left = 0, top = 0) {
    for (let y = 0; y < src.height; y += 1) {
      const dy = top + y;

      if (dy < 0 || dy >= this.height) {
        continue;
      }

      for (let x = 0; x < src.width; x += 1) {
        const dx = left + x;

        if (dx < 0 || dx >= this.width) {
          continue;
        }

        const si = src.index(x, y);
        const di = this.index(dx, dy);
        const sa = at(src.data, si + 3) / 255;

        if (sa === 0) {
          continue;
        }

        const da = at(this.data, di + 3) / 255;
        const outA = sa + da * (1 - sa);

        if (outA === 0) {
          this.data.fill(0, di, di + 4);
          continue;
        }

        for (let c = 0; c < 3; c += 1) {
          const s = at(src.data, si + c);
          const d = at(this.data, di + c);
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
  getBBox(alphaThreshold = 0) {
    let minX = this.width;
    let minY = this.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (at(this.data, this.index(x, y) + 3) <= alphaThreshold) {
          continue;
        }

        if (x < minX) {
          minX = x;
        }

        if (x > maxX) {
          maxX = x;
        }

        if (y < minY) {
          minY = y;
        }

        if (y > maxY) {
          maxY = y;
        }
      }
    }

    if (maxX < 0) {
      return null;
    }

    return { bottom: maxY + 1, left: minX, right: maxX + 1, top: minY };
  }

  /** Extract one channel as a width*height byte array (Pillow's `split`). */
  channel(offset: 0 | 1 | 2 | 3) {
    const out = new Uint8Array(this.width * this.height);

    for (let i = 0; i < out.length; i += 1) {
      out[i] = at(this.data, i * 4 + offset);
    }

    return out;
  }

  /** Rec. 601 luma per pixel — Pillow's `convert("L")`. */
  luma() {
    const out = new Uint8Array(this.width * this.height);

    for (let i = 0; i < out.length; i += 1) {
      const p = i * 4;
      out[i] = Math.round(
        at(this.data, p) * 0.299 + at(this.data, p + 1) * 0.587 + at(this.data, p + 2) * 0.114,
      );
    }

    return out;
  }

  /** Composite onto an opaque background — Pillow's `convert("RGB")`. */
  flatten(background: RGB = [0, 0, 0]) {
    const out = new Bitmap(this.width, this.height);

    for (let i = 0; i < this.data.length; i += 4) {
      const a = at(this.data, i + 3) / 255;

      for (let c = 0; c < 3; c += 1) {
        out.data[i + c] = Math.round(at(this.data, i + c) * a + (background[c] ?? 0) * (1 - a));
      }

      out.data[i + 3] = 255;
    }

    return out;
  }

  resize(width: number, height: number, mode: ResampleMode = "nearest") {
    if (width === this.width && height === this.height) {
      return this.copy();
    }

    if (mode === "nearest") {
      return this.resizeNearest(width, height);
    }

    return this.resampleFiltered(width, height, mode);
  }

  private resizeNearest(width: number, height: number) {
    const out = new Bitmap(width, height);
    const xRatio = this.width / width;
    const yRatio = this.height / height;

    for (let y = 0; y < height; y += 1) {
      const sy = Math.min(this.height - 1, Math.floor((y + 0.5) * yRatio));

      for (let x = 0; x < width; x += 1) {
        const sx = Math.min(this.width - 1, Math.floor((x + 0.5) * xRatio));
        const si = this.index(sx, sy);
        const di = out.index(x, y);
        out.data[di] = at(this.data, si);
        out.data[di + 1] = at(this.data, si + 1);
        out.data[di + 2] = at(this.data, si + 2);
        out.data[di + 3] = at(this.data, si + 3);
      }
    }

    return out;
  }

  private resampleFiltered(width: number, height: number, mode: Exclude<ResampleMode, "nearest">) {
    const { kernel, support } = FILTERS[mode];

    const horizontal = resamplePass(
      premultiply(this.data),
      this.width,
      this.height,
      width,
      kernel,
      support,
    );

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

const readJpegSize = (buffer: Buffer) => {
  let pos = 2;

  while (pos + 9 < buffer.length) {
    if (buffer[pos] !== 0xff) {
      pos += 1;
      continue;
    }

    const marker = at(buffer, pos + 1);

    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(pos + 5), width: buffer.readUInt16BE(pos + 7) };
    }

    pos += 2 + buffer.readUInt16BE(pos + 2);
  }

  return null;
};

const readWebpSize = (buffer: Buffer) => {
  const format = buffer.subarray(12, 16).toString("ascii");

  if (format === "VP8X") {
    return {
      height: 1 + buffer.readUIntLE(27, 3),
      width: 1 + buffer.readUIntLE(24, 3),
    };
  }

  if (format === "VP8 ") {
    return { height: buffer.readUInt16LE(28) % 0x40_00, width: buffer.readUInt16LE(26) % 0x40_00 };
  }

  if (format === "VP8L") {
    const bits = buffer.readUInt32LE(21);

    return { height: 1 + (Math.floor(bits / 0x40_00) % 0x40_00), width: 1 + (bits % 0x40_00) };
  }

  return null;
};

/** Read image dimensions without decoding pixels. PNG, JPEG, GIF and WebP. */
export const readImageSize = (file: string) => {
  const buffer = readFileSync(file);

  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return readPngSize(buffer);
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return readJpegSize(buffer);
  }

  if (buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return { height: buffer.readUInt16LE(8), width: buffer.readUInt16LE(6) };
  }

  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return readWebpSize(buffer);
  }

  return null;
};
