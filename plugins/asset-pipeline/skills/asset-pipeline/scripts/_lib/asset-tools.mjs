// GENERATED FILE — do not edit.
// Built from packages/asset-tools by `pnpm --filter @repo/asset-tools build`.
// Edit the TypeScript source there and re-run `pnpm dogfood` (or that build)
// to regenerate every skill's copy.

// src/args.ts
function parseArgs(argv) {
  const positionals = [];
  const options = /* @__PURE__ */ new Map();
  const push = (key, value) => {
    const existing = options.get(key);
    if (existing) existing.push(value);
    else options.set(key, [value]);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      push(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next === void 0 || next.startsWith("--")) {
      push(body, "true");
    } else {
      push(body, next);
      i += 1;
    }
  }
  return { positionals, options };
}
function getString(args, key) {
  return args.options.get(key)?.at(-1);
}
function getAll(args, key) {
  return args.options.get(key) ?? [];
}
function getFlag(args, key) {
  const value = getString(args, key);
  return value !== void 0 && value !== "false";
}
function getNumber(args, key, fallback) {
  const raw = getString(args, key);
  if (raw === void 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`--${key} must be a number, got "${raw}"`);
  return value;
}
function fail(message) {
  process.stderr.write(`${message}
`);
  process.exit(1);
}
function failUsage(message) {
  process.stderr.write(`${message}
`);
  process.exit(2);
}
function main(run) {
  try {
    run();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

// src/image/color.ts
var NAMED = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  lime: [0, 255, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  aqua: [0, 255, 255],
  magenta: [255, 0, 255],
  fuchsia: [255, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  maroon: [128, 0, 0],
  olive: [128, 128, 0],
  navy: [0, 0, 128],
  purple: [128, 0, 128],
  teal: [0, 128, 128],
  orange: [255, 165, 0],
  pink: [255, 192, 203],
  brown: [165, 42, 42],
  transparent: [0, 0, 0]
};
function parseColor(input) {
  const value = input.trim().toLowerCase();
  if (value === "transparent") return [0, 0, 0, 0];
  const named = NAMED[value];
  if (named) return [named[0], named[1], named[2], 255];
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) {
      throw new Error(`Unrecognised colour: ${input}`);
    }
    if (hex.length === 3 || hex.length === 4) {
      const expand = (c) => parseInt(c + c, 16);
      const a = hex.length === 4 ? expand(hex[3]) : 255;
      return [expand(hex[0]), expand(hex[1]), expand(hex[2]), a];
    }
    const byte = (i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return [byte(0), byte(1), byte(2), hex.length === 8 ? byte(3) : 255];
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) throw new Error(`Unrecognised colour: ${input}`);
    const channel = (raw) => {
      const n = raw.endsWith("%") ? Number.parseFloat(raw) * 255 / 100 : Number.parseFloat(raw);
      if (Number.isNaN(n)) throw new Error(`Unrecognised colour: ${input}`);
      return Math.max(0, Math.min(255, Math.round(n)));
    };
    const alpha = parts.length > 3 ? Math.max(0, Math.min(255, Math.round(Number.parseFloat(parts[3]) * 255))) : 255;
    return [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
  }
  throw new Error(`Unrecognised colour: ${input}`);
}
function toHex([r, g, b]) {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// src/image/raster.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// src/image/png.ts
import { deflateSync, inflateSync } from "node:zlib";
var SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
var ADAM7 = [
  { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
  { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
  { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
  { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
  { xStart: 0, yStart: 1, xStep: 1, yStep: 2 }
];
var CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
var crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(bytes) {
  let c = 4294967295;
  for (let i = 0; i < bytes.length; i += 1) {
    c = crcTable[(c ^ bytes[i]) & 255] ^ c >>> 8;
  }
  return (c ^ 4294967295) >>> 0;
}
function unfilter(type, line, prev, bpp) {
  const len = line.length;
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < len; i += 1) line[i] = line[i] + line[i - bpp] & 255;
      return;
    case 2:
      for (let i = 0; i < len; i += 1) line[i] = line[i] + prev[i] & 255;
      return;
    case 3:
      for (let i = 0; i < len; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = line[i] + (left + prev[i] >> 1) & 255;
      }
      return;
    case 4:
      for (let i = 0; i < len; i += 1) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = line[i] + pred & 255;
      }
      return;
    default:
      throw new Error(`PNG: unknown filter type ${type}`);
  }
}
function sampleAt(line, index, bitDepth) {
  if (bitDepth === 8) return line[index];
  if (bitDepth === 16) return line[index * 2] << 8 | line[index * 2 + 1];
  const perByte = 8 / bitDepth;
  const byte = line[Math.floor(index / perByte)];
  const shift = 8 - bitDepth * (index % perByte + 1);
  return byte >> shift & (1 << bitDepth) - 1;
}
function scaleTo8(value, bitDepth) {
  if (bitDepth === 8) return value;
  if (bitDepth === 16) return value >> 8;
  return Math.round(value * 255 / ((1 << bitDepth) - 1));
}
function expandPass(raw, offset, passWidth, passHeight, geom, header, palette, transparency, out) {
  const { width, bitDepth, colorType } = header;
  const channels = CHANNELS[colorType];
  const bpp = Math.max(1, Math.ceil(channels * bitDepth / 8));
  const lineBytes = Math.ceil(channels * bitDepth * passWidth / 8);
  let prev = new Uint8Array(lineBytes);
  let cursor = offset;
  for (let row = 0; row < passHeight; row += 1) {
    const filterType = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + lineBytes);
    cursor += lineBytes;
    unfilter(filterType, line, prev, bpp);
    const y = geom.yStart + row * geom.yStep;
    for (let col = 0; col < passWidth; col += 1) {
      const x = geom.xStart + col * geom.xStep;
      const target = (y * width + x) * 4;
      const base = col * channels;
      let r;
      let g;
      let b;
      let a = 255;
      if (colorType === 3) {
        const index = sampleAt(line, base, bitDepth);
        if (!palette) throw new Error("PNG: indexed image without a PLTE chunk");
        r = palette[index * 3];
        g = palette[index * 3 + 1];
        b = palette[index * 3 + 2];
        a = transparency?.[index] ?? 255;
      } else if (colorType === 0 || colorType === 4) {
        const grey = sampleAt(line, base, bitDepth);
        r = g = b = scaleTo8(grey, bitDepth);
        if (colorType === 4) a = scaleTo8(sampleAt(line, base + 1, bitDepth), bitDepth);
        else if (transparency && transparency[0] === grey) a = 0;
      } else {
        const rawR = sampleAt(line, base, bitDepth);
        const rawG = sampleAt(line, base + 1, bitDepth);
        const rawB = sampleAt(line, base + 2, bitDepth);
        r = scaleTo8(rawR, bitDepth);
        g = scaleTo8(rawG, bitDepth);
        b = scaleTo8(rawB, bitDepth);
        if (colorType === 6) a = scaleTo8(sampleAt(line, base + 3, bitDepth), bitDepth);
        else if (transparency && transparency[0] === rawR && transparency[1] === rawG && transparency[2] === rawB) {
          a = 0;
        }
      }
      out[target] = r;
      out[target + 1] = g;
      out[target + 2] = b;
      out[target + 3] = a;
    }
    prev = Uint8Array.from(line);
  }
  return cursor;
}
function decodePng(buffer) {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error("Not a PNG file (bad signature)");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let pos = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (pos < buffer.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(
      buffer[pos + 4],
      buffer[pos + 5],
      buffer[pos + 6],
      buffer[pos + 7]
    );
    const body = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      header = {
        width: view.getUint32(pos + 8),
        height: view.getUint32(pos + 12),
        bitDepth: buffer[pos + 16],
        colorType: buffer[pos + 17],
        interlace: buffer[pos + 20]
      };
      if (buffer[pos + 18] !== 0) throw new Error("PNG: unsupported compression method");
      if (buffer[pos + 19] !== 0) throw new Error("PNG: unsupported filter method");
      if (!(header.colorType in CHANNELS)) {
        throw new Error(`PNG: unsupported colour type ${header.colorType}`);
      }
    } else if (type === "PLTE") {
      palette = Uint8Array.from(body);
    } else if (type === "tRNS") {
      if (!header) throw new Error("PNG: tRNS before IHDR");
      if (header.colorType === 3) transparency = Array.from(body);
      else if (header.colorType === 0) transparency = [body[0] << 8 | body[1]];
      else {
        transparency = [
          body[0] << 8 | body[1],
          body[2] << 8 | body[3],
          body[4] << 8 | body[5]
        ];
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (!header) throw new Error("PNG: missing IHDR");
  const { width, height, bitDepth, colorType, interlace } = header;
  if (![1, 2, 4, 8, 16].includes(bitDepth)) {
    throw new Error(`PNG: unsupported bit depth ${bitDepth}`);
  }
  if (colorType === 3 && bitDepth === 16) throw new Error("PNG: indexed images cap at 8-bit");
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c)))));
  const out = new Uint8Array(width * height * 4);
  if (interlace === 0) {
    expandPass(
      raw,
      0,
      width,
      height,
      { xStart: 0, yStart: 0, xStep: 1, yStep: 1 },
      header,
      palette,
      transparency,
      out
    );
  } else if (interlace === 1) {
    let cursor = 0;
    for (const geom of ADAM7) {
      const passWidth = Math.ceil(Math.max(0, width - geom.xStart) / geom.xStep);
      const passHeight = Math.ceil(Math.max(0, height - geom.yStart) / geom.yStep);
      if (passWidth === 0 || passHeight === 0) continue;
      cursor = expandPass(
        raw,
        cursor,
        passWidth,
        passHeight,
        geom,
        header,
        palette,
        transparency,
        out
      );
    }
  } else {
    throw new Error(`PNG: unsupported interlace method ${interlace}`);
  }
  return { width, height, data: out };
}
function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}
function filterScanlines(data, width, height) {
  const stride = width * 4;
  const out = Buffer.alloc(height * (stride + 1));
  const candidate = new Uint8Array(stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const line = data.subarray(y * stride, (y + 1) * stride);
    let bestType = 0;
    let bestScore = Infinity;
    let best = line;
    for (let type = 0; type <= 4; type += 1) {
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const a = i >= 4 ? line[i - 4] : 0;
        const b = prev[i];
        const c = i >= 4 ? prev[i - 4] : 0;
        let value;
        if (type === 0) value = line[i];
        else if (type === 1) value = line[i] - a;
        else if (type === 2) value = line[i] - b;
        else if (type === 3) value = line[i] - (a + b >> 1);
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = line[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        candidate[i] = value & 255;
        score += Math.abs((value & 255) << 24 >> 24);
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best = Uint8Array.from(candidate);
      }
    }
    out[y * (stride + 1)] = bestType;
    out.set(best, y * (stride + 1) + 1);
    prev = Uint8Array.from(line);
  }
  return out;
}
function encodePng(image) {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new Error(
      `PNG: pixel buffer is ${data.length} bytes, expected ${width * height * 4} for ${width}x${height}`
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filterScanlines(data, width, height), { level: 9 })),
    chunk("IEND", new Uint8Array(0))
  ]);
}
function readPngSize(buffer) {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error("Not a PNG file (bad signature)");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// src/image/raster.ts
var Bitmap = class _Bitmap {
  width;
  height;
  /** Row-major RGBA, 4 bytes per pixel. */
  data;
  constructor(width, height, data) {
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
  static create(width, height, fill = [0, 0, 0, 0]) {
    const bmp = new _Bitmap(width, height);
    if (fill[0] || fill[1] || fill[2] || fill[3]) bmp.fill(fill);
    return bmp;
  }
  static fromFile(path) {
    const buffer = readFileSync(path);
    const { width, height, data } = decodePng(buffer);
    return new _Bitmap(width, height, data);
  }
  toFile(path) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(path, encodePng({ width: this.width, height: this.height, data: this.data }));
  }
  toBuffer() {
    return encodePng({ width: this.width, height: this.height, data: this.data });
  }
  copy() {
    return new _Bitmap(this.width, this.height, Uint8Array.from(this.data));
  }
  /** Byte offset of pixel (x, y). Callers are expected to bounds-check. */
  index(x, y) {
    return (y * this.width + x) * 4;
  }
  contains(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
  getPixel(x, y) {
    const i = this.index(x, y);
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }
  putPixel(x, y, [r, g, b, a]) {
    if (!this.contains(x, y)) return;
    const i = this.index(x, y);
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }
  fill([r, g, b, a]) {
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
  crop(box) {
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    const out = new _Bitmap(Math.max(0, width), Math.max(0, height));
    for (let y = 0; y < out.height; y += 1) {
      const sy = box.top + y;
      if (sy < 0 || sy >= this.height) continue;
      for (let x = 0; x < out.width; x += 1) {
        const sx = box.left + x;
        if (sx < 0 || sx >= this.width) continue;
        const si = this.index(sx, sy);
        const di = out.index(x, y);
        out.data[di] = this.data[si];
        out.data[di + 1] = this.data[si + 1];
        out.data[di + 2] = this.data[si + 2];
        out.data[di + 3] = this.data[si + 3];
      }
    }
    return out;
  }
  /**
   * Paste `src` at (left, top), replacing destination pixels outright. This
   * mirrors Pillow's maskless `paste` — alpha is copied, not blended. Use
   * `alphaComposite` when you want blending.
   */
  paste(src, left, top) {
    for (let y = 0; y < src.height; y += 1) {
      const dy = top + y;
      if (dy < 0 || dy >= this.height) continue;
      for (let x = 0; x < src.width; x += 1) {
        const dx = left + x;
        if (dx < 0 || dx >= this.width) continue;
        const si = src.index(x, y);
        const di = this.index(dx, dy);
        this.data[di] = src.data[si];
        this.data[di + 1] = src.data[si + 1];
        this.data[di + 2] = src.data[si + 2];
        this.data[di + 3] = src.data[si + 3];
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
  pasteMasked(src, left, top, mask) {
    for (let y = 0; y < src.height; y += 1) {
      const dy = top + y;
      if (dy < 0 || dy >= this.height) continue;
      for (let x = 0; x < src.width; x += 1) {
        const dx = left + x;
        if (dx < 0 || dx >= this.width) continue;
        const m = mask[y * src.width + x] / 255;
        const si = src.index(x, y);
        const di = this.index(dx, dy);
        for (let c = 0; c < 4; c += 1) {
          this.data[di + c] = Math.round(this.data[di + c] * (1 - m) + src.data[si + c] * m);
        }
      }
    }
  }
  /** Source-over blend of `src` onto this bitmap at (left, top). */
  alphaComposite(src, left = 0, top = 0) {
    for (let y = 0; y < src.height; y += 1) {
      const dy = top + y;
      if (dy < 0 || dy >= this.height) continue;
      for (let x = 0; x < src.width; x += 1) {
        const dx = left + x;
        if (dx < 0 || dx >= this.width) continue;
        const si = src.index(x, y);
        const di = this.index(dx, dy);
        const sa = src.data[si + 3] / 255;
        if (sa === 0) continue;
        const da = this.data[di + 3] / 255;
        const outA = sa + da * (1 - sa);
        if (outA === 0) {
          this.data[di] = this.data[di + 1] = this.data[di + 2] = this.data[di + 3] = 0;
          continue;
        }
        for (let c = 0; c < 3; c += 1) {
          const s = src.data[si + c];
          const d = this.data[di + c];
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
        if (this.data[this.index(x, y) + 3] <= alphaThreshold) continue;
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
  channel(offset) {
    const out = new Uint8Array(this.width * this.height);
    for (let i = 0; i < out.length; i += 1) out[i] = this.data[i * 4 + offset];
    return out;
  }
  /** Rec. 601 luma per pixel — Pillow's `convert("L")`. */
  luma() {
    const out = new Uint8Array(this.width * this.height);
    for (let i = 0; i < out.length; i += 1) {
      const p = i * 4;
      out[i] = Math.round(
        this.data[p] * 0.299 + this.data[p + 1] * 0.587 + this.data[p + 2] * 0.114
      );
    }
    return out;
  }
  /** Composite onto an opaque background — Pillow's `convert("RGB")`. */
  flatten(background = [0, 0, 0]) {
    const out = new _Bitmap(this.width, this.height);
    for (let i = 0; i < this.data.length; i += 4) {
      const a = this.data[i + 3] / 255;
      for (let c = 0; c < 3; c += 1) {
        out.data[i + c] = Math.round(this.data[i + c] * a + background[c] * (1 - a));
      }
      out.data[i + 3] = 255;
    }
    return out;
  }
  resize(width, height, mode = "nearest") {
    if (width === this.width && height === this.height) return this.copy();
    if (mode === "nearest") return this.resizeNearest(width, height);
    return this.resampleFiltered(width, height, mode);
  }
  resizeNearest(width, height) {
    const out = new _Bitmap(width, height);
    const xRatio = this.width / width;
    const yRatio = this.height / height;
    for (let y = 0; y < height; y += 1) {
      const sy = Math.min(this.height - 1, Math.floor((y + 0.5) * yRatio));
      for (let x = 0; x < width; x += 1) {
        const sx = Math.min(this.width - 1, Math.floor((x + 0.5) * xRatio));
        const si = this.index(sx, sy);
        const di = out.index(x, y);
        out.data[di] = this.data[si];
        out.data[di + 1] = this.data[si + 1];
        out.data[di + 2] = this.data[si + 2];
        out.data[di + 3] = this.data[si + 3];
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
  resampleFiltered(width, height, mode) {
    const { kernel, support } = FILTERS[mode];
    const horizontal = resamplePass(
      premultiply(this.data),
      this.width,
      this.height,
      width,
      kernel,
      support
    );
    quantizeInPlace(horizontal);
    const vertical = resamplePass(
      transpose(horizontal, width, this.height),
      this.height,
      width,
      height,
      kernel,
      support
    );
    const planar = transpose(vertical, height, width);
    const out = new _Bitmap(width, height);
    unpremultiply(planar, out.data);
    return out;
  }
};
function clamp8(value) {
  return value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
}
var FILTERS = {
  bilinear: {
    support: 1,
    kernel: (x) => {
      const t = Math.abs(x);
      return t < 1 ? 1 - t : 0;
    }
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
    }
  },
  lanczos: {
    support: 3,
    kernel: (x) => {
      const t = Math.abs(x);
      if (t === 0) return 1;
      if (t >= 3) return 0;
      const pix = Math.PI * t;
      return 3 * Math.sin(pix) * Math.sin(pix / 3) / (pix * pix);
    }
  }
};
function mulDiv255(value, alpha) {
  const tmp = value * alpha + 128;
  return tmp + (tmp >> 8) >> 8;
}
function premultiply(data) {
  const out = new Float64Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    out[i] = mulDiv255(data[i], a);
    out[i + 1] = mulDiv255(data[i + 1], a);
    out[i + 2] = mulDiv255(data[i + 2], a);
    out[i + 3] = a;
  }
  return out;
}
function quantizeInPlace(buffer) {
  for (let i = 0; i < buffer.length; i += 1) buffer[i] = clamp8(buffer[i]);
}
function unpremultiply(src, out) {
  for (let i = 0; i < src.length; i += 4) {
    const a = clamp8(src[i + 3]);
    out[i + 3] = a;
    if (a === 0) {
      out[i] = out[i + 1] = out[i + 2] = 0;
      continue;
    }
    for (let c = 0; c < 3; c += 1) {
      const premul = clamp8(src[i + c]);
      out[i + c] = Math.min(255, Math.floor(premul * 255 / a));
    }
  }
}
function resamplePass(src, srcW, rows, dstW, kernel, support) {
  const out = new Float64Array(dstW * rows * 4);
  const scale = srcW / dstW;
  const filterScale = Math.max(1, scale);
  const radius = support * filterScale;
  for (let x = 0; x < dstW; x += 1) {
    const center = (x + 0.5) * scale;
    const start = Math.max(0, Math.trunc(center - radius + 0.5));
    const end = Math.min(srcW, Math.trunc(center + radius + 0.5));
    const weights = [];
    let total = 0;
    for (let sx = start; sx < end; sx += 1) {
      const w = kernel((sx + 0.5 - center) / filterScale);
      weights.push(w);
      total += w;
    }
    if (total === 0) {
      const nearest2 = Math.min(srcW - 1, Math.max(0, Math.floor(center)));
      for (let y = 0; y < rows; y += 1) {
        for (let c = 0; c < 4; c += 1) {
          out[(y * dstW + x) * 4 + c] = src[(y * srcW + nearest2) * 4 + c];
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
        const w = weights[i] / total;
        const si = (y * srcW + start + i) * 4;
        r += src[si] * w;
        g += src[si + 1] * w;
        b += src[si + 2] * w;
        a += src[si + 3] * w;
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
function transpose(src, width, height) {
  const out = new Float64Array(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const si = (y * width + x) * 4;
      const di = (x * height + y) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}
function readImageSize(path) {
  const buffer = readFileSync(path);
  if (buffer.length >= 24 && buffer[0] === 137 && buffer[1] === 80) {
    return readPngSize(buffer);
  }
  if (buffer[0] === 255 && buffer[1] === 216) return readJpegSize(buffer);
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return readWebpSize(buffer);
  }
  return null;
}
function readJpegSize(buffer) {
  let pos = 2;
  while (pos + 9 < buffer.length) {
    if (buffer[pos] !== 255) {
      pos += 1;
      continue;
    }
    const marker = buffer[pos + 1];
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      return { height: buffer.readUInt16BE(pos + 5), width: buffer.readUInt16BE(pos + 7) };
    }
    pos += 2 + buffer.readUInt16BE(pos + 2);
  }
  return null;
}
function readWebpSize(buffer) {
  const format = buffer.subarray(12, 16).toString("ascii");
  if (format === "VP8X") {
    return {
      width: 1 + (buffer[24] | buffer[25] << 8 | buffer[26] << 16),
      height: 1 + (buffer[27] | buffer[28] << 8 | buffer[29] << 16)
    };
  }
  if (format === "VP8 ") {
    return { width: buffer.readUInt16LE(26) & 16383, height: buffer.readUInt16LE(28) & 16383 };
  }
  if (format === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 16383), height: 1 + (bits >> 14 & 16383) };
  }
  return null;
}

// src/image/diff.ts
function diffImages(baseline, current) {
  if (baseline.width !== current.width || baseline.height !== current.height) {
    throw new Error(
      `Different sizes: (${baseline.width}, ${baseline.height}) vs (${current.width}, ${current.height})`
    );
  }
  const out = new Bitmap(baseline.width, baseline.height);
  const sums = [0, 0, 0, 0];
  for (let i = 0; i < out.data.length; i += 1) {
    const delta = Math.abs(baseline.data[i] - current.data[i]);
    out.data[i] = delta;
    sums[i % 4] += delta * delta;
  }
  const pixels = baseline.width * baseline.height;
  const channelRms = sums.map((sum) => Math.sqrt(sum / pixels));
  const rms = Math.sqrt(channelRms.reduce((sum, v) => sum + v * v, 0) / channelRms.length);
  return { image: out, rms, channelRms };
}

// src/image/draw.ts
function put(target, x, y, ink) {
  if (!target.contains(x, y)) return;
  const i = target.index(x, y);
  target.data[i] = ink[0];
  target.data[i + 1] = ink[1];
  target.data[i + 2] = ink[2];
  target.data[i + 3] = ink[3];
}
function drawLine(target, x0, y0, x1, y1, ink) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const endX = Math.round(x1);
  const endY = Math.round(y1);
  const dx = Math.abs(endX - x);
  const dy = -Math.abs(endY - y);
  const stepX = x < endX ? 1 : -1;
  const stepY = y < endY ? 1 : -1;
  let error = dx + dy;
  for (; ; ) {
    put(target, x, y, ink);
    if (x === endX && y === endY) return;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += stepX;
    }
    if (doubled <= dx) {
      error += dx;
      y += stepY;
    }
  }
}
function fillRect(target, x0, y0, x1, y1, ink) {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) put(target, x, y, ink);
  }
}
function strokeRect(target, x0, y0, x1, y1, ink, width = 1) {
  for (let i = 0; i < Math.max(1, width); i += 1) {
    const left = x0 + i;
    const top = y0 + i;
    const right = x1 - i;
    const bottom = y1 - i;
    if (left > right || top > bottom) return;
    drawLine(target, left, top, right, top, ink);
    drawLine(target, left, bottom, right, bottom, ink);
    drawLine(target, left, top, left, bottom, ink);
    drawLine(target, right, top, right, bottom, ink);
  }
}
var GLYPH_WIDTH = 6;
var GLYPH_HEIGHT = 12;
var GLYPH_DATA = "AAAAAAAAAAAAAAAAD7DEsA8AinIAc4gA1BoAG9MA6wIAAuoA6wIAAuoA1BoAG9MAinIAc4kAD7DEsA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCg8QAAAMNt8AAAABgA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGLD0EYAFcECKNcAKFUAC+oAAAAAX50AAAAj1BUAAAzMNwAAAa1ZAAAAYfTAwLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACqnAzUsAdnQAGeAAEQYARNsAAACj9UMAAAAAT6IAkwQAA+0AolQAPcYAHr/BuygAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASvcAAAANxvIAAACVVvAAADyvAPAAB8gaAPAAWtXAwPyiAAAAAPAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARd7AwIQAXWgAAAAAdk8AAAAAj5rEsiMAjmsAUr4AIAMAA+sAqE8AOr4AJcTAuCMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApLHwiIAaoUAUa4AxSQABnYA63LAryAA8VMAU70A2gMAA+sAmEEAQbwAFrO/uyMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqMDAxuwAAAAAZIIAAAABzxYAAABOmgAAAADBJwAAADexAAAAAK0+AAAAJMcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ8a/wzkA4CEAI9YAzTQANuEANfjT+EwAwVMAVZ4A7gIAA+wAxz0APMwAL8HBwDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIbnAtBcAu0MAQ5cA6wMAA9kAvVEAVPAAIa+/c+oAegYAJcQArlAAhWsAJMTHkwIAAAAAAAAAAAAAAAAA";
var glyphCache = null;
function glyphs() {
  glyphCache ??= new Uint8Array(Buffer.from(GLYPH_DATA, "base64"));
  return glyphCache;
}
function drawDigits(target, x, y, text, ink) {
  const data = glyphs();
  let cursor = x;
  for (const ch of text) {
    const digit = ch.charCodeAt(0) - 48;
    if (digit < 0 || digit > 9) {
      cursor += GLYPH_WIDTH;
      continue;
    }
    const base = digit * GLYPH_WIDTH * GLYPH_HEIGHT;
    for (let gy = 0; gy < GLYPH_HEIGHT; gy += 1) {
      for (let gx = 0; gx < GLYPH_WIDTH; gx += 1) {
        const coverage = data[base + gy * GLYPH_WIDTH + gx];
        if (coverage === 0) continue;
        const px = cursor + gx;
        const py = y + gy;
        if (!target.contains(px, py)) continue;
        const i = target.index(px, py);
        const m = coverage / 255;
        const transparent = target.data[i + 3] === 0;
        for (let c = 0; c < 3; c += 1) {
          target.data[i + c] = transparent ? ink[c] : Math.round(target.data[i + c] * (1 - m) + ink[c] * m);
        }
        target.data[i + 3] = Math.round(target.data[i + 3] * (1 - m) + ink[3] * m);
      }
    }
    cursor += GLYPH_WIDTH;
  }
}

// src/image/gif.ts
function quantize(pixels, maxColors) {
  let boxes = [pixels];
  while (boxes.length < maxColors) {
    let target = -1;
    let bestRange = 0;
    let bestChannel = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      const box2 = boxes[i];
      if (box2.length < 2) continue;
      for (let c = 0; c < 3; c += 1) {
        let min = 255;
        let max = 0;
        for (const p of box2) {
          if (p[c] < min) min = p[c];
          if (p[c] > max) max = p[c];
        }
        if (max - min > bestRange) {
          bestRange = max - min;
          target = i;
          bestChannel = c;
        }
      }
    }
    if (target < 0 || bestRange === 0) break;
    const box = boxes[target];
    box.sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = box.length >> 1;
    boxes = [
      ...boxes.slice(0, target),
      box.slice(0, mid),
      box.slice(mid),
      ...boxes.slice(target + 1)
    ];
  }
  const colors = boxes.filter((box) => box.length > 0).map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const p of box) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    return [Math.round(r / box.length), Math.round(g / box.length), Math.round(b / box.length)];
  });
  if (colors.length === 0) colors.push([0, 0, 0]);
  return { colors, lookup: /* @__PURE__ */ new Map() };
}
function nearest(palette, r, g, b) {
  const key = r << 16 | g << 8 | b;
  const cached = palette.lookup.get(key);
  if (cached !== void 0) return cached;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.colors.length; i += 1) {
    const c = palette.colors[i];
    const dr = c[0] - r;
    const dg = c[1] - g;
    const db = c[2] - b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  palette.lookup.set(key, best);
  return best;
}
var BitWriter = class {
  bytes = [];
  accumulator = 0;
  bits = 0;
  write(code, width) {
    this.accumulator |= code << this.bits;
    this.bits += width;
    while (this.bits >= 8) {
      this.bytes.push(this.accumulator & 255);
      this.accumulator >>= 8;
      this.bits -= 8;
    }
  }
  finish() {
    if (this.bits > 0) this.bytes.push(this.accumulator & 255);
    const out = [];
    for (let i = 0; i < this.bytes.length; i += 255) {
      const chunk2 = this.bytes.slice(i, i + 255);
      out.push(chunk2.length, ...chunk2);
    }
    out.push(0);
    return Buffer.from(out);
  }
};
function lzwCompress(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const writer = new BitWriter();
  let dict = /* @__PURE__ */ new Map();
  let next = endCode + 1;
  let codeWidth = minCodeSize + 1;
  const resetDict = () => {
    dict = /* @__PURE__ */ new Map();
    next = endCode + 1;
    codeWidth = minCodeSize + 1;
  };
  resetDict();
  writer.write(clearCode, codeWidth);
  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const combined = `${prefix},${k}`;
    if (dict.has(combined)) {
      prefix = combined;
      continue;
    }
    writer.write(dict.get(prefix) ?? Number(prefix), codeWidth);
    dict.set(combined, next);
    next += 1;
    if (next > 1 << codeWidth && codeWidth < 12) {
      codeWidth += 1;
    } else if (next > 4095) {
      writer.write(clearCode, codeWidth);
      resetDict();
    }
    prefix = String(k);
  }
  writer.write(dict.get(prefix) ?? Number(prefix), codeWidth);
  writer.write(endCode, codeWidth);
  return writer.finish();
}
function encodeGif(frames, loop = 0) {
  if (frames.length === 0) throw new Error("GIF: no frames to encode");
  const width = frames[0].bitmap.width;
  const height = frames[0].bitmap.height;
  for (const frame of frames) {
    if (frame.bitmap.width !== width || frame.bitmap.height !== height) {
      throw new Error(
        `GIF: every frame must be ${width}x${height}, got ${frame.bitmap.width}x${frame.bitmap.height}`
      );
    }
  }
  const parts = [];
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  parts.push(header);
  const netscape = Buffer.from([
    33,
    255,
    11,
    ...Buffer.from("NETSCAPE2.0", "ascii"),
    3,
    1,
    0,
    0,
    0
  ]);
  netscape.writeUInt16LE(loop, 16);
  parts.push(netscape);
  for (const frame of frames) {
    const { bitmap } = frame;
    const pixels = [];
    for (let i = 0; i < bitmap.data.length; i += 4) {
      pixels.push([bitmap.data[i], bitmap.data[i + 1], bitmap.data[i + 2]]);
    }
    const palette = quantize(
      pixels.map((p) => [...p]),
      256
    );
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i += 1) {
      const p = pixels[i];
      indices[i] = nearest(palette, p[0], p[1], p[2]);
    }
    let tableBits = 1;
    while (1 << tableBits < palette.colors.length) tableBits += 1;
    const tableSize = 1 << tableBits;
    const gce = Buffer.alloc(8);
    gce[0] = 33;
    gce[1] = 249;
    gce[2] = 4;
    gce[3] = 2 << 2;
    gce.writeUInt16LE(Math.max(0, Math.round(frame.delayMs / 10)), 4);
    gce[6] = 0;
    gce[7] = 0;
    parts.push(gce);
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 44;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 128 | tableBits - 1;
    parts.push(descriptor);
    const table = Buffer.alloc(tableSize * 3);
    for (let i = 0; i < palette.colors.length; i += 1) {
      const c = palette.colors[i];
      table[i * 3] = c[0];
      table[i * 3 + 1] = c[1];
      table[i * 3 + 2] = c[2];
    }
    parts.push(table);
    const minCodeSize = Math.max(2, tableBits);
    parts.push(Buffer.from([minCodeSize]));
    parts.push(lzwCompress(indices, minCodeSize));
  }
  parts.push(Buffer.from([59]));
  return Buffer.concat(parts);
}

// src/asset/lua.ts
var LuaParseError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "LuaParseError";
  }
};
var IDENT_START = /[A-Za-z_]/;
var IDENT_BODY = /[A-Za-z0-9_]/;
var PUNCTUATION = /* @__PURE__ */ new Set(["{", "}", "[", "]", "=", ",", ";"]);
function isSpace(ch) {
  return ch !== "" && /\s/.test(ch);
}
function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}
function tokenize(text) {
  const tokens = [];
  let i = 0;
  const peek = (n = 0) => i + n < text.length ? text[i + n] : "";
  const skipTrivia = () => {
    for (; ; ) {
      while (isSpace(peek())) i += 1;
      if (peek() !== "-" || peek(1) !== "-") return;
      i += 2;
      if (peek() === "[" && peek(1) === "[") {
        i += 2;
        const end = text.indexOf("]]", i);
        i = end === -1 ? text.length : end + 2;
      } else {
        while (peek() !== "" && peek() !== "\n") i += 1;
      }
    }
  };
  for (; ; ) {
    skipTrivia();
    if (i >= text.length) {
      tokens.push({ type: "eof", value: "", pos: i });
      return tokens;
    }
    const ch = peek();
    const pos = i;
    if (PUNCTUATION.has(ch)) {
      tokens.push({ type: ch, value: ch, pos });
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      const out = [];
      for (; ; ) {
        const c = peek();
        if (c === "") throw new LuaParseError("Unterminated string");
        if (c === quote) {
          i += 1;
          break;
        }
        if (c === "\\") {
          i += 1;
          const esc = peek();
          if (esc === "n") out.push("\n");
          else if (esc === "t") out.push("	");
          else if (esc === "r") out.push("\r");
          else if (esc === '"' || esc === "'" || esc === "\\") out.push(esc);
          else out.push(`\\${esc}`);
          if (esc !== "") i += 1;
          continue;
        }
        out.push(c);
        i += 1;
      }
      tokens.push({ type: "string", value: out.join(""), pos });
      continue;
    }
    if (isDigit(ch) || ch === "-" && isDigit(peek(1))) {
      let j = ch === "-" ? i + 1 : i;
      while (j < text.length && (isDigit(text[j]) || text[j] === ".")) j += 1;
      tokens.push({ type: "number", value: text.slice(i, j), pos });
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < text.length && IDENT_BODY.test(text[j])) j += 1;
      tokens.push({ type: "ident", value: text.slice(i, j), pos });
      i = j;
      continue;
    }
    throw new LuaParseError(`Unexpected character at ${pos}: '${ch}'`);
  }
}
function parseLua(text) {
  const tokens = tokenize(text);
  let k = 0;
  const cur = () => tokens[k];
  const peek = (n = 1) => tokens[Math.min(k + n, tokens.length - 1)];
  const eat = (type) => {
    const token = cur();
    if (type !== void 0 && token.type !== type) {
      throw new LuaParseError(`Expected ${type}, got ${token.type} at ${token.pos}`);
    }
    k += 1;
    return token;
  };
  const parseValue = () => {
    const token = cur();
    if (token.type === "{") return parseTable();
    if (token.type === "string") {
      eat("string");
      return token.value;
    }
    if (token.type === "number") {
      eat("number");
      return token.value.includes(".") ? Number.parseFloat(token.value) : Number.parseInt(token.value, 10);
    }
    if (token.type === "ident") {
      if (token.value === "true") {
        eat("ident");
        return true;
      }
      if (token.value === "false") {
        eat("ident");
        return false;
      }
      if (token.value === "nil") {
        eat("ident");
        return null;
      }
      throw new LuaParseError(`Unsupported identifier value at ${token.pos}: '${token.value}'`);
    }
    throw new LuaParseError(`Unexpected token at ${token.pos}: ${token.type}`);
  };
  const parseTable = () => {
    eat("{");
    const items = [];
    let arrayIndex = 1;
    while (cur().type !== "}") {
      if (cur().type === "ident" && peek().type === "=") {
        const key = eat("ident").value;
        eat("=");
        items.push([key, parseValue()]);
      } else if (cur().type === "[") {
        eat("[");
        const key = parseValue();
        eat("]");
        eat("=");
        if (typeof key !== "string" && typeof key !== "number") {
          throw new LuaParseError("Only string/int table keys are supported");
        }
        items.push([key, parseValue()]);
      } else {
        items.push([arrayIndex, parseValue()]);
        arrayIndex += 1;
      }
      if (cur().type === "," || cur().type === ";") eat();
    }
    eat("}");
    const keys = items.map(([key]) => key);
    if (keys.length > 0 && keys.every((key) => typeof key === "number")) {
      const numeric = keys;
      const max = Math.max(...numeric);
      const dense = new Set(numeric).size === numeric.length && max === numeric.length;
      if (dense) {
        const out2 = Array.from({ length: max }, () => null);
        for (const [key, value2] of items) out2[key - 1] = value2;
        return out2;
      }
    }
    const out = {};
    for (const [key, value2] of items) out[String(key)] = value2;
    return out;
  };
  if (cur().type === "ident" && cur().value === "return") eat("ident");
  const value = parseValue();
  if (cur().type !== "eof") throw new LuaParseError(`Trailing tokens at ${cur().pos}`);
  return value;
}

