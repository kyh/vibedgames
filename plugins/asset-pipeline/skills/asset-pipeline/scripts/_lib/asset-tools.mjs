// GENERATED FILE — do not edit.
// Built from packages/asset-tools by `pnpm --filter @repo/asset-tools build`.
// Contains only the exports this skill's scripts import; edit the TypeScript
// source there and re-run `pnpm dogfood` (or that build) to regenerate.

// src/args.ts
function parseArgs(argv, options = {}) {
  const booleans = new Set(options.booleans ?? []);
  const positionals = [];
  const parsed = /* @__PURE__ */ new Map();
  const push = (key, value) => {
    const existing = parsed.get(key);
    if (existing) existing.push(value);
    else parsed.set(key, [value]);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h") {
      push("help", "true");
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      push(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    if (booleans.has(body)) {
      push(body, "true");
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
  return { positionals, options: parsed };
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
      const nearest = Math.min(srcW - 1, Math.max(0, Math.floor(center)));
      for (let y = 0; y < rows; y += 1) {
        for (let c = 0; c < 4; c += 1) {
          out[(y * dstW + x) * 4 + c] = src[(y * srcW + nearest) * 4 + c];
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

// src/asset/tilemap-server.ts
import { randomUUID } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { createServer } from "node:http";
import { dirname as dirname3, extname, isAbsolute as isAbsolute2, relative, resolve as resolve3 } from "node:path";

// src/asset/tilemap.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2, isAbsolute, resolve as resolve2 } from "node:path";
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
  const payload = JSON.parse(readFileSync2(path, "utf8"));
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
  const manifestDir = resolve2(dirname2(manifestPath));
  const meta = manifest.meta;
  const root = meta !== null && typeof meta === "object" && typeof meta.root === "string" ? meta.root : null;
  const base = root === null ? manifestDir : resolve2(manifestDir, root);
  if (isAbsolute(rel)) return resolve2(rel);
  const candidates = [resolve2(base, rel), resolve2(manifestDir, rel), resolve2(process.cwd(), rel)];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}
function tilesetMetaFromManifest(manifestPath, manifest, name) {
  const tilesets = sanitizeTilesets(manifest);
  const entry = tilesets[name];
  if (!entry) throw new Error(`Tileset not found in manifest: ${name}`);
  const path = resolveAssetPath(manifestPath, manifest, entry.path);
  if (!existsSync(path)) throw new Error(`Tileset file not found: ${path}`);
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
var MAP_MIN = 1;
var MAP_MAX = 512;
function newMap(width, height) {
  return Array.from({ length: height }, () => new Array(width).fill(0));
}
function normalizeMapData(data, width, height) {
  const rows = Array.isArray(data) ? data : [];
  const out = newMap(width, height);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    if (!Array.isArray(row)) continue;
    for (let x = 0; x < width; x += 1) {
      const cell = row[x];
      out[y][x] = typeof cell === "number" && Number.isFinite(cell) ? Math.trunc(cell) : 0;
    }
  }
  return out;
}
function tilemapPayload(meta, width, height, data) {
  return {
    meta: {
      version: 1,
      tileset: meta.name,
      tileWidth: meta.tileW,
      tileHeight: meta.tileH,
      width,
      height
    },
    data
  };
}
function parseTilemap(payload, fallback) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Map JSON must be an object.");
  }
  const doc = payload;
  const meta = doc.meta;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta) || !Array.isArray(doc.data)) {
    throw new Error("Map JSON must have a `meta` object and a `data` array.");
  }
  const metaObj = meta;
  const clamp = (value) => Math.max(MAP_MIN, Math.min(MAP_MAX, value));
  const width = clamp(asInt(metaObj.width, fallback.width));
  const height = clamp(asInt(metaObj.height, fallback.height));
  return {
    width,
    height,
    data: normalizeMapData(doc.data, width, height),
    tileset: typeof metaObj.tileset === "string" ? metaObj.tileset : null
  };
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

// src/asset/tilemap-server.ts
var DEFAULT_MAP_WIDTH = 64;
var DEFAULT_MAP_HEIGHT = 36;
var CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};
function isInside(root, candidate) {
  const rel = relative(resolve3(root), resolve3(candidate));
  return rel === "" || !rel.startsWith("..") && !isAbsolute2(rel);
}
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // Nothing here should ever be cached: the point is to reflect files on disk.
    "cache-control": "no-store"
  });
  res.end(payload);
}
function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk2) => {
      total += chunk2.length;
      if (total > limitBytes) {
        rejectBody(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk2);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}
function tilesetSummary(meta) {
  return {
    name: meta.name,
    tileWidth: meta.tileW,
    tileHeight: meta.tileH,
    columns: meta.columns,
    rows: meta.rows,
    margin: meta.margin,
    spacing: meta.spacing,
    imageWidth: meta.imageW,
    imageHeight: meta.imageH,
    path: meta.path
  };
}
function createTilemapEditor(options) {
  const token = randomUUID();
  const manifestPath = resolve3(options.manifestPath);
  const writeRoot = resolve3(options.writeRoot);
  const readTilesets = () => {
    const manifest = loadManifestJson(manifestPath);
    return { manifest, tilesets: sanitizeTilesets(manifest) };
  };
  const metaFor = (name) => {
    const { manifest, tilesets } = readTilesets();
    if (!(name in tilesets)) throw new Error(`No such tileset: ${name}`);
    return tilesetMetaFromManifest(manifestPath, manifest, name);
  };
  const resolveWritable = (raw) => {
    const target = resolve3(writeRoot, raw);
    if (!isInside(writeRoot, target)) {
      throw new Error(`Refusing to touch a path outside ${writeRoot}: ${raw}`);
    }
    return target;
  };
  const handlers = {
    async "/api/state"() {
      const { tilesets } = readTilesets();
      const names = Object.keys(tilesets).sort();
      const selected = options.tileset && names.includes(options.tileset) ? options.tileset : names[0];
      let map = {
        width: DEFAULT_MAP_WIDTH,
        height: DEFAULT_MAP_HEIGHT,
        data: newMap(DEFAULT_MAP_WIDTH, DEFAULT_MAP_HEIGHT),
        tileset: null
      };
      if (options.mapPath && existsSync2(options.mapPath)) {
        map = parseTilemap(JSON.parse(readFileSync3(options.mapPath, "utf8")), {
          width: DEFAULT_MAP_WIDTH,
          height: DEFAULT_MAP_HEIGHT
        });
      }
      const initial = map.tileset && names.includes(map.tileset) ? map.tileset : selected;
      return {
        manifestPath,
        mapPath: options.mapPath ?? null,
        writeRoot,
        tilesetNames: names,
        tileset: tilesetSummary(metaFor(initial)),
        map
      };
    },
    async "/api/tileset"(url) {
      const name = url.searchParams.get("name");
      if (!name) throw new Error("name is required");
      return tilesetSummary(metaFor(name));
    },
    async "/api/load"(url) {
      const path = url.searchParams.get("path");
      if (!path) throw new Error("path is required");
      const target = resolveWritable(path);
      if (!existsSync2(target)) throw new Error(`Map not found: ${path}`);
      return {
        path: target,
        ...parseTilemap(JSON.parse(readFileSync3(target, "utf8")), {
          width: DEFAULT_MAP_WIDTH,
          height: DEFAULT_MAP_HEIGHT
        })
      };
    },
    async "/api/save"(url, req) {
      const body = JSON.parse(await readBody(req));
      if (body === null || typeof body !== "object") throw new Error("Body must be an object.");
      const doc = body;
      const raw = typeof doc.path === "string" && doc.path ? doc.path : options.mapPath;
      if (!raw) throw new Error("No path given and no --map to fall back on.");
      const target = resolveWritable(raw);
      if (typeof doc.tileset !== "string") throw new Error("tileset is required");
      const meta = metaFor(doc.tileset);
      const parsed = parseTilemap(
        { meta: { width: doc.width, height: doc.height }, data: doc.data },
        { width: DEFAULT_MAP_WIDTH, height: DEFAULT_MAP_HEIGHT }
      );
      mkdirSync2(dirname3(target), { recursive: true });
      writeFileSync2(
        target,
        `${JSON.stringify(tilemapPayload(meta, parsed.width, parsed.height, parsed.data), null, 2)}
`
      );
      return { path: target, width: parsed.width, height: parsed.height };
    }
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const authorized = req.headers["x-editor-token"] === token || url.searchParams.get("t") === token;
      if (!authorized) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Forbidden \u2014 open the URL the editor printed, token included.\n");
        return;
      }
      if (url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(options.html);
        return;
      }
      if (url.pathname === "/api/sheet") {
        try {
          const name = url.searchParams.get("name");
          if (!name) throw new Error("name is required");
          const meta = metaFor(name);
          const bytes = readFileSync3(meta.path);
          res.writeHead(200, {
            "content-type": CONTENT_TYPES[extname(meta.path).toLowerCase()] ?? "image/png",
            "content-length": bytes.length,
            "cache-control": "no-store"
          });
          res.end(bytes);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      const handler = handlers[url.pathname];
      if (!handler) {
        sendJson(res, 404, { error: `No such endpoint: ${url.pathname}` });
        return;
      }
      try {
        sendJson(res, 200, await handler(url, req));
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
  return {
    server,
    token,
    url: (port, host = "127.0.0.1") => `http://${host}:${port}/?t=${token}`
  };
}

// src/asset/manifest.ts
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname5, isAbsolute as isAbsolute3, relative as relative3, resolve as resolve5 } from "node:path";

// src/asset/paths.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readdirSync, statSync, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname4, join, relative as relative2, resolve as resolve4, sep } from "node:path";
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
  if (!existsSync3(path)) throw new Error(`Path not found: ${path}`);
  return statSync(path).isFile() ? [path] : walkFiles(path, extension);
}
function defaultRoot(explicit) {
  if (explicit) return explicit;
  return existsSync3("assets") ? "assets" : ".";
}
function prettyPath(path) {
  const rel = relative2(process.cwd(), resolve4(path));
  return rel && !rel.startsWith(`..${sep}`) && rel !== ".." ? rel : resolve4(path);
}
function toPythonJson(payload) {
  return JSON.stringify(payload, null, 2).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}
function writeJsonFile(path, payload) {
  mkdirSync3(dirname4(resolve4(path)), { recursive: true });
  writeFileSync3(path, `${toPythonJson(payload)}
`);
}
function writeTextFile(path, contents) {
  mkdirSync3(dirname4(resolve4(path)), { recursive: true });
  writeFileSync3(path, contents);
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
  if (isAbsolute3(raw)) return resolve5(raw);
  return jsonRoot ? resolve5(manifestDir, jsonRoot, raw) : resolve5(manifestDir, raw);
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
  const manifestDir = resolve5(dirname5(manifestPath));
  if (manifestPath.toLowerCase().endsWith(".json")) {
    const payload = JSON.parse(readFileSync4(manifestPath, "utf8"));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("JSON manifest must be an object at top-level.");
    }
    const meta = payload.meta;
    const jsonRoot = meta !== null && typeof meta === "object" && typeof meta.root === "string" ? meta.root : null;
    return new Set(
      collectJsonPaths(payload).map((p) => resolveManifestPath(p, manifestDir, jsonRoot))
    );
  }
  const text = readFileSync4(manifestPath, "utf8");
  const out = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(LUA_PATH_RE)) {
    out.add(resolveManifestPath(match[1], manifestDir, null));
  }
  return out;
}
function checkManifest(manifestPath, root) {
  const manifestPaths = extractManifestPaths(manifestPath);
  const actualPaths = new Set(walkFiles(root, ".png").map((p) => resolve5(p)));
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
  return MANIFEST_CANDIDATES.find((p) => existsSync4(p)) ?? null;
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
      const absolute = isAbsolute3(nested) ? resolve5(nested) : resolve5(process.cwd(), nested);
      const rel = relative3(resolve5(base), absolute);
      out[key] = rel && !rel.startsWith("..") ? rel.split(/[/\\]/).join("/") : nested;
    } else {
      out[key] = rewritePaths(base, nested);
    }
  }
  return out;
}
function exportManifest(manifestPath, packRelative) {
  if (manifestPath.toLowerCase().endsWith(".json")) {
    const payload = JSON.parse(readFileSync4(manifestPath, "utf8"));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("JSON manifest must be an object at top-level.");
    }
    return payload;
  }
  const parsed = parseLua(readFileSync4(manifestPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Lua manifest must return a table/object.");
  }
  let normalized = renameKeys(parsed);
  if (packRelative) {
    normalized = rewritePaths(resolve5(dirname5(manifestPath)), normalized);
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

// src/skill/normalize-factory.ts
var MARKER = "// @ts-nocheck";
var HEADER = `${MARKER}
// GENERATED by img2threejs, normalized by plugins/asset-pipeline/skills/image-to-threejs.
// Do not edit: re-run the generator, then normalize_factory.mjs. Consume it only
// through its exported factory functions, which are typed at the call site.
`;

// src/skill/zip.ts
var crcTable2 = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c;
  }
  return table;
})();
export {
  MANIFEST_CANDIDATES,
  MANIFEST_JSON_CANDIDATES,
  analyzeBaseline,
  autoDetectManifest,
  checkManifest,
  collectSizes,
  createTilemapEditor,
  defaultRoot,
  exportManifest,
  exportMapRender,
  exportTilesetGrid,
  fail,
  getAll,
  getFlag,
  getNumber,
  getString,
  loadManifestJson,
  main,
  makeSelftestMap,
  parseArgs,
  parseColor,
  parseFrame,
  probeSheet,
  resolveTargets,
  sanitizeTilesets,
  sizesToCsv,
  tilesetMetaFromManifest,
  writeJsonFile,
  writeTextFile
};
