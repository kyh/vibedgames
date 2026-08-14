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

// src/asset/paths.ts
import { existsSync, mkdirSync as mkdirSync2, readdirSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join, relative, resolve as resolve2, sep } from "node:path";
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

// src/pymath.ts
function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
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
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
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
  if (existsSync2(manifestPath)) {
    const m = JSON.parse(readFileSync2(manifestPath, "utf8"));
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

// src/sprite/size-contract.ts
import { existsSync as existsSync3, statSync as statSync2 } from "node:fs";
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
  if (existsSync3(source) && statSync2(source).isDirectory()) {
    return globFrames(source, frameGlob).map((path) => {
      const image2 = Bitmap.fromFile(path);
      return measureBitmap(image2, basename2(path), path, [image2.width, image2.height]);
    });
  }
  if (!existsSync3(source)) throw new Error(`missing size contract source: ${source}`);
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
  const isDir = existsSync3(source) && statSync2(source).isDirectory();
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
  ACTIONS,
  Bitmap,
  DEFAULT_SNAP_CONFIG,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  HIGH_FRINGE_REMOVAL_RATIO,
  PROFILES,
  actionFacts,
  auditSizeContract,
  buildSequenceGif,
  canonicalProfiles,
  cleanChroma,
  coerceFrameCount,
  deriveSizeContract,
  despillChroma,
  fail,
  failUsage,
  formatPythonValue,
  getDirection,
  getFlag,
  getNumber,
  getString,
  globFrames,
  keyMatte,
  loadSizeContract,
  main,
  normalizeCanvas,
  packSpritesheet,
  parseArgs,
  parseColor,
  promptGuidanceForContract,
  recoverFrames,
  removeChromaFringe,
  renderAnchorPrompt,
  renderPoseBoardPrompt,
  resolvePoseBoardPreset,
  resolveProfile,
  runQc,
  snapImage,
  toPythonJson,
  totalCells,
  withStyle,
  writeJsonFile
};