// src/asset/manifest.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname3, isAbsolute, relative as relative2, resolve as resolve3 } from "node:path";

// src/asset/paths.ts
import { existsSync, mkdirSync as mkdirSync2, readdirSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join, relative, resolve as resolve2, sep } from "node:path";
function parseFrame(text) {
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(text.trim());
  if (!match) throw new Error(`frame must be WxH, e.g. 32x32 (got "${text}")`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) throw new Error(`frame dimensions must be positive: ${text}`);
  return { width, height };
}
function walkFiles(root, extension = ".png") {
  const out = [];
  const suffix = extension.toLowerCase();
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.toLowerCase().endsWith(suffix)) out.push(full);
    }
  };
  visit(root);
  return out.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
function resolveTargets(path, extension = ".png") {
  if (!existsSync(path)) throw new Error(`Path not found: ${path}`);
  return statSync(path).isFile() ? [path] : walkFiles(path, extension);
}
function defaultRoot(explicit) {
  if (explicit) return explicit;
  return existsSync("assets") ? "assets" : ".";
}
function prettyPath(path) {
  const rel = relative(process.cwd(), resolve2(path));
  return rel && !rel.startsWith(`..${sep}`) && rel !== ".." ? rel : resolve2(path);
}
function toPythonJson(payload) {
  return JSON.stringify(payload, null, 2).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}
function writeJsonFile(path, payload) {
  mkdirSync2(dirname2(resolve2(path)), { recursive: true });
  writeFileSync2(path, `${toPythonJson(payload)}
`);
}
function writeTextFile(path, contents) {
  mkdirSync2(dirname2(resolve2(path)), { recursive: true });
  writeFileSync2(path, contents);
}

// src/asset/manifest.ts
var MANIFEST_CANDIDATES = [
  "assets_index.lua",
  "asset_index.lua",
  "assets/assets_index.lua",
  "assets/asset_index.lua"
];
var LUA_PATH_RE = /path\s*=\s*"([^"]+\.png)"/g;
function resolveManifestPath(raw, manifestDir, jsonRoot) {
  if (isAbsolute(raw)) return resolve3(raw);
  return jsonRoot ? resolve3(manifestDir, jsonRoot, raw) : resolve3(manifestDir, raw);
}
function collectJsonPaths(payload) {
  const paths = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "path" && typeof value === "string" && value.toLowerCase().endsWith(".png")) {
        paths.push(value);
      } else {
        visit(value);
      }
    }
  };
  visit(payload);
  return paths;
}
function extractManifestPaths(manifestPath) {
  const manifestDir = resolve3(dirname3(manifestPath));
  if (manifestPath.toLowerCase().endsWith(".json")) {
    const payload = JSON.parse(readFileSync2(manifestPath, "utf8"));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("JSON manifest must be an object at top-level.");
    }
    const meta = payload.meta;
    const jsonRoot = meta !== null && typeof meta === "object" && typeof meta.root === "string" ? meta.root : null;
    return new Set(
      collectJsonPaths(payload).map((p) => resolveManifestPath(p, manifestDir, jsonRoot))
    );
  }
  const text = readFileSync2(manifestPath, "utf8");
  const out = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(LUA_PATH_RE)) {
    out.add(resolveManifestPath(match[1], manifestDir, null));
  }
  return out;
}
function checkManifest(manifestPath, root) {
  const manifestPaths = extractManifestPaths(manifestPath);
  const actualPaths = new Set(walkFiles(root, ".png").map((p) => resolve3(p)));
  const missing = [...actualPaths].filter((p) => !manifestPaths.has(p)).map(prettyPath);
  const extra = [...manifestPaths].filter((p) => !actualPaths.has(p)).map(prettyPath);
  const byName = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  return {
    manifest_paths: manifestPaths.size,
    actual_pngs: actualPaths.size,
    missing: missing.sort(byName),
    extra: extra.sort(byName)
  };
}
function autoDetectManifest() {
  return MANIFEST_CANDIDATES.find((p) => existsSync2(p)) ?? null;
}
var KEY_RENAMES = {
  w: "width",
  h: "height",
  tileW: "tileWidth",
  tileH: "tileHeight",
  frameW: "frameWidth",
  frameH: "frameHeight"
};
function renameKeys(value) {
  if (Array.isArray(value)) return value.map(renameKeys);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[KEY_RENAMES[key] ?? key] = renameKeys(nested);
  }
  return out;
}
function rewritePaths(base, value) {
  if (Array.isArray(value)) return value.map((item) => rewritePaths(base, item));
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "path" && typeof nested === "string" && nested.toLowerCase().endsWith(".png")) {
      const absolute = isAbsolute(nested) ? resolve3(nested) : resolve3(process.cwd(), nested);
      const rel = relative2(resolve3(base), absolute);
      out[key] = rel && !rel.startsWith("..") ? rel.split(/[/\\]/).join("/") : nested;
    } else {
      out[key] = rewritePaths(base, nested);
    }
  }
  return out;
}
function exportManifest(manifestPath, packRelative) {
  if (manifestPath.toLowerCase().endsWith(".json")) {
    const payload = JSON.parse(readFileSync2(manifestPath, "utf8"));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("JSON manifest must be an object at top-level.");
    }
    return payload;
  }
  const parsed = parseLua(readFileSync2(manifestPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Lua manifest must return a table/object.");
  }
  let normalized = renameKeys(parsed);
  if (packRelative) {
    normalized = rewritePaths(resolve3(dirname3(manifestPath)), normalized);
    const meta = normalized.meta;
    if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
      meta.root = ".";
    } else {
      normalized.meta = { root: "." };
    }
  }
  return normalized;
}

// src/pymath.ts
function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// src/asset/sheet.ts
function gridFor(path, size, frame) {
  if (size.width % frame.width !== 0 || size.height % frame.height !== 0) {
    throw new Error(
      `${path} size ${size.width}x${size.height} not divisible by ${frame.width}x${frame.height}`
    );
  }
  return { columns: size.width / frame.width, rows: size.height / frame.height };
}
function byColumnThenRow(a, b) {
  return a[0] - b[0] || a[1] - b[1];
}
function probeSheet(path, frame, includeEmpty) {
  const image = Bitmap.fromFile(path);
  const { columns, rows } = gridFor(path, image, frame);
  const nonEmpty = [];
  const empty = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const cell = image.crop({
        left: col * frame.width,
        top: row * frame.height,
        right: (col + 1) * frame.width,
        bottom: (row + 1) * frame.height
      });
      if (cell.getBBox()) nonEmpty.push([col, row]);
      else empty.push([col, row]);
    }
  }
  const result = {
    path,
    frame: { w: frame.width, h: frame.height },
    grid: { columns, rows },
    non_empty: [...nonEmpty].sort(byColumnThenRow),
    empty_count: empty.length
  };
  if (includeEmpty) result.empty = empty;
  return result;
}
function analyzeBaseline(path, frame, targetBottom, targetCenterX, outPath) {
  const image = Bitmap.fromFile(path);
  const { columns, rows } = gridFor(path, image, frame);
  const fixed = outPath ? Bitmap.create(image.width, image.height) : null;
  const frames = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const left = col * frame.width;
      const top = row * frame.height;
      const cell = image.crop({
        left,
        top,
        right: left + frame.width,
        bottom: top + frame.height
      });
      const bbox = cell.getBBox();
      const index = row * columns + col;
      if (!bbox) {
        frames.push({ index, col, row, empty: true });
        if (fixed) fixed.alphaComposite(cell, left, top);
        continue;
      }
      const bottomY = bbox.bottom - 1;
      const centerX = (bbox.left + bbox.right - 1) / 2;
      const shiftY = targetBottom - bottomY;
      const shiftX = targetCenterX === null ? 0 : roundHalfToEven(targetCenterX - centerX);
      frames.push({
        index,
        col,
        row,
        empty: false,
        alphaBBox: [bbox.left, bbox.top, bbox.right, bbox.bottom],
        visibleBottomY: bottomY,
        visibleCenterX: centerX,
        shiftToTarget: [shiftX, shiftY]
      });
      if (fixed) {
        const shifted = Bitmap.create(frame.width, frame.height);
        shifted.pasteMasked(cell, shiftX, shiftY, cell.channel(3));
        fixed.alphaComposite(shifted, left, top);
      }
    }
  }
  if (fixed && outPath) fixed.toFile(outPath);
  const visible = frames.filter((f) => !f.empty);
  const bottoms = visible.map((f) => f.visibleBottomY);
  const shifts = visible.map((f) => f.shiftToTarget[1]);
  return {
    path,
    size: { width: image.width, height: image.height },
    frame: { width: frame.width, height: frame.height },
    grid: { columns, rows },
    targetBottomY: targetBottom,
    targetCenterX,
    visibleBottomYRange: bottoms.length ? [Math.min(...bottoms), Math.max(...bottoms)] : null,
    shiftYRange: shifts.length ? [Math.min(...shifts), Math.max(...shifts)] : null,
    out: outPath,
    frames
  };
}

// src/asset/sizes.ts
function collectSizes(root) {
  const rows = [];
  for (const path of walkFiles(root, ".png")) {
    const size = readImageSize(path);
    if (!size) throw new Error(`Could not read image dimensions: ${path}`);
    rows.push({ width: size.width, height: size.height, path });
  }
  return rows;
}
function sizesToCsv(rows) {
  const escape = (value) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const lines = ["width,height,path"];
  for (const row of rows) {
    lines.push(`${row.width},${row.height},${escape(row.path)}`);
  }
  return `${lines.join("\n")}
`;
}

// src/asset/tilemap.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname4, isAbsolute as isAbsolute2, resolve as resolve4 } from "node:path";
var MANIFEST_JSON_CANDIDATES = [
  "assets_index.json",
  "asset_index.json",
  "assets/assets_index.json",
  "assets/asset_index.json"
];
function asInt(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}
function loadManifestJson(path) {
  const payload = JSON.parse(readFileSync3(path, "utf8"));
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Manifest JSON must be an object at top-level.");
  }
  return payload;
}
function sanitizeTilesets(manifest) {
  const tilesets = manifest.tilesets;
  if (tilesets === null || typeof tilesets !== "object" || Array.isArray(tilesets)) {
    throw new Error("Manifest missing `tilesets` object.");
  }
  const out = {};
  for (const [name, entry] of Object.entries(tilesets)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (typeof entry.path !== "string") continue;
    out[name] = entry;
  }
  if (Object.keys(out).length === 0) {
    throw new Error("Manifest has no usable tilesets (each needs a string `path`).");
  }
  return out;
}
function resolveAssetPath(manifestPath, manifest, rel) {
  const manifestDir = resolve4(dirname4(manifestPath));
  const meta = manifest.meta;
  const root = meta !== null && typeof meta === "object" && typeof meta.root === "string" ? meta.root : null;
  const base = root === null ? manifestDir : resolve4(manifestDir, root);
  if (isAbsolute2(rel)) return resolve4(rel);
  const candidates = [resolve4(base, rel), resolve4(manifestDir, rel), resolve4(process.cwd(), rel)];
  return candidates.find((c) => existsSync3(c)) ?? candidates[0];
}
function tilesetMetaFromManifest(manifestPath, manifest, name) {
  const tilesets = sanitizeTilesets(manifest);
  const entry = tilesets[name];
  if (!entry) throw new Error(`Tileset not found in manifest: ${name}`);
  const path = resolveAssetPath(manifestPath, manifest, entry.path);
  if (!existsSync3(path)) throw new Error(`Tileset file not found: ${path}`);
  const tileW = asInt(entry.tileWidth ?? entry.tileW, 16);
  const tileH = asInt(entry.tileHeight ?? entry.tileH, 16);
  const margin = asInt(entry.margin, 0);
  const spacing = asInt(entry.spacing, 0);
  const size = readImageSize(path);
  if (!size) throw new Error(`Could not read tileset dimensions: ${path}`);
  let columns = asInt(entry.columns, 0);
  let rows = asInt(entry.rows, 0);
  if (columns <= 0) {
    const denom = tileW + spacing;
    columns = denom > 0 ? Math.floor((size.width - 2 * margin + spacing) / denom) : 0;
  }
  if (rows <= 0) {
    const denom = tileH + spacing;
    rows = denom > 0 ? Math.floor((size.height - 2 * margin + spacing) / denom) : 0;
  }
  if (columns <= 0 || rows <= 0) {
    throw new Error(`Invalid tileset grid for ${name}: columns=${columns} rows=${rows}`);
  }
  return {
    name,
    path,
    tileW,
    tileH,
    columns,
    rows,
    margin,
    spacing,
    imageW: size.width,
    imageH: size.height
  };
}
function tileCount(meta) {
  return meta.columns * meta.rows;
}
function tileIdFromColRow(meta, col, row) {
  if (col < 0 || row < 0 || col >= meta.columns || row >= meta.rows) return 0;
  return row * meta.columns + col + 1;
}
function colRowFromTileId(meta, tileId) {
  if (tileId <= 0) return [0, 0];
  const index = tileId - 1;
  const row = Math.floor(index / meta.columns);
  return [index - row * meta.columns, row];
}
function cropBox(meta, tileId) {
  const [col, row] = colRowFromTileId(meta, tileId);
  const left = meta.margin + col * (meta.tileW + meta.spacing);
  const top = meta.margin + row * (meta.tileH + meta.spacing);
  return { left, top, right: left + meta.tileW, bottom: top + meta.tileH };
}
function trimTransparent(image) {
  const bbox = image.getBBox();
  return bbox ? image.crop(bbox) : image;
}
function exportTilesetGrid(meta, outPath, options) {
  const scale = Math.max(1, Math.trunc(options.scale));
  let image = Bitmap.fromFile(meta.path);
  if (scale !== 1) image = image.resize(image.width * scale, image.height * scale, "nearest");
  const line = [255, 255, 255, 80];
  const bold = [47, 230, 255, 180];
  const x0 = meta.margin * scale;
  const y0 = meta.margin * scale;
  const stepX = (meta.tileW + meta.spacing) * scale;
  const stepY = (meta.tileH + meta.spacing) * scale;
  const width = meta.columns * meta.tileW * scale + Math.max(0, (meta.columns - 1) * meta.spacing * scale);
  const height = meta.rows * meta.tileH * scale + Math.max(0, (meta.rows - 1) * meta.spacing * scale);
  for (let c = 0; c <= meta.columns; c += 1) {
    const x = x0 + c * stepX;
    drawLine(image, x, y0, x, y0 + height, line);
  }
  for (let r = 0; r <= meta.rows; r += 1) {
    const y = y0 + r * stepY;
    drawLine(image, x0, y, x0 + width, y, line);
  }
  strokeRect(image, x0, y0, x0 + width, y0 + height, bold, 2);
  if (options.labelIds) {
    for (let r = 0; r < meta.rows; r += 1) {
      for (let c = 0; c < meta.columns; c += 1) {
        const id = String(tileIdFromColRow(meta, c, r));
        const tx = x0 + c * stepX + 2;
        const ty = y0 + r * stepY + 2;
        drawDigits(image, tx + 1, ty + 1, id, [0, 0, 0, 180]);
        drawDigits(image, tx, ty, id, [255, 255, 255, 200]);
      }
    }
  }
  (options.trim ? trimTransparent(image) : image).toFile(outPath);
}
function normalizeMapData(data, width, height) {
  const out = Array.from({ length: height }, () => new Array(width).fill(0));
  if (!Array.isArray(data)) return out;
  for (let y = 0; y < Math.min(height, data.length); y += 1) {
    const row = data[y];
    if (!Array.isArray(row)) continue;
    for (let x = 0; x < Math.min(width, row.length); x += 1) {
      const value = row[x];
      if (typeof value === "number" && Number.isFinite(value)) out[y][x] = Math.trunc(value);
    }
  }
  return out;
}
function exportMapRender(meta, outPath, options) {
  const scale = Math.max(1, Math.trunc(options.scale));
  const data = options.mapPayload.data;
  if (!Array.isArray(data)) throw new Error("Map JSON must have `data` as a 2D array.");
  const mapMeta = options.mapPayload.meta;
  const hasMeta = mapMeta !== null && typeof mapMeta === "object" && !Array.isArray(mapMeta);
  let width = hasMeta ? asInt(mapMeta.width, 0) : 0;
  let height = hasMeta ? asInt(mapMeta.height, 0) : 0;
  if (width <= 0) {
    width = data.reduce(
      (max, row) => Array.isArray(row) ? Math.max(max, row.length) : max,
      0
    );
  }
  if (height <= 0) height = data.length;
  if (width <= 0 || height <= 0) throw new Error("Invalid map dimensions.");
  const grid = normalizeMapData(data, width, height);
  const sheet = Bitmap.fromFile(meta.path);
  let out = Bitmap.create(
    width * meta.tileW,
    height * meta.tileH,
    options.background ?? [0, 0, 0, 0]
  );
  for (const fill of options.fills) {
    fillRect(
      out,
      fill.x * meta.tileW,
      fill.y * meta.tileH,
      (fill.x + fill.w) * meta.tileW,
      (fill.y + fill.h) * meta.tileH,
      fill.color
    );
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const id = grid[y][x];
      if (id <= 0) continue;
      out.alphaComposite(sheet.crop(cropBox(meta, id)), x * meta.tileW, y * meta.tileH);
    }
  }
  if (scale !== 1) out = out.resize(out.width * scale, out.height * scale, "nearest");
  (options.trim ? trimTransparent(out) : out).toFile(outPath);
}
function nonEmptyTileIds(meta) {
  const image = Bitmap.fromFile(meta.path);
  const out = /* @__PURE__ */ new Set();
  for (let id = 1; id <= tileCount(meta); id += 1) {
    if (image.crop(cropBox(meta, id)).getBBox()) out.add(id);
  }
  return out;
}
function makeSelftestMap(meta) {
  const nonEmpty = nonEmptyTileIds(meta);
  const data = [];
  for (let r = 0; r < meta.rows; r += 1) {
    const row = [];
    for (let c = 0; c < meta.columns; c += 1) {
      const id = tileIdFromColRow(meta, c, r);
      row.push(nonEmpty.has(id) ? id : 0);
    }
    data.push(row);
  }
  return {
    meta: {
      version: 1,
      tileset: meta.name,
      tileWidth: meta.tileW,
      tileHeight: meta.tileH,
      width: meta.columns,
      height: meta.rows,
      generatedFrom: meta.path.split(/[/\\]/).join("/"),
      generator: "asset_tilemap_editor.mjs --make-selftest-map"
    },
    data
  };
}

// src/sprite/frames.ts
import { readdirSync as readdirSync2 } from "node:fs";
import { join as join2 } from "node:path";
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", "[^/]*").replaceAll("?", "[^/]")}$`);
}
function globFrames(dir, pattern = "frame-*.png") {
  const re = globToRegExp(pattern);
  let entries;
  try {
    entries = readdirSync2(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => re.test(name)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map((name) => join2(dir, name));
}
function loadFrames(dir, pattern = "frame-*.png") {
  const paths = globFrames(dir, pattern);
  if (paths.length === 0) throw new Error(`no frames matching ${pattern} in ${dir}`);
  return paths.map((path) => ({ path, image: Bitmap.fromFile(path) }));
}
function median(values) {
  if (values.length === 0) throw new Error("median of an empty sequence");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// src/sprite/chroma.ts
var HIGH_FRINGE_REMOVAL_RATIO = 0.02;
function colorDistance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}
function chromaFringeChannels(chroma) {
  const dominant = [0, 1, 2].filter((i) => chroma[i] >= 128);
  const suppressed = [0, 1, 2].filter((i) => chroma[i] < 128);
  if (dominant.length === 0 || suppressed.length === 0) {
    throw new Error(
      `chroma (${chroma.join(", ")}) cannot be split into dominant/suppressed channels; fringe cleanup needs a saturated matte color such as #00FF00 or #FF00FF`
    );
  }
  return { dominant, suppressed };
}
function isGreenMatte(chroma) {
  return chroma[1] >= 180 && chroma[1] - Math.max(chroma[0], chroma[2]) >= 80;
}
function isKeyableFringeChroma(chroma) {
  let split;
  try {
    split = chromaFringeChannels(chroma);
  } catch {
    return false;
  }
  const low = Math.min(...split.dominant.map((i) => chroma[i]));
  const high = Math.max(...split.suppressed.map((i) => chroma[i]));
  return low >= 180 && low - high >= 80;
}
function fringeWarning(removed, kept, chroma) {
  const total = removed + kept;
  if (total <= 0) return null;
  if (removed / total < HIGH_FRINGE_REMOVAL_RATIO) return null;
  return isGreenMatte(chroma) ? "high green-fringe removal ratio; green foreground details may have been removed. Use a non-green matte such as #FF00FF, or pass --no-decontam to keep green specks." : "high fringe removal ratio; foreground details close to the matte color may have been removed. Use a matte color absent from the sprite, or pass --no-decontam.";
}
function backgroundReachable(width, height, isFloodable) {
  const reachable = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const enqueue = (x, y) => {
    const index = y * width + x;
    if (reachable[index] || !isFloodable(index)) return;
    reachable[index] = 1;
    queue[tail++] = index;
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
    const index = queue[head++];
    const y = Math.floor(index / width);
    const x = index - y * width;
    if (x + 1 < width) enqueue(x + 1, y);
    if (x > 0) enqueue(x - 1, y);
    if (y + 1 < height) enqueue(x, y + 1);
    if (y > 0) enqueue(x, y - 1);
  }
  return reachable;
}
function hasBackgroundNeighbor(reachable, x, y, width, height, radius) {
  for (let ny = Math.max(0, y - radius); ny < Math.min(height, y + radius + 1); ny += 1) {
    for (let nx = Math.max(0, x - radius); nx < Math.min(width, x + radius + 1); nx += 1) {
      if (nx === x && ny === y) continue;
      if (reachable[ny * width + nx]) return true;
    }
  }
  return false;
}
function keepLargestComponents(image, minArea) {
  const { width, height } = image;
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const out = Bitmap.create(width, height);
  for (let startY = 0; startY < height; startY += 1) {
    for (let startX = 0; startX < width; startX += 1) {
      const start = startY * width + startX;
      if (seen[start] || image.data[start * 4 + 3] === 0) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      seen[start] = 1;
      const points = [];
      while (head < tail) {
        const index = queue[head++];
        points.push(index);
        const y = Math.floor(index / width);
        const x = index - y * width;
        const visit = (nx, ny) => {
          const n = ny * width + nx;
          if (seen[n] || image.data[n * 4 + 3] === 0) return;
          seen[n] = 1;
          queue[tail++] = n;
        };
        if (x + 1 < width) visit(x + 1, y);
        if (x > 0) visit(x - 1, y);
        if (y + 1 < height) visit(x, y + 1);
        if (y > 0) visit(x, y - 1);
      }
      if (points.length >= minArea) {
        for (const index of points) {
          const p = index * 4;
          out.data[p] = image.data[p];
          out.data[p + 1] = image.data[p + 1];
          out.data[p + 2] = image.data[p + 2];
          out.data[p + 3] = image.data[p + 3];
        }
      }
    }
  }
  return out;
}
function keyMatte(image, options) {
  const { chroma, tolerance = 90, keepLargest = false, minComponentArea = 80 } = options;
  const { width, height } = image;
  const candidate = new Uint8Array(width * height);
  let candidates = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    const p = index * 4;
    if (image.data[p + 3] === 0) {
      candidate[index] = 1;
      continue;
    }
    const rgb = [image.data[p], image.data[p + 1], image.data[p + 2]];
    if (colorDistance(rgb, chroma) <= tolerance) {
      candidate[index] = 1;
      candidates += 1;
    }
  }
  const reachable = backgroundReachable(width, height, (index) => candidate[index] === 1);
  let out = Bitmap.create(width, height);
  let removed = 0;
  let kept = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    const p = index * 4;
    const alpha = image.data[p + 3];
    if (reachable[index]) {
      if (alpha !== 0) removed += 1;
      continue;
    }
    if (alpha === 0) continue;
    out.data[p] = image.data[p];
    out.data[p + 1] = image.data[p + 1];
    out.data[p + 2] = image.data[p + 2];
    out.data[p + 3] = alpha;
    kept += 1;
  }
  if (keepLargest) out = keepLargestComponents(out, minComponentArea);
  const bbox = out.getBBox();
  return {
    image: out,
    record: {
      chromaRgb: [...chroma],
      tolerance,
      keepLargest,
      minComponentArea: keepLargest ? minComponentArea : null,
      removedPixels: removed,
      inToleranceCandidates: candidates,
      keptPixels: kept,
      bbox: bbox ? [bbox.left, bbox.top, bbox.right, bbox.bottom] : null
    }
  };
}
function removeChromaFringe(image, options) {
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
      const alpha = image.data[p + 3];
      if (alpha === 0) continue;
      const rgb = [image.data[p], image.data[p + 1], image.data[p + 2]];
      const low = Math.min(...dominant.map((i) => rgb[i]));
      const high = Math.max(...suppressed.map((i) => rgb[i]));
      if (hasBackgroundNeighbor(reachable, x, y, width, height, edgeRadius) && low >= minLevel && low - high >= dominance) {
        removed += 1;
        continue;
      }
      out.data[p] = rgb[0];
      out.data[p + 1] = rgb[1];
      out.data[p + 2] = rgb[2];
      out.data[p + 3] = alpha;
      kept += 1;
    }
  }
  const bbox = out.getBBox();
  return {
    image: out,
    record: {
      chromaRgb: [...chroma],
      removedFringePixels: removed,
      keptPixels: kept,
      removedToKeptRatio: removed / Math.max(1, kept),
      minLevel,
      dominance,
      edgeRadius,
      bbox: bbox ? [bbox.left, bbox.top, bbox.right, bbox.bottom] : null,
      warning: fringeWarning(removed, kept, chroma)
    }
  };
}
function nearTransparentMask(image, radius) {
  const { width, height } = image;
  let near = new Uint8Array(width * height);
  for (let i = 0; i < near.length; i += 1) near[i] = image.data[i * 4 + 3] === 0 ? 1 : 0;
  for (let step = 0; step < Math.max(0, radius); step += 1) {
    const grown = Uint8Array.from(near);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!near[y * width + x]) continue;
        if (y + 1 < height) grown[(y + 1) * width + x] = 1;
        if (y > 0) grown[(y - 1) * width + x] = 1;
        if (x + 1 < width) grown[y * width + x + 1] = 1;
        if (x > 0) grown[y * width + x - 1] = 1;
      }
    }
    near = grown;
  }
  return near;
}
function despillChroma(image, options) {
  const { chroma, edgeRadius = 2, bandOnly = true } = options;
  const { dominant, suppressed } = chromaFringeChannels(chroma);
  const out = image.copy();
  const near = bandOnly ? nearTransparentMask(image, edgeRadius) : null;
  let despilled = 0;
  let spillRemoved = 0;
  for (let index = 0; index < image.width * image.height; index += 1) {
    const p = index * 4;
    if (image.data[p + 3] === 0) continue;
    if (near && !near[index]) continue;
    const high = Math.max(...suppressed.map((i) => image.data[p + i]));
    let changed = false;
    let delta = 0;
    for (const channel of dominant) {
      const original = image.data[p + channel];
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
      chromaRgb: [...chroma],
      edgeRadius,
      bandOnly,
      despilledPixels: despilled,
      spillRemoved
    }
  };
}
function decontaminateMatte(image, options) {
  const { chroma, excess = 50, minLevel = 100 } = options;
  const { dominant, suppressed } = chromaFringeChannels(chroma);
  const out = image.copy();
  let removed = 0;
  for (let index = 0; index < image.width * image.height; index += 1) {
    const p = index * 4;
    if (image.data[p + 3] <= 0) continue;
    const domMin = Math.min(...dominant.map((i) => image.data[p + i]));
    const supMax = Math.max(...suppressed.map((i) => image.data[p + i]));
    if (domMin - supMax > excess && domMin > minLevel) {
      out.data[p + 3] = 0;
      removed += 1;
    }
  }
  return { image: out, record: { specksRemoved: removed } };
}
function cleanChroma(image, options) {
  const { chroma, tolerance = 90, fringeRadius = 1, despillRadius = 2, decontam = true } = options;
  const keyed = keyMatte(image, { chroma, tolerance });
  const defringed = removeChromaFringe(keyed.image, { chroma, edgeRadius: fringeRadius });
  const despilled = despillChroma(defringed.image, { chroma, edgeRadius: despillRadius });
  let result = despilled.image;
  let decontamRecord = { skipped: true };
  if (decontam && isKeyableFringeChroma(chroma)) {
    const cleaned = decontaminateMatte(result, { chroma });
    result = cleaned.image;
    decontamRecord = cleaned.record;
  }
  return {
    image: result,
    key: keyed.record,
    fringe: defringed.record,
    despill: despilled.record,
    decontam: decontamRecord
  };
}

// src/sprite/normalize.ts
import { basename, join as join3 } from "node:path";
function normalizeCanvas(inputDir, outDir, options = {}) {
  const {
    glob = "frame-*.png",
    canvas = { width: 256, height: 256 },
    pad = 6,
    allowUpscale = true,
    targetHeight = null,
    charFill = 0.5
  } = options;
  const frames = loadFrames(inputDir, glob);
  const boxes = frames.map((f) => f.image.getBBox()).filter((b) => b !== null);
  if (boxes.length === 0) throw new Error(`all frames in ${inputDir} are empty`);
  const unionLeft = Math.min(...boxes.map((b) => b.left));
  const unionTop = Math.min(...boxes.map((b) => b.top));
  const unionRight = Math.max(...boxes.map((b) => b.right));
  const unionBottom = Math.max(...boxes.map((b) => b.bottom));
  const unionWidth = unionRight - unionLeft;
  const unionHeight = unionBottom - unionTop;
  const availableWidth = canvas.width - 2 * pad;
  const availableHeight = canvas.height - 2 * pad;
  const charHeight = median(boxes.map((b) => b.bottom - b.top)) || 1;
  const charTarget = targetHeight ?? canvas.height * charFill;
  const scaleChar = charTarget / charHeight;
  const scaleFit = Math.min(availableWidth / unionWidth, availableHeight / unionHeight);
  let scale = Math.min(scaleChar, scaleFit);
  if (!allowUpscale) scale = Math.min(scale, 1);
  const newWidth = Math.max(1, roundHalfToEven(unionWidth * scale));
  const newHeight = Math.max(1, roundHalfToEven(unionHeight * scale));
  const pasteX = Math.floor((canvas.width - newWidth) / 2);
  const pasteY = canvas.height - pad - newHeight;
  const written = [];
  for (const frame of frames) {
    const cropped = frame.image.crop({ left: unionLeft, top: unionTop, right: unionRight, bottom: unionBottom }).resize(newWidth, newHeight, "lanczos");
    const out = Bitmap.create(canvas.width, canvas.height);
    out.pasteMasked(cropped, pasteX, pasteY, cropped.channel(3));
    const dst = join3(outDir, basename(frame.path));
    out.toFile(dst);
    written.push(dst);
  }
  return written;
}

// src/sprite/presets.ts
var action = (name, defaultFrames, recommendedFrames, fps, timing, loopable, selectionPolicy) => ({
  action: name,
  defaultFrames,
  recommendedFrames,
  fps,
  timing,
  loopable,
  selectionPolicy
});
var ACTIONS = {
  idle: action("idle", 10, [8, 10, 12], 6, "loop", true, "cycle"),
  hurt: action("hurt", 6, [4, 5, 6, 8], 8, "one_shot", false, "action_window"),
  jump: action("jump", 6, [6, 8, 10], 8, "transition", false, "full_duration_include_end"),
  crouch: action("crouch", 6, [5, 6, 8], 8, "hold", true, "hold_pose"),
  attack: action("attack", 8, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  death: action("death", 10, [8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  walk: action("walk", 8, [8, 10, 12], 10, "loop", true, "cycle"),
  run: action("run", 8, [8, 10, 12], 12, "loop", true, "cycle"),
  roll: action("roll", 8, [6, 8, 10], 14, "one_shot", false, "action_window"),
  dash: action("dash", 6, [5, 6, 8], 14, "one_shot", false, "action_window"),
  talk: action("talk", 12, [8, 10, 12], 8, "loop", true, "cycle"),
  interact: action("interact", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  pick_up: action("pick_up", 12, [8, 10, 12], 8, "one_shot", false, "action_window"),
  use: action("use", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  examine: action("examine", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  give: action("give", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  shrug: action("shrug", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  walk_forward: action("walk_forward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_backward: action("walk_backward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  block_high: action("block_high", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  block_low: action("block_low", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  knockdown: action(
    "knockdown",
    12,
    [8, 10, 12],
    8,
    "transition",
    false,
    "full_duration_include_end"
  ),
  get_up: action("get_up", 12, [6, 8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  light_attack: action("light_attack", 8, [6, 8, 10, 12], 12, "one_shot", false, "action_window"),
  heavy_attack: action("heavy_attack", 12, [6, 8, 10, 12], 10, "one_shot", false, "action_window")
};
var PLATFORMER = {
  profile: "platformer",
  description: "Side-view platformer defaults: loops, jumps, attacks, reactions, death.",
  direction: "w",
  actions: ["idle", "walk", "run", "jump", "roll", "attack", "hurt", "crouch", "death"],
  frameOverrides: {}
};
var FIGHTING = {
  profile: "fighting-game",
  description: "Side-view brawler/fighter: longer loops, blocks, knockdown/get-up transitions.",
  direction: "w",
  actions: [
    "idle",
    "walk",
    "run",
    "jump",
    "crouch",
    "hurt",
    "walk_forward",
    "walk_backward",
    "light_attack",
    "heavy_attack",
    "attack",
    "block_high",
    "block_low",
    "knockdown",
    "get_up",
    "death"
  ],
  // Core loops widen to 12; hurt/jump/crouch widen to 8.
  frameOverrides: {
    idle: 12,
    walk: 12,
    run: 12,
    attack: 12,
    death: 12,
    hurt: 8,
    jump: 8,
    crouch: 8
  }
};
var POINT_AND_CLICK = {
  profile: "point-and-click",
  description: "Classic adventure character: dialogue + object-interaction gestures, video-first.",
  direction: "sw",
  actions: ["idle", "walk", "talk", "interact", "pick_up", "use", "examine", "give", "shrug"],
  frameOverrides: {}
};
var PROFILES = {
  platformer: PLATFORMER,
  "fighting-game": FIGHTING,
  "point-and-click": POINT_AND_CLICK,
  // `adventure` is an alias and is hidden from listings.
  adventure: POINT_AND_CLICK
};
var PROFILE_ALIASES = /* @__PURE__ */ new Set(["adventure"]);
function canonicalProfiles() {
  return Object.keys(PROFILES).filter((key) => !PROFILE_ALIASES.has(key));
}
function resolveProfile(profileId) {
  const key = profileId ?? "platformer";
  const profile = PROFILES[key];
  if (!profile) {
    const known = canonicalProfiles().sort().join(", ");
    throw new Error(`unknown profile '${key}'; expected one of: ${known}`);
  }
  return profile;
}
function actionFacts(actionId, profile = null) {
  const preset = ACTIONS[actionId];
  if (!preset) {
    const known = Object.keys(ACTIONS).sort().join(", ");
    throw new Error(`unknown action '${actionId}'; expected one of: ${known}`);
  }
  const facts = {
    ...preset,
    recommendedFrames: [...preset.recommendedFrames],
    // Transitions (jump/death/get_up) keep their vertical travel; everything
    // else lands feet on a shared baseline.
    anchorPolicy: preset.timing === "transition" ? "preserve-motion" : "grounded"
  };
  const override = profile?.frameOverrides[actionId];
  if (override !== void 0) {
    facts.defaultFrames = override;
    facts.profileOverride = true;
  }
  return facts;
}
function coerceFrameCount(actionId, requested) {
  const recommended = ACTIONS[actionId].recommendedFrames;
  if (recommended.includes(requested)) return { frames: requested, warning: null };
  let nearest2 = recommended[0];
  for (const value of recommended) {
    const better = Math.abs(value - requested) < Math.abs(nearest2 - requested) || Math.abs(value - requested) === Math.abs(nearest2 - requested) && value > nearest2;
    if (better) nearest2 = value;
  }
  return {
    frames: nearest2,
    warning: `frame count ${requested} not recommended for ${actionId}; coerced to ${nearest2} (recommended: (${recommended.join(", ")}))`
  };
}
function formatPythonValue(value) {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === void 0) return "None";
  if (Array.isArray(value)) return `[${value.map(formatPythonValue).join(", ")}]`;
  return String(value);
}

// src/sprite/recover.ts
function sampleBackground(image) {
  const corners = [
    image.getPixel(0, 0),
    image.getPixel(image.width - 1, 0),
    image.getPixel(0, image.height - 1),
    image.getPixel(image.width - 1, image.height - 1)
  ];
  return [0, 1, 2].map(
    (channel) => Math.round(corners.reduce((sum, c) => sum + c[channel], 0) / corners.length)
  );
}
function findComponents(image, background, threshold) {
  const { width, height } = image;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = image.getPixel(x, y);
      const distance = Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]);
      if (distance > threshold) mask[y * width + x] = 1;
    }
  }
  const seen = new Uint8Array(width * height);
  const components = [];
  const queue = new Int32Array(width * height);
  for (let startY = 0; startY < height; startY += 1) {
    for (let startX = 0; startX < width; startX += 1) {
      const start = startY * width + startX;
      if (seen[start] || !mask[start]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      seen[start] = 1;
      const points = [];
      let minX = startX;
      let maxX = startX;
      let minY = startY;
      let maxY = startY;
      while (head < tail) {
        const index = queue[head++];
        const y = Math.floor(index / width);
        const x = index - y * width;
        points.push(index);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x + 1 < width && !seen[index + 1] && mask[index + 1]) {
          seen[index + 1] = 1;
          queue[tail++] = index + 1;
        }
        if (x > 0 && !seen[index - 1] && mask[index - 1]) {
          seen[index - 1] = 1;
          queue[tail++] = index - 1;
        }
        if (y + 1 < height && !seen[index + width] && mask[index + width]) {
          seen[index + width] = 1;
          queue[tail++] = index + width;
        }
        if (y > 0 && !seen[index - width] && mask[index - width]) {
          seen[index - width] = 1;
          queue[tail++] = index - width;
        }
      }
      components.push({
        area: points.length,
        bbox: [minX, minY, maxX, maxY],
        center: [(minX + maxX) / 2, (minY + maxY) / 2],
        points
      });
    }
  }
  return components;
}
function recoverFrames(sheetPath, options) {
  const { rows, cols, frames, threshold } = options;
  if (rows <= 0 || cols <= 0) throw new Error("--rows and --cols must be positive integers");
  if (frames !== null && frames <= 0) throw new Error("--frames must be a positive integer");
  const image = Bitmap.fromFile(sheetPath);
  const background = sampleBackground(image);
  const components = findComponents(image, background, threshold);
  const wanted = rows * cols;
  const selected = [...components].sort((a, b) => b.area - a.area).slice(0, wanted);
  const assigned = Array.from({ length: wanted }, () => null);
  const cellWidth2 = image.width / cols;
  const cellHeight2 = image.height / rows;
  for (const component of selected) {
    const col = Math.min(cols - 1, Math.max(0, Math.floor(component.center[0] / cellWidth2)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(component.center[1] / cellHeight2)));
    const index = row * cols + col;
    const current = assigned[index] ?? null;
    if (current === null || component.area > current.area) assigned[index] = component;
  }
  const required = frames === null ? wanted : Math.min(frames, wanted);
  const missing = assigned.slice(0, required).map((item, i) => item === null ? i + 1 : 0).filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Recovery found ${components.length} distinct pose(s) but ${required} frame(s) were requested; grid slots ${missing.join(", ")} came up empty. The model likely merged poses across cells or laid out fewer than ${required}. Re-run without --recover to slice the grid uniformly instead.`
    );
  }
  const emitted = frames === null ? assigned : assigned.slice(0, required);
  const result = {
    sheet: sheetPath,
    bg_rgb: background,
    rows,
    cols,
    threshold,
    frames: []
  };
  if (frames !== null) result.requested_frames = required;
  const crops = emitted.map((component, i) => {
    if (!component) throw new Error("internal: unassigned frame slot survived validation");
    const [minX, minY, maxX, maxY] = component.bbox;
    const crop = Bitmap.create(maxX - minX + 1, maxY - minY + 1);
    for (const point of component.points) {
      const y = Math.floor(point / image.width);
      const x = point - y * image.width;
      crop.putPixel(x - minX, y - minY, image.getPixel(x, y));
    }
    return {
      /** 1-based, zero-padded to two digits by callers for the filename. */
      index: i + 1,
      label: String(i + 1).padStart(2, "0"),
      image: crop,
      bbox: component.bbox,
      area: component.area,
      center: component.center
    };
  });
  return { result, crops };
}

// src/sprite/sequence-gif.ts
function buildSequenceGif(frames, flatBackground) {
  if (frames.length === 0) throw new Error("No frames selected");
  const composed = frames.map(({ path, delayMs }) => {
    let bitmap = Bitmap.fromFile(path);
    if (flatBackground) {
      const backdrop = Bitmap.create(bitmap.width, bitmap.height, flatBackground);
      backdrop.alphaComposite(bitmap, 0, 0);
      bitmap = backdrop;
    }
    return { bitmap, delayMs };
  });
  return encodeGif(composed);
}

// src/sprite/qc.ts
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";
var ALPHA_ON = 16;
var EMPTY_AREA_FRAC = 3e-3;
var CLIP_BORDER_FRAC = 0.01;
var BASELINE_TOL = 0.12;
var SIZE_DRIFT_TOL = 0.35;
var FACING_CX_TOL = 0.18;
function roundTo(value, digits) {
  const factor = 10 ** digits;
  return roundHalfToEven(value * factor) / factor;
}
function pstdev(values) {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
function percent(value, digits = 0) {
  return `${roundTo(value * 100, digits).toFixed(digits)}%`;
}
function frameGeometry(sheet, sheetPath, frameWidth, frameHeight) {
  if (frameWidth !== null && frameHeight !== null) {
    if (frameWidth <= 0 || frameHeight <= 0) {
      throw new Error("--frame-width and --frame-height must be positive");
    }
    const columns2 = Math.max(1, Math.floor(sheet.width / frameWidth));
    return { frameWidth, frameHeight, count: columns2, columns: columns2, rows: 1 };
  }
  const manifestPath = sheetPath.replace(/\.[^./\\]+$/, ".json");
  if (existsSync4(manifestPath)) {
    const m = JSON.parse(readFileSync4(manifestPath, "utf8"));
    const count = Math.trunc(m.frameCount);
    return {
      frameWidth: Math.trunc(m.frameWidth),
      frameHeight: Math.trunc(m.frameHeight),
      count,
      columns: Math.trunc(m.columns || count),
      rows: Math.trunc(m.rows || 1)
    };
  }
  const side = sheet.height;
  const columns = Math.max(1, Math.floor(sheet.width / side));
  return { frameWidth: side, frameHeight: side, count: columns, columns, rows: 1 };
}
function frameMetrics(sheet, index, geometry) {
  const { frameWidth: fw, frameHeight: fh, columns } = geometry;
  const row = Math.floor(index / columns);
  const col = index - row * columns;
  const originX = col * fw;
  const originY = row * fh;
  const xs = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let opaque = 0;
  for (let y = 0; y < fh; y += 1) {
    for (let x = 0; x < fw; x += 1) {
      const sx = originX + x;
      const sy = originY + y;
      if (!sheet.contains(sx, sy)) continue;
      if (sheet.data[sheet.index(sx, sy) + 3] <= ALPHA_ON) continue;
      opaque += 1;
      xs.push(x);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (opaque === 0) {
    return {
      empty: true,
      area_frac: 0,
      height: 0,
      width: 0,
      cx_frac: 0,
      baseline_frac: 1,
      border_frac: 0
    };
  }
  let borderOpaque = 0;
  let borderTotal = 0;
  const sample = (x, y) => {
    borderTotal += 1;
    const sx = originX + x;
    const sy = originY + y;
    if (sheet.contains(sx, sy) && sheet.data[sheet.index(sx, sy) + 3] > ALPHA_ON)
      borderOpaque += 1;
  };
  for (let x = 0; x < fw; x += 1) {
    sample(x, 0);
    sample(x, fh - 1);
  }
  for (let y = 0; y < fh; y += 1) {
    sample(0, y);
    sample(fw - 1, y);
  }
  const meanX = xs.reduce((sum, v) => sum + v, 0) / xs.length;
  return {
    empty: false,
    area_frac: roundTo(opaque / (fw * fh), 4),
    height: maxY - minY + 1,
    width: maxX - minX + 1,
    // Horizontal mass offset from the cell centre, as a fraction of width.
    cx_frac: roundTo((meanX - fw / 2) / fw, 4),
    // Foot baseline: bottom of the figure as a fraction from the top.
    baseline_frac: roundTo((maxY + 1) / fh, 4),
    border_frac: roundTo(borderOpaque / borderTotal, 4)
  };
}
function isLocalExtremum(values, i) {
  if (i === 0 || i === values.length - 1) return false;
  const prev = values[i - 1];
  const next = values[i + 1];
  const value = values[i];
  return value > prev && value > next || value < prev && value < next;
}
function qc(metrics) {
  const checks = [];
  const live = metrics.map((m, i) => ({ index: i, m })).filter((entry) => !entry.m.empty);
  const empty = metrics.map((m, i) => m.empty || m.area_frac < EMPTY_AREA_FRAC ? i + 1 : 0).filter(Boolean);
  if (empty.length > 0) {
    checks.push({
      check: "empty",
      severity: "warn",
      frames: empty,
      detail: `${empty.length} frame(s) blank or near-blank (area < ${percent(EMPTY_AREA_FRAC, 1)})`
    });
  }
  const clipped = metrics.map((m, i) => m.border_frac > CLIP_BORDER_FRAC ? i + 1 : 0).filter(Boolean);
  if (clipped.length > 0) {
    checks.push({
      check: "clip",
      severity: "warn",
      frames: clipped,
      detail: `${clipped.length} frame(s) touch the cell border (likely cut off)`
    });
  }
  if (live.length >= 2) {
    const baselines = live.map((entry) => entry.m.baseline_frac);
    const spread = Math.max(...baselines) - Math.min(...baselines);
    if (spread > BASELINE_TOL) {
      const medianBaseline = median(baselines);
      const worst = live.filter((_, k) => Math.abs(baselines[k] - medianBaseline) > BASELINE_TOL / 2).map((entry) => entry.index + 1);
      checks.push({
        check: "baseline",
        severity: "warn",
        frames: worst,
        detail: `foot baseline varies ${percent(spread)} of cell height (should be pinned by normalize)`
      });
    }
    const heights = live.map((entry) => entry.m.height);
    const medianHeight = median(heights);
    const cov = medianHeight ? roundTo(pstdev(heights) / medianHeight, 3) : 0;
    const drift = heights.map((h) => h / medianHeight);
    const sizeFrames = live.filter((_, k) => Math.abs(drift[k] - 1) > SIZE_DRIFT_TOL && isLocalExtremum(drift, k)).map((entry) => entry.index + 1);
    if (sizeFrames.length > 0) {
      checks.push({
        check: "size",
        severity: "hint",
        frames: sizeFrames,
        height_cov: cov,
        detail: `frame(s) are isolated size outliers (>${percent(SIZE_DRIFT_TOL)} off median height) \u2014 verify it is an intended pose change, not the model drawing the character at a different scale. height CoV=${cov}`
      });
    }
    const cxs = live.map((entry) => entry.m.cx_frac);
    const medianCx = median(cxs);
    const facingFrames = live.filter((_, k) => Math.abs(cxs[k] - medianCx) > FACING_CX_TOL).map((entry) => entry.index + 1);
    if (facingFrames.length > 0) {
      const signed = `${medianCx >= 0 ? "+" : ""}${medianCx.toFixed(2)}`;
      checks.push({
        check: "facing",
        severity: "hint",
        frames: facingFrames,
        detail: `frame(s) have horizontal mass far from the others (median cx=${signed}) \u2014 possible mirrored/flipped facing; eyeball the review gif`
      });
    }
  }
  return checks;
}
function verdictFor(checks) {
  if (checks.some((c) => c.severity === "warn")) return "warn";
  if (checks.some((c) => c.severity === "hint")) return "review";
  return "clean";
}
function runQc(sheetPath, frameWidth, frameHeight) {
  const sheet = Bitmap.fromFile(sheetPath);
  const geometry = frameGeometry(sheet, sheetPath, frameWidth, frameHeight);
  const metrics = Array.from(
    { length: geometry.count },
    (_, i) => frameMetrics(sheet, i, geometry)
  );
  const checks = qc(metrics);
  return {
    sheet: sheetPath,
    frameWidth: geometry.frameWidth,
    frameHeight: geometry.frameHeight,
    frameCount: geometry.count,
    columns: geometry.columns,
    rows: geometry.rows,
    verdict: verdictFor(checks),
    checks,
    frames: metrics
  };
}

// src/sprite/pixel-snap.ts
var DEFAULT_SNAP_CONFIG = {
  kColors: 16,
  kSeed: 42,
  maxKmeansIterations: 15,
  peakThresholdMultiplier: 0.2,
  peakDistanceFilter: 4,
  walkerSearchWindowRatio: 0.35,
  walkerMinSearchWindow: 2,
  walkerStrengthThreshold: 0.5,
  fallbackTargetSegments: 64,
  maxStepRatio: 1.8
};
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = state + 1831565813 >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function sampleWithoutReplacement(limit, count, seed) {
  const random = makeRandom(seed);
  const pool = new Int32Array(limit);
  for (let i = 0; i < limit; i += 1) pool[i] = i;
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(random() * (limit - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return Array.from(pool.subarray(0, count));
}
function quantize2(image, config) {
  const opaque = [];
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] > 0) opaque.push(i);
  }
  if (opaque.length === 0) return image.copy();
  const k = Math.min(config.kColors, opaque.length);
  const centers = sampleWithoutReplacement(opaque.length, k, config.kSeed).map((index) => {
    const p = opaque[index];
    return [image.data[p], image.data[p + 1], image.data[p + 2]];
  });
  const labels = new Int32Array(opaque.length);
  for (let iteration = 0; iteration < config.maxKmeansIterations; iteration += 1) {
    for (let n = 0; n < opaque.length; n += 1) {
      const p = opaque[n];
      const r = image.data[p];
      const g = image.data[p + 1];
      const b = image.data[p + 2];
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centers.length; c += 1) {
        const center = centers[c];
        const dr = r - center[0];
        const dg = g - center[1];
        const db = b - center[2];
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
        const p = opaque[n];
        sumR += image.data[p];
        sumG += image.data[p + 1];
        sumB += image.data[p + 2];
        members += 1;
      }
      if (members === 0) continue;
      const next = [sumR / members, sumG / members, sumB / members];
      const center = centers[c];
      if (next.some((value, i) => Math.abs(value - center[i]) > 0.5)) moved = true;
      centers[c] = next;
    }
    if (!moved) break;
  }
  const out = image.copy();
  for (let n = 0; n < opaque.length; n += 1) {
    const p = opaque[n];
    const center = centers[labels[n]];
    out.data[p] = Math.round(center[0]);
    out.data[p + 1] = Math.round(center[1]);
    out.data[p + 2] = Math.round(center[2]);
  }
  return out;
}
function computeProfiles(image) {
  const { width: w, height: h } = image;
  if (w < 3 || h < 3) throw new Error("Image too small (minimum 3x3)");
  const luma = new Float64Array(w * h);
  for (let i = 0; i < luma.length; i += 1) {
    const p = i * 4;
    if (image.data[p + 3] === 0) continue;
    luma[i] = 0.299 * image.data[p] + 0.587 * image.data[p + 1] + 0.114 * image.data[p + 2];
  }
  const columns = new Float64Array(w);
  for (let x = 1; x < w - 1; x += 1) {
    let sum = 0;
    for (let y = 0; y < h; y += 1) sum += Math.abs(luma[y * w + x + 1] - luma[y * w + x - 1]);
    columns[x] = sum;
  }
  const rows = new Float64Array(h);
  for (let y = 1; y < h - 1; y += 1) {
    let sum = 0;
    for (let x = 0; x < w; x += 1) sum += Math.abs(luma[(y + 1) * w + x] - luma[(y - 1) * w + x]);
    rows[y] = sum;
  }
  return { columns, rows };
}
function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function estimateStepSize(profile, config) {
  if (profile.length === 0) return null;
  let max = 0;
  for (const value of profile) if (value > max) max = value;
  if (max === 0) return null;
  const threshold = max * config.peakThresholdMultiplier;
  const peaks = [];
  for (let i = 1; i < profile.length - 1; i += 1) {
    const value = profile[i];
    if (value > threshold && value > profile[i - 1] && value > profile[i + 1]) peaks.push(i);
  }
  if (peaks.length < 2) return null;
  const clean = [peaks[0]];
  for (const peak of peaks.slice(1)) {
    if (peak - clean[clean.length - 1] > config.peakDistanceFilter - 1) clean.push(peak);
  }
  if (clean.length < 2) return null;
  const diffs = clean.slice(1).map((value, i) => value - clean[i]);
  return medianOf(diffs);
}
function resolveStepSizes(sx, sy, width, height, config) {
  if (sx !== null && sy !== null) {
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
function walk(profile, stepSize, limit, config) {
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
      if (profile[i] > localMax) {
        localMax = profile[i];
        localIndex = i;
      }
    }
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
function sanitizeCuts(cuts, limit) {
  const seen = [...new Set(cuts.filter((c) => c >= 0 && c <= limit))].sort((a, b) => a - b);
  if (seen.length === 0 || seen[0] !== 0) seen.unshift(0);
  if (seen[seen.length - 1] !== limit) seen.push(limit);
  const deduped = [];
  for (const cut of seen) {
    if (deduped.length === 0 || cut > deduped[deduped.length - 1]) deduped.push(cut);
  }
  return deduped;
}
function resample(image, colCuts, rowCuts) {
  const out = Bitmap.create(colCuts.length - 1, rowCuts.length - 1);
  for (let j = 0; j < out.height; j += 1) {
    const y0 = rowCuts[j];
    const y1 = rowCuts[j + 1];
    for (let i = 0; i < out.width; i += 1) {
      const x0 = colCuts[i];
      const x1 = colCuts[i + 1];
      const counts = /* @__PURE__ */ new Map();
      let first = true;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (!image.contains(x, y)) continue;
          const p = image.index(x, y);
          if (image.data[p + 3] <= 0) continue;
          const rgba = [
            image.data[p],
            image.data[p + 1],
            image.data[p + 2],
            image.data[p + 3]
          ];
          const key = rgba[0] << 24 | rgba[1] << 16 | rgba[2] << 8 | rgba[3];
          const entry = counts.get(key);
          if (entry) entry.count += 1;
          else counts.set(key, { count: 1, rgba });
          first = false;
        }
      }
      if (first) continue;
      let best = null;
      for (const entry of counts.values()) {
        if (!best || entry.count > best.count) best = entry;
      }
      if (best) out.putPixel(i, j, best.rgba);
    }
  }
  return out;
}
function snapImage(inputPath, config) {
  const image = Bitmap.fromFile(inputPath);
  const quantized = quantize2(image, config);
  const { columns, rows } = computeProfiles(quantized);
  const [stepX, stepY] = resolveStepSizes(
    estimateStepSize(columns, config),
    estimateStepSize(rows, config),
    image.width,
    image.height,
    config
  );
  const colCuts = sanitizeCuts(walk(columns, stepX, image.width, config), image.width);
  const rowCuts = sanitizeCuts(walk(rows, stepY, image.height, config), image.height);
  return resample(quantized, colCuts, rowCuts);
}
function snapSheet(image, cols, rows, config) {
  const { width: W, height: H } = image;
  if (W % cols !== 0 || H % rows !== 0) {
    throw new Error(
      `Sheet ${W}x${H} is not divisible by cols=${cols} rows=${rows}; frames would be non-integer dimensions.`
    );
  }
  const fw = W / cols;
  const fh = H / rows;
  const count = cols * rows;
  const strip = Bitmap.create(fw * count, fh);
  for (let index = 0; index < count; index += 1) {
    const r = Math.floor(index / cols);
    const c = index - r * cols;
    strip.paste(
      image.crop({ left: c * fw, top: r * fh, right: (c + 1) * fw, bottom: (r + 1) * fh }),
      index * fw,
      0
    );
  }
  const quantized = quantize2(strip, config);
  const { columns, rows: rowProfile } = computeProfiles(quantized);
  const [stepX, stepY] = resolveStepSizes(
    estimateStepSize(columns, config),
    estimateStepSize(rowProfile, config),
    strip.width,
    strip.height,
    config
  );
  const snapped = resample(
    quantized,
    sanitizeCuts(walk(columns, stepX, strip.width, config), strip.width),
    sanitizeCuts(walk(rowProfile, stepY, strip.height, config), strip.height)
  );
  const tw = Math.floor(snapped.width / count);
  const sh = snapped.height;
  const out = Bitmap.create(tw * cols, sh * rows);
  for (let index = 0; index < count; index += 1) {
    const r = Math.floor(index / cols);
    const c = index - r * cols;
    out.paste(
      snapped.crop({ left: index * tw, top: 0, right: (index + 1) * tw, bottom: sh }),
      c * tw,
      r * sh
    );
  }
  return {
    image: out,
    info: {
      inputDims: [W, H],
      inputFrameDims: [fw, fh],
      targetFrameDims: [tw, sh],
      outputDims: [tw * cols, sh * rows]
    }
  };
}

// src/sprite/size-contract.ts
import { existsSync as existsSync5, statSync as statSync2 } from "node:fs";
import { basename as basename2 } from "node:path";
var FRAME_WIDTH = 256;
var FRAME_HEIGHT = 256;
var DEFAULT_TOLERANCES = {
  maxTargetHeightDriftPct: 0.08,
  maxIntraHeightDriftPct: 0.08,
  maxBottomDriftPx: 2,
  maxWidthOverflowPct: 0.12,
  maxCenterDriftPx: null
};
function percent2(value, digits = 1) {
  const factor = 10 ** digits;
  return `${(roundHalfToEven(value * 100 * factor) / factor).toFixed(digits)}%`;
}
function fixed0(value) {
  return roundHalfToEven(value).toFixed(0);
}
function optionalNumber(value) {
  if (value === null || value === void 0) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function measureBitmap(image, label, source, frameSize) {
  const bbox = image.getBBox();
  const record = { frame: label, source, frameSize };
  if (!bbox) {
    record.empty = true;
    return record;
  }
  record.empty = false;
  record.alphaBBox = [bbox.left, bbox.top, bbox.right, bbox.bottom];
  record.visibleWidth = bbox.right - bbox.left;
  record.visibleHeight = bbox.bottom - bbox.top;
  record.visibleCenterX = (bbox.left + bbox.right - 1) / 2;
  record.visibleBottomY = bbox.bottom - 1;
  return record;
}
function measureSource(source, cellSize, frameGlob = "frame-*.png") {
  if (existsSync5(source) && statSync2(source).isDirectory()) {
    return globFrames(source, frameGlob).map((path) => {
      const image2 = Bitmap.fromFile(path);
      return measureBitmap(image2, basename2(path), path, [image2.width, image2.height]);
    });
  }
  if (!existsSync5(source)) throw new Error(`missing size contract source: ${source}`);
  const image = Bitmap.fromFile(source);
  const [cellW, cellH] = cellSize;
  if (image.width >= cellW && image.height >= cellH && image.width % cellW === 0 && image.height % cellH === 0) {
    const columns = image.width / cellW;
    const rows = image.height / cellH;
    const out = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const index = row * columns + col + 1;
        const cell = image.crop({
          left: col * cellW,
          top: row * cellH,
          right: (col + 1) * cellW,
          bottom: (row + 1) * cellH
        });
        out.push(
          measureBitmap(cell, `frame-${String(index).padStart(2, "0")}`, source, [cellW, cellH])
        );
      }
    }
    return out;
  }
  return [measureBitmap(image, basename2(source), source, [image.width, image.height])];
}
function summarizeMeasurements(measurements) {
  const live = measurements.filter((m) => !m.empty);
  if (live.length === 0) {
    return { frames: measurements.length, nonEmptyFrames: 0, frameSize: null };
  }
  const widths = live.map((m) => m.visibleWidth);
  const heights = live.map((m) => m.visibleHeight);
  const bottoms = live.map((m) => m.visibleBottomY);
  const centers = live.map((m) => m.visibleCenterX);
  const frameSizes = live.map((m) => m.frameSize).filter(Boolean);
  const first = frameSizes[0];
  const uniform = first !== void 0 && frameSizes.every((size) => size[0] === first[0] && size[1] === first[1]);
  const medianHeight = median(heights);
  return {
    frames: measurements.length,
    nonEmptyFrames: live.length,
    frameSize: uniform ? first : null,
    visibleWidthRange: [Math.min(...widths), Math.max(...widths)],
    visibleHeightRange: [Math.min(...heights), Math.max(...heights)],
    visibleBottomYRange: [Math.min(...bottoms), Math.max(...bottoms)],
    visibleCenterXRange: [Math.min(...centers), Math.max(...centers)],
    medianVisibleWidth: median(widths),
    medianVisibleHeight: medianHeight,
    medianBottomY: median(bottoms),
    medianCenterX: median(centers),
    maxVisibleWidth: Math.max(...widths),
    maxVisibleHeight: Math.max(...heights),
    intraHeightDriftPct: medianHeight ? (Math.max(...heights) - Math.min(...heights)) / medianHeight : null
  };
}
function promptGuidanceForContract(contract) {
  const runtimeCell = contract.runtimeCell ?? [FRAME_WIDTH, FRAME_HEIGHT];
  const targetHeight = contract.targetVisibleHeight;
  const bottomY = contract.targetBottomY;
  const pivot = contract.pivot || "base-center";
  const guidance = [
    "Use a locked camera: no zoom, pan, crop, or camera push-in/out.",
    "Keep the same apparent sprite scale as the input reference for the whole clip.",
    `Keep the sprite's ${pivot} fixed; motion should come from the action, not from sliding the whole sprite around the frame.`,
    "Keep the first and final frames close to the same scale and placement so the result can be packed into a game spritesheet."
  ];
  if (targetHeight) {
    guidance.push(
      `After processing, the sprite should remain about ${targetHeight}px tall inside a ${runtimeCell[0]}x${runtimeCell[1]} runtime cell; treat this as scale guidance, not visible text.`
    );
  }
  if (bottomY !== void 0 && bottomY !== null) {
    guidance.push(
      `Keep the contact/base point visually stable; the intended runtime bottom anchor is y=${bottomY}.`
    );
  }
  return guidance;
}
function check(name, passed, passMessage, warnMessage, observed, target) {
  return {
    name,
    status: passed ? "pass" : "warn",
    message: passed ? passMessage : warnMessage,
    observed,
    target
  };
}
function contractChecks(summary, contract) {
  const tolerances = {
    ...DEFAULT_TOLERANCES,
    ...contract.tolerances ?? {}
  };
  if (summary.nonEmptyFrames === 0) {
    return [
      { name: "non-empty-frames", status: "warn", message: "No non-empty frames were found." }
    ];
  }
  const checks = [];
  const targetHeight = optionalNumber(contract.targetVisibleHeight);
  const medianHeight = optionalNumber(summary.medianVisibleHeight);
  const maxHeightDrift = optionalNumber(tolerances.maxTargetHeightDriftPct);
  if (targetHeight && medianHeight && maxHeightDrift !== null) {
    const range = summary.visibleHeightRange;
    const drift = Math.max(Math.abs(range[0] - targetHeight), Math.abs(range[1] - targetHeight)) / targetHeight;
    checks.push(
      check(
        "target-visible-height",
        drift <= maxHeightDrift,
        `height drift ${percent2(drift)} <= ${percent2(maxHeightDrift)}`,
        `height drift ${percent2(drift)} > ${percent2(maxHeightDrift)}`,
        range,
        targetHeight
      )
    );
  }
  const intraDrift = optionalNumber(summary.intraHeightDriftPct);
  const maxIntraDrift = optionalNumber(tolerances.maxIntraHeightDriftPct);
  if (intraDrift !== null && maxIntraDrift !== null) {
    checks.push(
      check(
        "intra-sequence-height",
        intraDrift <= maxIntraDrift,
        `intra-height drift ${percent2(intraDrift)} <= ${percent2(maxIntraDrift)}`,
        `intra-height drift ${percent2(intraDrift)} > ${percent2(maxIntraDrift)}`,
        summary.visibleHeightRange,
        maxIntraDrift
      )
    );
  }
  const targetBottom = optionalNumber(contract.targetBottomY);
  const maxBottomDrift = optionalNumber(tolerances.maxBottomDriftPx);
  if (targetBottom !== null && maxBottomDrift !== null) {
    const range = summary.visibleBottomYRange;
    const drift = Math.max(Math.abs(range[0] - targetBottom), Math.abs(range[1] - targetBottom));
    checks.push(
      check(
        "target-bottom-y",
        drift <= maxBottomDrift,
        `bottom drift ${fixed0(drift)}px <= ${fixed0(maxBottomDrift)}px`,
        `bottom drift ${fixed0(drift)}px > ${fixed0(maxBottomDrift)}px`,
        range,
        targetBottom
      )
    );
  }
  const maxWidth = optionalNumber(contract.maxVisibleWidth);
  const maxWidthOverflow = optionalNumber(tolerances.maxWidthOverflowPct);
  if (maxWidth && maxWidthOverflow !== null) {
    const observedMax = optionalNumber(summary.maxVisibleWidth);
    const overflow = Math.max(0, ((observedMax ?? 0) - maxWidth) / maxWidth);
    checks.push(
      check(
        "max-visible-width",
        overflow <= maxWidthOverflow,
        `width overflow ${percent2(overflow)} <= ${percent2(maxWidthOverflow)}`,
        `width overflow ${percent2(overflow)} > ${percent2(maxWidthOverflow)}`,
        summary.visibleWidthRange,
        maxWidth
      )
    );
  }
  const targetCenter = optionalNumber(contract.targetCenterX);
  const maxCenterDrift = optionalNumber(tolerances.maxCenterDriftPx);
  if (targetCenter !== null && maxCenterDrift !== null) {
    const range = summary.visibleCenterXRange;
    const drift = Math.max(Math.abs(range[0] - targetCenter), Math.abs(range[1] - targetCenter));
    checks.push(
      check(
        "target-center-x",
        drift <= maxCenterDrift,
        `center drift ${fixed0(drift)}px <= ${fixed0(maxCenterDrift)}px`,
        `center drift ${fixed0(drift)}px > ${fixed0(maxCenterDrift)}px`,
        range,
        targetCenter
      )
    );
  }
  return checks;
}
var BRIEF_KEYS = [
  "name",
  "source",
  "runtimeCell",
  "anchorPolicy",
  "pivot",
  "targetVisibleHeight",
  "targetVisibleWidth",
  "maxVisibleWidth",
  "targetBottomY",
  "targetCenterX",
  "tolerances"
];
function contractBrief(contract) {
  const out = {};
  for (const key of BRIEF_KEYS) if (key in contract) out[key] = contract[key];
  return out;
}
function cellSizeOf(contract) {
  const cell = contract.runtimeCell ?? [FRAME_WIDTH, FRAME_HEIGHT];
  return [Math.trunc(cell[0]), Math.trunc(cell[1])];
}
function loadSizeContract(payload, source) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`size contract must be a JSON object: ${source}`);
  }
  const data = payload;
  if (data.kind !== "sprite-size-contract")
    throw new Error(`not a sprite size contract: ${source}`);
  return {
    ...data,
    runtimeCell: data.runtimeCell ?? [FRAME_WIDTH, FRAME_HEIGHT],
    anchorPolicy: data.anchorPolicy ?? "grounded",
    pivot: data.pivot ?? "base-center",
    tolerances: { ...DEFAULT_TOLERANCES, ...data.tolerances ?? {} }
  };
}
function deriveSizeContract(source, options = {}) {
  const {
    cellSize = [FRAME_WIDTH, FRAME_HEIGHT],
    frameGlob = "frame-*.png",
    name = null,
    action: action2 = null,
    direction = null,
    anchorPolicy = "grounded",
    pivot = "base-center",
    sourceCanvas = null,
    tolerances = {}
  } = options;
  const measurements = measureSource(source, cellSize, frameGlob);
  const summary = summarizeMeasurements(measurements);
  if (summary.nonEmptyFrames === 0) {
    throw new Error(`cannot derive size contract from empty source: ${source}`);
  }
  const targetVisibleHeight = roundHalfToEven(summary.medianVisibleHeight);
  const targetBottomY = roundHalfToEven(summary.medianBottomY);
  const isDir = existsSync5(source) && statSync2(source).isDirectory();
  return {
    version: 1,
    kind: "sprite-size-contract",
    name: name ?? basename2(source).replace(/\.[^.]+$/, ""),
    source,
    sourceKind: isDir ? "directory" : "image",
    action: action2,
    direction,
    runtimeCell: [cellSize[0], cellSize[1]],
    sourceCanvas: sourceCanvas ?? summary.frameSize ?? null,
    anchorPolicy,
    pivot,
    targetVisibleHeight,
    targetVisibleWidth: roundHalfToEven(summary.medianVisibleWidth),
    maxVisibleWidth: summary.maxVisibleWidth,
    targetBottomY,
    targetCenterX: roundHalfToEven(summary.medianCenterX),
    tolerances: { ...DEFAULT_TOLERANCES, ...tolerances },
    measurementsSummary: summary,
    measurements,
    promptGuidance: promptGuidanceForContract({
      runtimeCell: [cellSize[0], cellSize[1]],
      targetVisibleHeight,
      targetBottomY,
      pivot
    })
  };
}
function auditSizeContract(source, contract, options = {}) {
  const { cellSize = null, frameGlob = "frame-*.png", stage = "runtime" } = options;
  const measurements = measureSource(source, cellSize ?? cellSizeOf(contract), frameGlob);
  const summary = summarizeMeasurements(measurements);
  const checks = contractChecks(summary, contract);
  const passed = checks.every((c) => c.status === "pass");
  return {
    version: 1,
    kind: "sprite-size-contract-audit",
    stage,
    source,
    contract: contractBrief(contract),
    status: passed ? "pass" : "warn",
    passed,
    summary,
    checks,
    measurements
  };
}

// src/sprite/prompt.ts
var DIRECTIONS = {
  n: {
    id: "n",
    label: "North",
    promptName: "north / back-facing",
    screenFacing: "back-facing, away from the viewer"
  },
  ne: {
    id: "ne",
    label: "North-East",
    promptName: "north-east / back-right-facing",
    screenFacing: "diagonal back-right-facing, away from the viewer"
  },
  s: {
    id: "s",
    label: "South",
    promptName: "south / front-facing",
    screenFacing: "front-facing, toward the viewer"
  },
  se: {
    id: "se",
    label: "South-East",
    promptName: "south-east / front-right-facing",
    screenFacing: "diagonal front-right-facing, toward screen-right"
  },
  e: {
    id: "e",
    label: "East",
    promptName: "east / right-facing",
    screenFacing: "profile facing screen-right"
  },
  sw: {
    id: "sw",
    label: "South-West",
    promptName: "south-west / front-left-facing",
    screenFacing: "diagonal front-left-facing, toward screen-left"
  },
  w: {
    id: "w",
    label: "West",
    promptName: "west / left-facing",
    screenFacing: "profile facing screen-left"
  },
  nw: {
    id: "nw",
    label: "North-West",
    promptName: "north-west / back-left-facing",
    screenFacing: "diagonal back-left-facing, away toward screen-left"
  }
};
function getDirection(directionId) {
  const resolved = (directionId || "").trim().toLowerCase();
  const direction = DIRECTIONS[resolved];
  if (!direction) {
    throw new Error(
      `unknown direction '${directionId}'; expected one of: ${Object.keys(DIRECTIONS).join(", ")}`
    );
  }
  return direction;
}
var ANCHOR_GAME_VIEWS = {
  platformer: "side-scrolling / side-view platformer or action game",
  adventure: "point-and-click adventure character view",
  "point-and-click": "point-and-click adventure character view",
  "top-down": "experimental loose top-down or three-quarter top-down game",
  "rts-oblique": "Warcraft-like elevated oblique RTS unit camera",
  isometric: "experimental true isometric tactics / diamond-tile game",
  generic: "generic 2D game asset pipeline"
};
var ANCHOR_ROLES = {
  character: "playable or NPC character",
  enemy: "enemy or creature",
  prop: "small interactive or decorative prop",
  turret: "planted turret or mechanical hazard",
  object: "non-character game object"
};
var VIEW_ALIASES = {
  "side-scroller": "platformer",
  "point-and-click": "adventure",
  point_and_click: "adventure",
  pnc: "adventure",
  "adventure-game": "adventure",
  rts: "rts-oblique",
  "rts-oblique": "rts-oblique",
  rts_oblique: "rts-oblique",
  warcraft: "rts-oblique",
  "warcraft-rts": "rts-oblique",
  "oblique-rts": "rts-oblique",
  "isometric-rts": "rts-oblique",
  "iso-rts": "rts-oblique",
  isometric_rts: "rts-oblique"
};
function resolveAnchorGameView(gameView) {
  let resolved = (gameView || "platformer").trim().toLowerCase();
  resolved = VIEW_ALIASES[resolved] ?? resolved;
  if (!(resolved in ANCHOR_GAME_VIEWS)) {
    const known = Object.keys(ANCHOR_GAME_VIEWS).sort().join(", ");
    throw new Error(`unknown anchor game view '${gameView}'; expected one of: ${known}`);
  }
  return resolved;
}
function resolveAnchorRole(anchorRole) {
  const resolved = (anchorRole || "character").trim().toLowerCase();
  if (!(resolved in ANCHOR_ROLES)) {
    const known = Object.keys(ANCHOR_ROLES).sort().join(", ");
    throw new Error(`unknown anchor role '${anchorRole}'; expected one of: ${known}`);
  }
  return resolved;
}
var ACTION_IDS = [
  "idle",
  "hurt",
  "jump",
  "crouch",
  "attack",
  "death",
  "walk",
  "run",
  "roll",
  "dash",
  "talk",
  "interact",
  "pick_up",
  "use",
  "examine",
  "give",
  "shrug",
  "walk_forward",
  "walk_backward",
  "block_high",
  "block_low",
  "knockdown",
  "get_up",
  "light_attack",
  "heavy_attack"
];
function getActionId(actionId) {
  const resolved = (actionId || "").trim().toLowerCase();
  if (!resolved) throw new Error("an action id is required (e.g. walk, run, attack)");
  return resolved;
}
function styleBlock(style) {
  if (style === null || style === void 0) return "";
  if (style === "lobit-v1") {
    return `
Style constraints (low-bit pixel-sprite production art):
- Deliberately simple low-bit pixel-sprite production art.
- Limited 8 to 12 color feeling.
- Big readable pixel clusters and clean stepped edges.
- Compact silhouettes that remain readable inside 256x256 runtime cells.
- Broad identity preservation only, with tiny details collapsed into a few big visual cues.
- No ornate trim, jewelry, stitching, buttons, buckles, texture noise, fabric weave, cloth-fold detail, or layered micro-props.
- Native snapped height should feel roughly 100-130px; do not produce overly tall or dense detail.
`;
  }
  if (style === "high-fidelity-v1") {
    return `
Style constraints (high-fidelity / mixel pixel-art):
- High-fidelity 2D pixel-art-inspired game sprite.
- Richer color ramps and texture are acceptable.
- Mixed pixels are acceptable at the target game resolution.
- Preserve more of the source identity and style than a low-bit treatment.
- Still keep one centered full-body/object subject on an exact flat chroma matte.
- No scenery, shadows, checkerboards, faux transparency, or cropped limbs.
`;
  }
  if (style === "preserve-reference-v1") {
    return `
Style constraints (source-faithful preservation):
- The source/reference image is strict visual authority, not just broad identity input.
- Do not redesign, mature, de-chibi, normalize, westernize, or reinterpret.
- Only adapt canvas, background, and facing as required.
- Pixel snapping and palette cleanup may happen later, but they must not imply an aesthetic redesign.
- Preserve chibi proportions, head/body ratio, silhouette, outfit, palette, line weight, rendering style, facial design, and shape language.
- Still keep one centered character/object on an exact flat chroma matte.
`;
  }
  throw new Error(
    `unknown style '${style}'; expected one of: lobit-v1, high-fidelity-v1, preserve-reference-v1`
  );
}
function withStyle(prompt, style) {
  const block = styleBlock(style);
  return block ? `${prompt}${block}` : prompt;
}
function chromaPhrase(chroma) {
  const names = {
    "#00FF00": "chroma green #00FF00",
    "#FF00FF": "chroma magenta #FF00FF",
    "#0000FF": "chroma blue #0000FF"
  };
  return names[chroma.toUpperCase()] ?? `chroma color ${chroma}`;
}
function directionLine(direction, gameView) {
  if (gameView === "adventure") {
    const lines = {
      s: "south / front-facing adventure standing view",
      se: "south-east / front-right three-quarter adventure view",
      sw: "south-west / front-left three-quarter adventure view",
      e: "east / screen-right adventure profile",
      w: "west / screen-left adventure profile",
      n: "north / back-facing adventure standing view",
      ne: "north-east / back-right three-quarter adventure view",
      nw: "north-west / back-left three-quarter adventure view"
    };
    return lines[direction.id] ?? direction.screenFacing;
  }
  if (gameView === "rts-oblique") {
    const lines = {
      n: "north / back-facing as a compact unit rotated on an oblique RTS ground plane",
      ne: "north-east / back-right-facing as a compact unit rotated on an oblique RTS ground plane",
      e: "east / screen-right-facing from the fixed elevated RTS camera, not a pure side profile",
      se: "south-east / front-right-facing as a compact unit rotated on an oblique RTS ground plane",
      s: "south / front-facing from the fixed elevated RTS camera, not a straight-on portrait",
      sw: "south-west / front-left-facing as a compact unit rotated on an oblique RTS ground plane",
      w: "west / screen-left-facing from the fixed elevated RTS camera, not a pure side profile",
      nw: "north-west / back-left-facing as a compact unit rotated on an oblique RTS ground plane"
    };
    return lines[direction.id] ?? direction.screenFacing;
  }
  return direction.screenFacing;
}
function anchorCompositionGuidance(gameView) {
  if (gameView === "adventure") {
    return `- One isolated full-height point-and-click adventure character centered on the canvas.
- Whole body visible from head to feet with a clear grounded standing silhouette.
- The visible character should occupy roughly 65-80% of the 1024 canvas height.
- Use generous empty chroma matte around the character on all sides.
- Feet should feel planted for click-to-walk navigation, but do not draw a floor, ellipse, or shadow.`;
  }
  if (gameView === "rts-oblique") {
    return `- One isolated small RTS unit sprite centered on the canvas.
- Whole unit visible, including head, weapon, hands, body, and feet, but not drawn as a tall full-height character turnaround.
- Compact squat footprint; the visible unit should occupy roughly 35-45% of the 1024 canvas height.
- Generous empty chroma matte around the unit on all sides.
- Feet planted on an implied RTS ground plane, but do not draw the ground plane.`;
  }
  return `- One isolated full-body sprite centered on the canvas.
- Full body visible from head to feet.`;
}
function anchorAvoidGuidance(gameView) {
  if (gameView === "adventure") {
    return `- not a side-view platformer profile unless direction is explicitly east or west
- not an overhead top-down unit
- not a squat RTS unit
- not a fighting-game combat stance
- not a portrait crop`;
  }
  if (gameView === "rts-oblique") {
    return `- not a tall full-height character turnaround
- not a side-view platformer sprite
- not a fighting-game character sprite
- not a portrait pose
- not a paper-doll front view
- not a large character illustration`;
  }
  return "";
}
function directionViewGuidance(direction, gameView) {
  if (gameView === "adventure") {
    if (direction.id === "sw" || direction.id === "se") {
      const side = direction.id === "sw" ? "screen-left" : "screen-right";
      return `- Use a classic point-and-click adventure character camera: orthographic or near-orthographic, slightly above eye level, full-body, grounded, and asset-focused.
- Make this a clean front three-quarter standing view angled toward ${side}.
- Keep enough face, chest, and body front visible for dialogue and object-interaction readability.
- Direction must be ${directionLine(direction, gameView)}.
- Do not make a true side-scrolling profile, overhead unit, RTS unit, fighting-game combat pose, or portrait.`;
    }
    return `- Use a classic point-and-click adventure character camera: orthographic or near-orthographic, slightly above eye level, full-body, grounded, and asset-focused.
- Direction must be ${directionLine(direction, gameView)}.
- Keep the pose neutral and suitable for click-to-walk navigation, dialogue, and object interaction.
- Do not make an overhead unit, squat RTS unit, fighting-game combat pose, or portrait.`;
  }
  if (gameView === "rts-oblique") {
    return `- Use an elevated oblique RTS camera, similar to Warcraft-like unit sprites, not a platformer, fighting-game, or strict tactics-isometric camera.
- The sprite should read as a small RTS unit standing on an implied RTS ground plane.
- Keep the camera above the unit enough that the top planes of the head, shoulders, armor, weapon, and boots are visible.
- Use foreshortened, compact, squat body proportions appropriate for an RTS unit; do not create a tall full-height character.
- Direction must be ${directionLine(direction, gameView)}.
- Keep feet planted on the implied RTS ground plane with clear ground contact.
- Do not make a pure side-view platformer profile, a straight-on front portrait, a paper-doll turnaround, or a large character illustration.`;
  }
  if (gameView === "isometric") {
    return `- Experimental true isometric / tactics-style camera. This path is less tested than platformer and rts-oblique.
- Aim for a diamond-tile tactics view with visible top planes and compact foreshortened proportions.
- Direction must be ${direction.screenFacing} from a consistent isometric tactics camera.
- Do not make a pure side-view platformer profile or a straight-on front portrait.`;
  }
  if (gameView === "platformer") {
    if (direction.id === "w") {
      return `- Make this a true side-view profile for a side-scrolling game, facing screen-left.
- Do not leave it front-facing or three-quarter-facing.
- Only the side of the head, side of the torso, and one side of the body should read clearly.`;
    }
    if (direction.id === "e") {
      return `- Make this a true side-view profile for a side-scrolling game, facing screen-right.
- Do not leave it front-facing or three-quarter-facing.
- Only the side of the head, side of the torso, and one side of the body should read clearly.`;
    }
    if (direction.id === "s") {
      return `- Make this a front-facing orthographic sprite view for a side-scroller turnaround.
- Do not make an overhead or top-down camera view.`;
    }
    if (direction.id === "n") {
      return `- Make this a back-facing orthographic sprite view for a side-scroller turnaround.
- Do not make an overhead or top-down camera view.`;
    }
  }
  if (gameView === "top-down") {
    return `- Experimental top-down or three-quarter top-down camera. This path is less tested than platformer.
- Make the facing readable for a top-down or three-quarter top-down game.
- Preserve the gameplay direction clearly without switching to a side-scroller profile unless the requested direction calls for profile readability.`;
  }
  return `- Make the requested direction readable as a neutral 2D game sprite view.
- Keep the camera orthographic and asset-focused.`;
}
function anchorRoleGuidance(anchorRole) {
  if (anchorRole === "enemy") {
    return `- Preserve the enemy's core body plan, threat shape, and readable attack silhouette.
- Do not turn it into a different creature type, vehicle, turret, quadruped, or humanoid unless image 1 already establishes that shape.`;
  }
  if (anchorRole === "turret") {
    return `- Preserve the planted base, barrel/muzzle orientation, and mechanical silhouette.
- Do not add legs, a humanoid body, a face, hands, or walking anatomy unless image 1 already has them.`;
  }
  if (anchorRole === "prop" || anchorRole === "object") {
    return `- Preserve the object's simple physical form and readable silhouette.
- Do not anthropomorphize it, add a face, add limbs, or turn it into a character.`;
  }
  return `- Preserve the character's body plan, outfit blocks, readable pose language, and silhouette.
- Do not add or remove major anatomy.`;
}
function anchorContextGuidance(anchorContext) {
  const context = (anchorContext || "").trim();
  return context ? `Additional game context: ${context}` : "Additional game context: none supplied.";
}
function renderAnchorPrompt(direction, options = {}) {
  const { gameView = "platformer", anchorRole = "character", anchorContext = null } = options;
  const resolvedView = resolveAnchorGameView(gameView);
  const resolvedRole = resolveAnchorRole(anchorRole);
  return `Intended use: a reusable single-frame directional anchor sprite for a 2D game asset pipeline.

Game view: ${ANCHOR_GAME_VIEWS[resolvedView]}.
Asset role: ${ANCHOR_ROLES[resolvedRole]}.
${anchorContextGuidance(anchorContext)}

Image 1 role: identity anchor. Preserve the exact approved asset identity, silhouette, proportions, palette blocks, and pixel-art readability from this reference image.
Image 2 role: pixel-style guide. Use this only to reinforce the crisp pixelated treatment, chunky pixel texture, square canvas discipline, and sprite readability. Do not copy guide pixels, checker patterns, borders, labels, or layout marks into the output.

Primary request: generate a single-frame ${direction.promptName} anchor sprite.

Subject:
- Same game asset as image 1.
- Direction: ${directionLine(direction, resolvedView)}.
- Keep this as the same asset, not a redesign.
${directionViewGuidance(direction, resolvedView)}
${anchorRoleGuidance(resolvedRole)}
- Preserve a weapon, tool, barrel, arm, claw, base, or other functional part only if it is clearly part of image 1.
- Do not invent new equipment, limbs, weapons, wheels, legs, scenery, or effects.

Look and rendering:
- Pixelated game-sprite art with crisp chunky edges.
- Preserve the visual family of image 1.
- No painterly shading, no blur, no soft gradients.

Background and composition:
- 1024x1024 square canvas.
${anchorCompositionGuidance(resolvedView)}
- Use an opaque exact flat chroma green background: #00FF00.
- No gradients, texture, anti-aliased haze, lighting effects, checkerboards, faux transparency, or background shadows.
- No cast shadow, ground shadow, contact shadow, glow, particles, or effects touching the background.
- No scenery, UI, labels, text, props, borders, shadows, or extra characters.
- Do not create an animation sheet; deliver one anchor pose only.

Avoid:
- realism
- redesigns
- costume changes
- body-plan changes
- tiny framing
- cropped feet or cropped hair
- floor shadows or environment backdrops
- non-green backgrounds
${anchorAvoidGuidance(resolvedView)}
`;
}
var POSE_BOARD_PRESETS = {
  standard: { id: "standard", width: 1536, height: 1152, columns: 4, rows: 3 },
  hires: { id: "hires", width: 2048, height: 1536, columns: 4, rows: 3 }
};
var cellWidth = (p) => Math.floor(p.width / p.columns);
var cellHeight = (p) => Math.floor(p.height / p.rows);
var totalCells = (p) => p.columns * p.rows;
function resolvePoseBoardPreset(presetId) {
  const resolved = presetId || "standard";
  const preset = POSE_BOARD_PRESETS[resolved];
  if (!preset) {
    const known = Object.keys(POSE_BOARD_PRESETS).sort().join(", ");
    throw new Error(`unknown pose board preset '${resolved}'; expected one of: ${known}`);
  }
  if (preset.width % preset.columns || preset.height % preset.rows) {
    throw new Error(`pose board preset '${preset.id}' does not divide evenly into its grid`);
  }
  return preset;
}
function labelForIndex(labels, index, frameCount) {
  if (frameCount <= 1) return labels[0];
  if (frameCount === labels.length) return labels[index - 1];
  return labels[roundHalfToEven((index - 1) * (labels.length - 1) / (frameCount - 1))];
}
var LABELS = {
  idle: [
    "settled idle",
    "tiny breathing rise",
    "breathing rise",
    "breathing peak",
    "soft blink or cloth sway",
    "small breathing fall",
    "settling fall",
    "near neutral",
    "return to settled idle",
    "loop hold matching frame 1"
  ],
  hurt: [
    "idle start",
    "impact anticipation",
    "impact recoil",
    "hit peak",
    "recover balance",
    "return to guard"
  ],
  jump: [
    "ready stance",
    "crouch anticipation",
    "takeoff",
    "airborne peak",
    "falling",
    "landing recovery"
  ],
  crouch: [
    "upright ready stance",
    "crouch anticipation",
    "lowering into crouch",
    "lowest crouched hold",
    "rising from crouch",
    "return to ready stance"
  ],
  death: [
    "idle start",
    "hit reaction",
    "stagger",
    "collapse start",
    "falling",
    "impact",
    "settle",
    "still pose",
    "final still",
    "final hold"
  ],
  // Spatial-progression labels (a single arc, not abstract beats) so the model
  // advances the weapon monotonically along one swing instead of drawing N poses.
  attack: [
    "ready stance, weapon held back",
    "anticipation, weapon drawing back and up",
    "wind-up peak, weapon at the top of the back-swing",
    "swing begins, weapon starting forward along the strike arc",
    "mid-strike, weapon sweeping across the body centerline",
    "contact, weapon at the far forward end of the arc",
    "follow-through, weapon overshooting past contact",
    "recovery, weapon returning toward the ready guard",
    "settle toward ready",
    "return to ready stance"
  ],
  talk: [
    "settled speaking idle",
    "small head turn",
    "hand gesture begins",
    "gesture opens",
    "gesture peak",
    "soft emphasis",
    "gesture relaxes",
    "hand returns",
    "near speaking idle",
    "loop hold matching frame 1"
  ],
  interact: [
    "idle start",
    "anticipate reach",
    "arm extends",
    "operate or take peak",
    "brief contact hold",
    "release",
    "arm returns",
    "settle",
    "return to idle",
    "idle hold"
  ],
  pick_up: [
    "idle start",
    "look toward target",
    "bend begins",
    "reach downward",
    "lowest reach",
    "grasp implied object",
    "lift begins",
    "rise with hand close",
    "settle upright",
    "return to idle",
    "idle hold",
    "loop-safe idle"
  ],
  use: [
    "idle start",
    "anticipate reach",
    "reach outward",
    "hand meets implied control",
    "operate peak",
    "brief hold",
    "release",
    "arm returns",
    "settle",
    "return to idle"
  ],
  examine: [
    "idle start",
    "attention shift",
    "lean begins",
    "peer forward",
    "examine peak",
    "thoughtful hold",
    "lean eases back",
    "head returns",
    "settle",
    "return to idle"
  ],
  give: [
    "idle start",
    "prepare item hand",
    "arm extends",
    "offering pose",
    "offer hold",
    "release or accept beat",
    "arm retracts",
    "hand returns",
    "settle",
    "return to idle"
  ],
  shrug: [
    "idle start",
    "confused anticipation",
    "shoulders lift",
    "palms open",
    "shrug peak",
    "head tilt hold",
    "shoulders relax",
    "hands lower",
    "settle",
    "return to idle"
  ]
};
function frameLabel(action2, index, frameCount) {
  if (action2 === "knockdown") return labelForIndex(LABELS.death, index, frameCount);
  if (action2 === "light_attack" || action2 === "heavy_attack") {
    return labelForIndex(LABELS.attack, index, frameCount);
  }
  const labels = LABELS[action2];
  if (labels) return labelForIndex(labels, index, frameCount);
  return `${action2} pose ${index}`;
}
var ADVENTURE_ACTIONS = /* @__PURE__ */ new Set([
  "talk",
  "interact",
  "pick_up",
  "use",
  "examine",
  "give",
  "shrug"
]);
function renderFrameGuidance(action2, frameCount, framePromptStyle) {
  if (framePromptStyle !== "specific" && framePromptStyle !== "loose") {
    throw new Error("frame_prompt_style must be specific or loose");
  }
  if (framePromptStyle === "specific") {
    return Array.from(
      { length: frameCount },
      (_, i) => `- Frame ${i + 1}: ${frameLabel(action2, i + 1, frameCount)}`
    ).join("\n");
  }
  if (action2 === "attack") {
    return `Motion guidance:
- Create ${frameCount} readable attack poses that feel like one coherent short game animation.
- Use a clear beginning, anticipation, active strike, follow-through, and recovery back toward the starting stance.
- Let the model choose the exact in-between poses; do not force a named pose into every frame.
- Keep the same attacking side, weapon hand, weapon silhouette, and facing direction across all frames.
- The first frame should read as ready/idle and the final frame should return toward that same ready stance for looping.`;
  }
  if (ADVENTURE_ACTIONS.has(action2)) {
    return `Motion guidance:
- Create ${frameCount} readable point-and-click adventure ${action2} poses that feel like one coherent character animation.
- Use clear beginning, anticipation, main gesture, follow-through, and recovery or loop poses as appropriate for the action.
- Keep the performance grounded and conversational, not combat-focused.
- Let the model choose exact in-betweens while preserving identity, scale, facing direction, and foot baseline.`;
  }
  return `Motion guidance:
- Create ${frameCount} readable ${action2} poses that feel like one coherent short game animation.
- Use clear beginning, middle, and end poses with smooth in-betweens.
- Let the model choose the exact in-between poses; do not force a named pose into every frame.
- Keep identity, scale, facing direction, and foot baseline consistent across all frames.`;
}
var LOOPING_ACTIONS = /* @__PURE__ */ new Set(["idle", "run", "walk", "walk_forward", "walk_backward", "talk"]);
function motionContinuityBlock(actionId, frameCount) {
  const ending = LOOPING_ACTIONS.has(actionId) ? `Frame ${frameCount} returns toward frame 1 so the cycle loops seamlessly.` : `Frame 1 is the start of the motion and frame ${frameCount} is its end.`;
  return `
Critical \u2014 read the used cells in order (left to right, top to bottom) as ONE continuous ${actionId} motion sampled as ${frameCount} consecutive film frames, not ${frameCount} separate poses. Each cell is the very next instant in time, a small even step after the one before it. Between adjacent frames the pose changes only a little: the same limbs, body, held items, and cloth travel a bit further along the SAME single path, weight shifts gradually, and feet plant or lift in sequence. Flipping through the cells in order must look like smooth, continuous movement with no sudden jumps or unrelated poses. Do not draw ${frameCount} different dramatic poses; draw the SAME motion decomposed into ${frameCount} evenly spaced in-between frames. ${ending}
`;
}
function poseBoardFacingLock(direction) {
  let base = `Facing lock: every single cell must keep the SAME facing \u2014 ${direction.screenFacing}. Never mirror, flip, rotate, or reverse the body to face the other way in any frame, including the first and last. A wind-up, recoil, reach, or step that moves backward keeps this same facing; do not turn the character around.`;
  if (direction.id === "e" || direction.id === "w") {
    const side = direction.id === "e" ? "screen-right" : "screen-left";
    base += ` Hold a consistent side profile facing ${side} in every frame: do not present a mirrored profile, a front view, or a back view in any cell.`;
  }
  return base;
}
function renderPoseBoardPrompt(actionId, direction, frameCount, options = {}) {
  const { poseBoard = null, framePromptStyle = "specific", chroma = "#00FF00" } = options;
  const board = poseBoard ?? resolvePoseBoardPreset("standard");
  const phrase = chromaPhrase(chroma);
  const frameLines = renderFrameGuidance(actionId, frameCount, framePromptStyle);
  return `Intended use: a reusable ${actionId} animation spritesheet for a 2D game.

Image 1 role: identity anchor. Preserve the exact approved anchor sprite identity.
Image 2 role: black-and-white alternating-pixel pose-board geometry guide at the exact target size. Use it only to preserve the output aspect ratio, full-board composition, pixel texture, and implied ${board.columns} column x ${board.rows} row pose-board layout. It is not a background, style, contact-sheet, border, or grid-line reference. Do not copy its black pixels, white pixels, checker pattern, grid lines, borders, labels, or presentation-sheet look into the final output.

Subject:
- Same already-approved sprite character.
- Direction: ${direction.screenFacing}.
- ${poseBoardFacingLock(direction)}
- Keep this as the same character, not a redesign.

Primary request: create a ${frameCount}-frame ${actionId} sequence on a ${board.width}x${board.height} pose board. Place the animation frames in the first ${frameCount} cells of an implied ${board.columns} column x ${board.rows} row grid, reading left to right, top to bottom.
${frameLines}
${motionContinuityBlock(actionId, frameCount)}
Look and rendering:
- High-resolution pixelated sprite art.
- Crisp chunky sprite edges.
- Preserve visible pixel structure.
- No painterly rendering, no airbrushing, no soft gradients.
- Keep the sprite large and centered in each frame area.

Composition and background constraints:
- Use the full canvas as a model-friendly pose board, not a packed runtime spritesheet.
- The visible output must be only separate character sprites on one uninterrupted solid chroma background.
- Do not render a contact sheet, proof sheet, storyboard page, panel layout, framed sheet, margin, border, white page, gray page, checkerboard, or visible guide.
- Exact canvas size: ${board.width}x${board.height}.
- Exact implied grid: ${board.columns} columns x ${board.rows} rows, ${totalCells(board)} cells total.
- Each implied generation cell is ${cellWidth(board)}x${cellHeight(board)} pixels.
- Each used cell contains one centered 256x256 runtime safe area.
- Put frames 1 through ${frameCount} in cells 1 through ${frameCount}, reading left to right, top to bottom.
- Cells after frame ${frameCount} must remain entirely flat ${chroma} with no character, marks, shadows, labels, or texture.
- Exactly one character figure per used frame cell.
- Keep every full-body figure entirely inside the canvas and entirely inside its own implied frame area.
- Leave clear empty ${phrase} margin around the left edge, right edge, top, bottom, and between neighboring figures.
- The first and last figures must not touch or crop against the canvas edge.
- Scale lock: the character must be the EXACT same size in every cell \u2014 same height, same body proportions, same distance from one fixed imaginary camera, as if filmed without zooming in or out. Changing pose is fine; changing the character's scale is not. Do not draw any frame noticeably larger or smaller than the others.
- Anchor every figure to the same foot baseline: feet rest on the same horizontal line across all cells, so the character does not float, sink, or drift up and down between frames.
- Center each character inside the 256x256 safe area of its implied ${cellWidth(board)}x${cellHeight(board)} cell.
- Keep the figures separated and fully readable.
- No overlapping between frame areas.
- Use an opaque exact flat ${phrase} background.
- Every non-character pixel must be exact solid ${chroma}, including the outer edges, gutters between sprites, and unused cells.
- No white, gray, black, neutral, paper, studio, transparent, or checkerboard background.
- No gradients, texture, anti-aliased haze, lighting effects, checkerboards, or faux transparency on the background.
- No cast shadow, ground shadow, contact shadow, glow, particles, or effects touching the background.
- No matte-color spill on the character.
- Keep effects compact and away from frame edges.
- Do not add scenery, props, text, UI, labels, frame numbers, guide marks, grid lines, cell outlines, borders, decorative effects, or extra characters.

Avoid:
- redesigning the character
- changing costume colors
- making the sprite tiny
- faux transparency patterns
- floor shadows or environment backdrops
- non-chroma backgrounds
`;
}

// src/sprite/pack.ts
import { basename as basename3 } from "node:path";
function packSpritesheet(inputDir, out, options = {}) {
  const { glob = "frame-*.png", columns = null, fps = 10, action: action2 = "anim" } = options;
  const frames = loadFrames(inputDir, glob);
  const sizes = new Set(frames.map((f) => `${f.image.width}x${f.image.height}`));
  if (sizes.size !== 1) {
    throw new Error(
      `frames are not a uniform size (${[...sizes].sort().join(", ")}); normalize them first (run \`vg sprite normalize-canvas\`).`
    );
  }
  const frameWidth = frames[0].image.width;
  const frameHeight = frames[0].image.height;
  const count = frames.length;
  const cols = columns === null || columns === 0 ? count : Math.min(columns, count);
  const rows = Math.ceil(count / cols);
  const sheet = Bitmap.create(cols * frameWidth, rows * frameHeight);
  frames.forEach((frame, i) => {
    const row = Math.floor(i / cols);
    const col = i - row * cols;
    sheet.paste(frame.image, col * frameWidth, row * frameHeight);
  });
  return {
    sheet,
    manifest: {
      image: basename3(out),
      frameWidth,
      frameHeight,
      columns: cols,
      rows,
      frameCount: count,
      fps,
      animations: { [action2]: { fps, frames: Array.from({ length: count }, (_, i) => i) } }
    }
  };
}

// src/skill/frontmatter.ts
var FrontmatterError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "FrontmatterError";
  }
};
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}
function parseScalar(raw) {
  const text = raw.trim();
  if (text === "") return "";
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2 || text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    const body = text.slice(1, -1);
    return text[0] === '"' ? body.replaceAll(String.raw`\"`, '"').replaceAll("\\n", "\n") : body;
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item));
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}
function parseFrontmatter(text) {
  const out = {};
  let currentKey = null;
  let nested = null;
  for (const rawLine of text.split("\n")) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    if (indented) {
      if (!nested || currentKey === null) {
        throw new FrontmatterError(`unexpected indented line: ${rawLine.trim()}`);
      }
      const match2 = /^\s+([^:]+):\s*(.*)$/.exec(line);
      if (!match2) throw new FrontmatterError(`could not parse nested line: ${rawLine.trim()}`);
      nested[match2[1].trim()] = parseScalar(match2[2]);
      continue;
    }
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) throw new FrontmatterError(`could not parse line: ${rawLine.trim()}`);
    const key = match[1].trim();
    const value = match[2];
    if (value.trim() === "") {
      currentKey = key;
      nested = {};
      out[key] = nested;
    } else {
      currentKey = null;
      nested = null;
      out[key] = parseScalar(value);
    }
  }
  return out;
}
function splitSkill(content) {
  if (!content.startsWith("---")) return null;
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return null;
  const frontmatterText = match[1];
  return {
    frontmatterText,
    frontmatter: parseFrontmatter(frontmatterText),
    body: content.slice(match[0].length).replace(/^\n/, "")
  };
}

// src/skill/analyze.ts
function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}
function keywordsFound(bodyLower, keywords) {
  return keywords.filter((keyword) => bodyLower.includes(keyword));
}
function checkPhilosophy(body) {
  let score = 0;
  const feedback = [];
  const found = keywordsFound(body.toLowerCase(), [
    "philosophy",
    "approach",
    "principle",
    "mental model",
    "framework",
    "thinking",
    "mindset",
    "why",
    "consider",
    "understand"
  ]);
  if (found.length >= 3) {
    score += 30;
    feedback.push(`\u2705 Philosophy indicators found: ${found.slice(0, 5).join(", ")}`);
  } else if (found.length >= 1) {
    score += 15;
    feedback.push(`\u26A0\uFE0F  Some philosophy indicators found: ${found.join(", ")}`);
  } else {
    feedback.push("\u274C No clear philosophical foundation detected");
  }
  const questions = countMatches(body, /\?[^\n]*/g);
  if (questions >= 3) {
    score += 10;
    feedback.push(`\u2705 Contains ${questions} guiding questions`);
  } else if (questions >= 1) {
    score += 5;
    feedback.push(`\u26A0\uFE0F  Contains ${questions} guiding question(s)`);
  }
  return { category: "Philosophy", score, feedback };
}
function checkAntiPatterns(body) {
  let score = 0;
  const feedback = [];
  const found = keywordsFound(body.toLowerCase(), [
    "avoid",
    "never",
    "don't",
    "do not",
    "anti-pattern",
    "mistake",
    "common pitfall",
    "warning",
    "incorrect",
    "wrong way"
  ]);
  if (found.length >= 5) {
    score += 25;
    feedback.push(`\u2705 Strong anti-pattern guidance: ${found.slice(0, 5).join(", ")}`);
  } else if (found.length >= 2) {
    score += 12;
    feedback.push(`\u26A0\uFE0F  Some anti-pattern guidance: ${found.join(", ")}`);
  } else {
    feedback.push("\u274C No explicit anti-pattern warnings");
  }
  const strong = countMatches(body, /\b(NEVER|DO NOT|DON'T)\b/g);
  if (strong > 0) {
    score += 10;
    feedback.push(`\u2705 Contains ${strong} strong warning(s)`);
  }
  return { category: "Anti-Patterns", score, feedback };
}
function checkVariation(body) {
  let score = 0;
  const feedback = [];
  const bodyLower = body.toLowerCase();
  const found = keywordsFound(bodyLower, [
    "vary",
    "variation",
    "different",
    "diverse",
    "context-specific",
    "adapt",
    "customize",
    "unique",
    "avoid repetition",
    "not the same"
  ]);
  if (found.length >= 3) {
    score += 20;
    feedback.push(`\u2705 Variation encouraged: ${found.slice(0, 5).join(", ")}`);
  } else if (found.length >= 1) {
    score += 10;
    feedback.push(`\u26A0\uFE0F  Some variation mentioned: ${found.join(", ")}`);
  } else {
    feedback.push("\u274C No explicit variation encouragement");
  }
  const templateWarnings = countMatches(
    bodyLower,
    /(template|repetitive|generic|cookie-cutter|converge)/g
  );
  if (templateWarnings > 0) {
    score += 10;
    feedback.push(`\u2705 Warns against generic patterns (${templateWarnings} mentions)`);
  }
  return { category: "Variation", score, feedback };
}
function checkOrganization(body) {
  let score = 0;
  const feedback = [];
  const headers = countMatches(body, /^#+\s+(.+)$/gm);
  if (headers >= 5) {
    score += 10;
    feedback.push(`\u2705 Well-structured with ${headers} sections`);
  } else if (headers >= 2) {
    score += 5;
    feedback.push(`\u26A0\uFE0F  Has ${headers} sections`);
  } else {
    feedback.push("\u274C Lacks clear organization");
  }
  const lists = countMatches(body, /^\s*[-*]\s+/gm);
  if (lists >= 10) {
    score += 5;
    feedback.push(`\u2705 Contains ${lists} list items (actionable)`);
  }
  return { category: "Organization", score, feedback };
}
function checkEmpowerment(body) {
  let score = 0;
  const feedback = [];
  const bodyLower = body.toLowerCase();
  const found = keywordsFound(bodyLower, [
    "extraordinary",
    "capable",
    "unlock",
    "enable",
    "empower",
    "creative",
    "innovative",
    "push boundaries",
    "explore"
  ]);
  if (found.length >= 3) {
    score += 10;
    feedback.push(`\u2705 Empowering tone: ${found.join(", ")}`);
  } else if (found.length >= 1) {
    score += 5;
    feedback.push(`\u26A0\uFE0F  Some empowering language: ${found.join(", ")}`);
  }
  const constraints = keywordsFound(bodyLower, ["must", "always", "required", "mandatory"]);
  if (constraints.length > 20) {
    score -= 5;
    feedback.push(`\u26A0\uFE0F  Many rigid constraints (${constraints.length} instances)`);
  }
  return { category: "Empowerment", score, feedback };
}
function analyzeSkillBody(frontmatter, body) {
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  const categories = [
    description.length > 50 ? { category: "Description", score: 5, feedback: ["\u2705 Comprehensive description"] } : { category: "Description", score: 0, feedback: ["\u274C Description too brief"] },
    checkPhilosophy(body),
    checkAntiPatterns(body),
    checkVariation(body),
    checkOrganization(body),
    checkEmpowerment(body)
  ];
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : "unknown",
    totalScore: categories.reduce((sum, c) => sum + c.score, 0),
    categories
  };
}

// src/skill/upgrade.ts
function generateSuggestions(frontmatter, body) {
  const suggestions = [];
  const bodyLower = body.toLowerCase();
  if (!bodyLower.includes("philosophy") && !bodyLower.includes("principle")) {
    suggestions.push({
      category: "Philosophy",
      priority: "HIGH",
      suggestion: "Add a philosophy or principles section",
      example: `## Core Philosophy

Before diving into procedures, understand the fundamental approach:
- What is the underlying philosophy guiding this domain?
- What questions should be asked before taking action?
- What mental model helps make better decisions?`
    });
  }
  if (!bodyLower.includes("anti-pattern") && !bodyLower.slice(0, 500).includes("avoid")) {
    suggestions.push({
      category: "Anti-Patterns",
      priority: "HIGH",
      suggestion: 'Add anti-patterns or "what to avoid" section',
      example: `## Anti-Patterns to Avoid

Common mistakes when [doing this task]:
- \u274C **Template trap**: Using rigid templates that constrain creativity
- \u274C **Context blindness**: Applying same approach regardless of situation
- \u274C **Over-specification**: Adding unnecessary constraints`
    });
  }
  if (!bodyLower.includes("vary") && !bodyLower.includes("different")) {
    suggestions.push({
      category: "Variation",
      priority: "MEDIUM",
      suggestion: "Add explicit variation encouragement",
      example: `## Encouraging Variation

**IMPORTANT**: Outputs should vary based on context. Avoid converging on "favorite" patterns:
- Adapt to the specific use case
- Consider different approaches for different scenarios
- No two outputs should be identical unless requirements are identical`
    });
  }
  if (!bodyLower.includes("extraordinary") && !bodyLower.includes("capable")) {
    suggestions.push({
      category: "Empowerment",
      priority: "LOW",
      suggestion: "Add empowering conclusion",
      example: `## Remember

Claude is capable of extraordinary work in this domain. These guidelines unlock that potential\u2014they don't constrain it. Use judgment, adapt to context, and push boundaries when appropriate.`
    });
  }
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  if (description.length < 100) {
    suggestions.push({
      category: "Description",
      priority: "HIGH",
      suggestion: "Expand the description field in frontmatter",
      example: `Current: ${description}

Suggested: Add more detail about when to use this skill, what triggers it, and what tasks it helps with. Aim for 100-200 characters with specific use cases.`
    });
  }
  const sectionCount = body.split("\n##").length - 1;
  if (sectionCount < 3) {
    suggestions.push({
      category: "Organization",
      priority: "MEDIUM",
      suggestion: "Add more section headers for better organization",
      example: `Organize the skill into clear sections:
## Philosophy/Principles
## Core Guidelines
## Anti-Patterns
## Examples (optional)
## Advanced Topics (optional)`
    });
  }
  return suggestions;
}

// src/skill/init.ts
import { chmodSync, existsSync as existsSync6, mkdirSync as mkdirSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join4, resolve as resolve5 } from "node:path";

// src/skill/templates.ts
var SKILL_TEMPLATE = (skillName, skillTitle) => `---
name: ${skillName}
description: "TODO: Complete and informative explanation of what the skill does and when to use it. Include WHEN to use this skill - specific scenarios, file types, or tasks that trigger it."
---

# ${skillTitle}

## Overview

[TODO: 1-2 sentences explaining what this skill enables]

## Structuring This Skill

[TODO: Choose the structure that best fits this skill's purpose. Common patterns:

**1. Workflow-Based** (best for sequential processes)
- Works well when there are clear step-by-step procedures
- Example: DOCX skill with "Workflow Decision Tree" \u2192 "Reading" \u2192 "Creating" \u2192 "Editing"
- Structure: ## Overview \u2192 ## Workflow Decision Tree \u2192 ## Step 1 \u2192 ## Step 2...

**2. Task-Based** (best for tool collections)
- Works well when the skill offers different operations/capabilities
- Example: PDF skill with "Quick Start" \u2192 "Merge PDFs" \u2192 "Split PDFs" \u2192 "Extract Text"
- Structure: ## Overview \u2192 ## Quick Start \u2192 ## Task Category 1 \u2192 ## Task Category 2...

**3. Reference/Guidelines** (best for standards or specifications)
- Works well for brand guidelines, coding standards, or requirements
- Example: Brand styling with "Brand Guidelines" \u2192 "Colors" \u2192 "Typography" \u2192 "Features"
- Structure: ## Overview \u2192 ## Guidelines \u2192 ## Specifications \u2192 ## Usage...

**4. Capabilities-Based** (best for integrated systems)
- Works well when the skill provides multiple interrelated features
- Example: Product Management with "Core Capabilities" \u2192 numbered capability list
- Structure: ## Overview \u2192 ## Core Capabilities \u2192 ### 1. Feature \u2192 ### 2. Feature...

Patterns can be mixed and matched as needed. Most skills combine patterns (e.g., start with task-based, add workflow for complex operations).

Delete this entire "Structuring This Skill" section when done - it's just guidance.]

## [TODO: Replace with the first main section based on chosen structure]

[TODO: Add content here. See examples in existing skills:
- Code samples for technical skills
- Decision trees for complex workflows
- Concrete examples with realistic user requests
- References to scripts/templates/references as needed]

## Resources

This skill includes example resource directories that demonstrate how to organize different types of bundled resources:

### scripts/
Executable code (Python/Bash/etc.) that can be run directly to perform specific operations.

**Examples from other skills:**
- PDF skill: \`fill_fillable_fields.py\`, \`extract_form_field_info.py\` - utilities for PDF manipulation
- DOCX skill: \`document.py\`, \`utilities.py\` - Python modules for document processing

**Appropriate for:** Python scripts, shell scripts, or any executable code that performs automation, data processing, or specific operations.

**Note:** Scripts may be executed without loading into context, but can still be read by Claude for patching or environment adjustments.

### references/
Documentation and reference material intended to be loaded into context to inform Claude's process and thinking.

**Examples from other skills:**
- Product management: \`communication.md\`, \`context_building.md\` - detailed workflow guides
- BigQuery: API reference documentation and query examples
- Finance: Schema documentation, company policies

**Appropriate for:** In-depth documentation, API references, database schemas, comprehensive guides, or any detailed information that Claude should reference while working.

### assets/
Files not intended to be loaded into context, but rather used within the output Claude produces.

**Examples from other skills:**
- Brand styling: PowerPoint template files (.pptx), logo files
- Frontend builder: HTML/React boilerplate project directories
- Typography: Font files (.ttf, .woff2)

**Appropriate for:** Templates, boilerplate code, document templates, images, icons, fonts, or any files meant to be copied or used in the final output.

---

**Any unneeded directories can be deleted.** Not every skill requires all three types of resources.
`;
var EXAMPLE_REFERENCE = (skillTitle) => `# Reference Documentation for ${skillTitle}

This is a placeholder for detailed reference documentation.
Replace with actual reference content or delete if not needed.

Example real reference docs from other skills:
- product-management/references/communication.md - Comprehensive guide for status updates
- product-management/references/context_building.md - Deep-dive on gathering context
- bigquery/references/ - API references and query examples

## When Reference Docs Are Useful

Reference docs are ideal for:
- Comprehensive API documentation
- Detailed workflow guides
- Complex multi-step processes
- Information too lengthy for main SKILL.md
- Content that's only needed for specific use cases

## Structure Suggestions

### API Reference Example
- Overview
- Authentication
- Endpoints with examples
- Error codes
- Rate limits

### Workflow Guide Example
- Prerequisites
- Step-by-step instructions
- Common patterns
- Troubleshooting
- Best practices
`;
var EXAMPLE_ASSET = `# Example Asset File

This placeholder represents where asset files would be stored.
Replace with actual asset files (templates, images, fonts, etc.) or delete if not needed.

Asset files are NOT intended to be loaded into context, but rather used within
the output Claude produces.

Example asset files from other skills:
- Brand guidelines: logo.png, slides_template.pptx
- Frontend builder: hello-world/ directory with HTML/React boilerplate
- Typography: custom-font.ttf, font-family.woff2
- Data: sample_data.csv, test_dataset.json

## Common Asset Types

- Templates: .pptx, .docx, boilerplate directories
- Images: .png, .jpg, .svg, .gif
- Fonts: .ttf, .otf, .woff, .woff2
- Boilerplate code: Project directories, starter files
- Icons: .ico, .svg
- Data files: .csv, .json, .xml, .yaml

Note: This is a text placeholder. Actual assets can be any file type.
`;
var EXAMPLE_SCRIPT = (skillName) => `#!/usr/bin/env node
/**
 * Example helper script for ${skillName}
 *
 * This is a placeholder script that can be executed directly.
 * Replace with actual implementation or delete if not needed.
 *
 * Example real scripts from other skills:
 * - asset-pipeline/scripts/asset_sheet_probe.mjs - Reports non-empty sprite frames
 * - pixel-snapper/scripts/pixel_snapper.mjs - Recovers a native pixel grid
 */

function main() {
  console.log("This is an example script for the ${skillName} skill");
  console.log("Replace this with actual functionality or delete this file");
}

main();
`;

// src/skill/init.ts
function titleCaseSkillName(skillName) {
  return skillName.split("-").map((word) => word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word).join(" ");
}
function initSkill(skillName, path, log) {
  const skillDir = join4(resolve5(path), skillName);
  if (existsSync6(skillDir)) {
    log(`\u274C Error: Skill directory already exists: ${skillDir}`);
    return null;
  }
  const created = [];
  try {
    mkdirSync3(skillDir, { recursive: true });
    log(`\u2705 Created skill directory: ${skillDir}`);
  } catch (error) {
    log(`\u274C Error creating directory: ${error instanceof Error ? error.message : error}`);
    return null;
  }
  const skillTitle = titleCaseSkillName(skillName);
  try {
    writeFileSync3(join4(skillDir, "SKILL.md"), SKILL_TEMPLATE(skillName, skillTitle));
    log("\u2705 Created SKILL.md");
    created.push("SKILL.md");
  } catch (error) {
    log(`\u274C Error creating SKILL.md: ${error instanceof Error ? error.message : error}`);
    return null;
  }
  try {
    const scriptsDir = join4(skillDir, "scripts");
    mkdirSync3(scriptsDir, { recursive: true });
    const scriptPath = join4(scriptsDir, "example.mjs");
    writeFileSync3(scriptPath, EXAMPLE_SCRIPT(skillName));
    chmodSync(scriptPath, 493);
    log("\u2705 Created scripts/example.mjs");
    created.push("scripts/example.mjs");
    const referencesDir = join4(skillDir, "references");
    mkdirSync3(referencesDir, { recursive: true });
    writeFileSync3(join4(referencesDir, "api_reference.md"), EXAMPLE_REFERENCE(skillTitle));
    log("\u2705 Created references/api_reference.md");
    created.push("references/api_reference.md");
    const assetsDir = join4(skillDir, "assets");
    mkdirSync3(assetsDir, { recursive: true });
    writeFileSync3(join4(assetsDir, "example_asset.txt"), EXAMPLE_ASSET);
    log("\u2705 Created assets/example_asset.txt");
    created.push("assets/example_asset.txt");
  } catch (error) {
    log(
      `\u274C Error creating resource directories: ${error instanceof Error ? error.message : error}`
    );
    return null;
  }
  return { dir: skillDir, created };
}

// src/skill/normalize-factory.ts
var MARKER = "// @ts-nocheck";
var HEADER = `${MARKER}
// GENERATED by img2threejs, normalized by plugins/asset-pipeline/skills/image-to-threejs.
// Do not edit: re-run the generator, then normalize_factory.mjs. Consume it only
// through its exported factory functions, which are typed at the call site.
`;
function dropUserDataAssignment(source, prop) {
  const marker = `.userData.${prop} = `;
  const out = [];
  let cursor = 0;
  for (; ; ) {
    const hit = source.indexOf(marker, cursor);
    if (hit === -1) break;
    const lineStart = source.lastIndexOf("\n", hit) + 1;
    const lineEnd = source.indexOf("\n", hit);
    if (lineEnd === -1) break;
    out.push(source.slice(cursor, lineStart));
    cursor = lineEnd + 1;
  }
  out.push(source.slice(cursor));
  return out.join("");
}
function normalizeFactory(source, keepActionProfile = false) {
  let out = dropUserDataAssignment(source, "sculptComponent");
  if (!keepActionProfile) out = dropUserDataAssignment(out, "actionProfile");
  return out.startsWith(MARKER) ? out : HEADER + out;
}

// src/skill/validate.ts
import { existsSync as existsSync7, readFileSync as readFileSync5 } from "node:fs";
import { join as join5 } from "node:path";
var ALLOWED_PROPERTIES = ["name", "description", "license", "allowed-tools", "metadata"];
function validateSkill(skillPath) {
  const skillMd = join5(skillPath, "SKILL.md");
  if (!existsSync7(skillMd)) return { valid: false, message: "SKILL.md not found" };
  const content = readFileSync5(skillMd, "utf8");
  if (!content.startsWith("---")) {
    return { valid: false, message: "No YAML frontmatter found" };
  }
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return { valid: false, message: "Invalid frontmatter format" };
  const frontmatterText = match[1];
  if (/^description:\s*[>|]-?\s*$/m.test(frontmatterText)) {
    return {
      valid: false,
      message: "Description must use an inline string value, not YAML folded/literal scalar (`>` or `|`)."
    };
  }
  let frontmatter;
  try {
    frontmatter = parseFrontmatter(frontmatterText);
  } catch (error) {
    const detail = error instanceof FrontmatterError ? error.message : String(error);
    return { valid: false, message: `Invalid YAML in frontmatter: ${detail}` };
  }
  const unexpected = Object.keys(frontmatter).filter((key) => !ALLOWED_PROPERTIES.includes(key)).sort();
  if (unexpected.length > 0) {
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.join(", ")}. Allowed properties are: ${[...ALLOWED_PROPERTIES].sort().join(", ")}`
    };
  }
  if (!("name" in frontmatter)) return { valid: false, message: "Missing 'name' in frontmatter" };
  if (!("description" in frontmatter)) {
    return { valid: false, message: "Missing 'description' in frontmatter" };
  }
  const rawName = frontmatter.name;
  if (typeof rawName !== "string") {
    return { valid: false, message: `Name must be a string, got ${typeName(rawName)}` };
  }
  const name = rawName.trim();
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      return {
        valid: false,
        message: `Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)`
      };
    }
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
      return {
        valid: false,
        message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`
      };
    }
    if (name.length > 64) {
      return {
        valid: false,
        message: `Name is too long (${name.length} characters). Maximum is 64 characters.`
      };
    }
  }
  const rawDescription = frontmatter.description;
  if (typeof rawDescription !== "string") {
    return {
      valid: false,
      message: `Description must be a string, got ${typeName(rawDescription)}`
    };
  }
  const description = rawDescription.trim();
  if (description) {
    if (description.includes("<") || description.includes(">")) {
      return { valid: false, message: "Description cannot contain angle brackets (< or >)" };
    }
    if (description.length > 1024) {
      return {
        valid: false,
        message: `Description is too long (${description.length} characters). Maximum is 1024 characters.`
      };
    }
  }
  return { valid: true, message: "Skill is valid!" };
}
function typeName(value) {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  switch (typeof value) {
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    default:
      return "dict";
  }
}

// src/skill/zip.ts
import { deflateRawSync } from "node:zlib";
var crcTable2 = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc322(bytes) {
  let c = 4294967295;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable2[(c ^ bytes[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function dosDateTime(date) {
  const time = Math.floor(date.getSeconds() / 2) & 31 | (date.getMinutes() & 63) << 5 | (date.getHours() & 31) << 11;
  const day = date.getDate() & 31 | (date.getMonth() + 1 & 15) << 5 | (Math.max(0, date.getFullYear() - 1980) & 127) << 9;
  return { time, date: day };
}
function createZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc322(entry.data);
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : Buffer.from(entry.data);
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(entry.mtime ?? /* @__PURE__ */ new Date());
    const header = Buffer.alloc(30);
    header.writeUInt32LE(67324752, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push(header, nameBytes, payload);
    const entryHeader = Buffer.alloc(46);
    entryHeader.writeUInt32LE(33639248, 0);
    entryHeader.writeUInt16LE(20, 4);
    entryHeader.writeUInt16LE(20, 6);
    entryHeader.writeUInt16LE(0, 8);
    entryHeader.writeUInt16LE(method, 10);
    entryHeader.writeUInt16LE(time, 12);
    entryHeader.writeUInt16LE(date, 14);
    entryHeader.writeUInt32LE(crc, 16);
    entryHeader.writeUInt32LE(payload.length, 20);
    entryHeader.writeUInt32LE(entry.data.length, 24);
    entryHeader.writeUInt16LE(nameBytes.length, 28);
    entryHeader.writeUInt16LE(0, 30);
    entryHeader.writeUInt16LE(0, 32);
    entryHeader.writeUInt16LE(0, 34);
    entryHeader.writeUInt16LE(0, 36);
    entryHeader.writeUInt32LE(420 << 16, 38);
    entryHeader.writeUInt32LE(offset, 42);
    central.push(entryHeader, nameBytes);
    offset += header.length + nameBytes.length + payload.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(101010256, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, end]);
}
export {
  ACTIONS,
  ACTION_IDS,
  ANCHOR_GAME_VIEWS,
  ANCHOR_ROLES,
  Bitmap,
  DEFAULT_SNAP_CONFIG,
  DEFAULT_TOLERANCES,
  DIRECTIONS,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  FrontmatterError,
  HEADER,
  HIGH_FRINGE_REMOVAL_RATIO,
  LuaParseError,
  MANIFEST_CANDIDATES,
  MANIFEST_JSON_CANDIDATES,
  MARKER,
  POSE_BOARD_PRESETS,
  PROFILES,
  actionFacts,
  analyzeBaseline,
  analyzeSkillBody,
  auditSizeContract,
  autoDetectManifest,
  buildSequenceGif,
  canonicalProfiles,
  cellHeight,
  cellSizeOf,
  cellWidth,
  checkAntiPatterns,
  checkEmpowerment,
  checkManifest,
  checkOrganization,
  checkPhilosophy,
  checkVariation,
  chromaFringeChannels,
  cleanChroma,
  coerceFrameCount,
  collectSizes,
  colorDistance,
  computeProfiles,
  contractChecks,
  createZip,
  cropBox,
  decodePng,
  decontaminateMatte,
  defaultRoot,
  deriveSizeContract,
  despillChroma,
  diffImages,
  drawDigits,
  drawLine,
  dropUserDataAssignment,
  encodeGif,
  encodePng,
  estimateStepSize,
  exportManifest,
  exportMapRender,
  exportTilesetGrid,
  extractManifestPaths,
  fail,
  failUsage,
  fillRect,
  findComponents,
  formatPythonValue,
  frameGeometry,
  frameLabel,
  frameMetrics,
  fringeWarning,
  generateSuggestions,
  getActionId,
  getAll,
  getDirection,
  getFlag,
  getNumber,
  getString,
  globFrames,
  initSkill,
  isGreenMatte,
  isKeyableFringeChroma,
  keepLargestComponents,
  keyMatte,
  loadFrames,
  loadManifestJson,
  loadSizeContract,
  main,
  makeSelftestMap,
  measureSource,
  median,
  nonEmptyTileIds,
  normalizeCanvas,
  normalizeFactory,
  packSpritesheet,
  parseArgs,
  parseColor,
  parseFrame,
  parseFrontmatter,
  parseLua,
  prettyPath,
  probeSheet,
  promptGuidanceForContract,
  qc,
  quantize2 as quantize,
  readImageSize,
  readPngSize,
  recoverFrames,
  removeChromaFringe,
  renderAnchorPrompt,
  renderFrameGuidance,
  renderPoseBoardPrompt,
  resample,
  resolveAnchorGameView,
  resolveAnchorRole,
  resolvePoseBoardPreset,
  resolveProfile,
  resolveStepSizes,
  resolveTargets,
  roundHalfToEven,
  runQc,
  sanitizeCuts,
  sanitizeTilesets,
  sizesToCsv,
  snapImage,
  snapSheet,
  splitSkill,
  strokeRect,
  styleBlock,
  summarizeMeasurements,
  tileCount,
  tileIdFromColRow,
  tilesetMetaFromManifest,
  titleCaseSkillName,
  toHex,
  toPythonJson,
  totalCells,
  validateSkill,
  verdictFor,
  walk,
  walkFiles,
  withStyle,
  writeJsonFile,
  writeTextFile
};
