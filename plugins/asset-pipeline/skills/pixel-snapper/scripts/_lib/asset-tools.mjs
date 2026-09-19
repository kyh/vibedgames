// GENERATED FILE — do not edit.
// Built from packages/asset-tools by `pnpm --filter @repo/asset-tools build`.
// Contains only the exports this skill's scripts import; edit the TypeScript
// source there and re-run `pnpm dogfood` (or that build) to regenerate.

// src/args.ts
import { readFileSync } from "node:fs";
var headerDoc = (entry) => {
  if (!entry) {
    return null;
  }
  let source;
  try {
    source = readFileSync(entry, "utf-8");
  } catch {
    return null;
  }
  const doc = /^(?:#![^\n]*\n)?\/\*\*(?<doc>[\s\S]*?)\*\//u.exec(source)?.groups?.doc;
  if (doc === void 0) {
    return null;
  }
  const text = doc.split("\n").map((line) => line.replace(/^\s*\* ?/u, "")).join("\n").trim();
  return text.length > 0 ? text : null;
};
var fail = (message) => {
  process.stderr.write(`${message}
`);
  process.exit(1);
};
var failUsage = (message) => {
  process.stderr.write(`${message}
`);
  process.exit(2);
};
var declaredOptions = (options) => {
  const booleans = new Set(options.booleans);
  const known = /* @__PURE__ */ new Set([...booleans, ...options.values ?? [], "help"]);
  const strict = options.booleans !== void 0 || options.values !== void 0;
  return { booleans, known, strict };
};
var isValueToken = (token) => token !== void 0 && !token.startsWith("--");
var parseArgs = (argv, options = {}) => {
  const { booleans, known, strict } = declaredOptions(options);
  const unknown = [];
  const positionals = [];
  const parsed = /* @__PURE__ */ new Map();
  const push = (key, value) => {
    const existing = parsed.get(key);
    if (existing) {
      existing.push(value);
    } else {
      parsed.set(key, [value]);
    }
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
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
      const name = body.slice(0, equals);
      if (strict && !known.has(name)) {
        unknown.push(`--${name}`);
      }
      push(name, body.slice(equals + 1));
      continue;
    }
    if (booleans.has(body)) {
      push(body, "true");
      continue;
    }
    if (strict && !known.has(body)) {
      unknown.push(`--${body}`);
      if (isValueToken(argv[i + 1])) {
        i += 1;
      }
      continue;
    }
    const next = argv[i + 1];
    if (isValueToken(next)) {
      push(body, next);
      i += 1;
    } else {
      push(body, "true");
    }
  }
  if (unknown.length > 0) {
    failUsage(`unrecognized arguments: ${unknown.join(" ")}`);
  }
  if (parsed.has("help")) {
    const help = headerDoc(process.argv[1]);
    process.stdout.write(`${help ?? "No help available."}
`);
    process.exit(0);
  }
  return { options: parsed, positionals };
};
var getString = (args, key) => args.options.get(key)?.at(-1);
var getFlag = (args, key) => {
  const value = getString(args, key);
  return value !== void 0 && value !== "false";
};
var getInt = (args, key, fallback) => {
  const raw = getString(args, key);
  if (raw === void 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    failUsage(`--${key} must be a whole number, got "${raw}"`);
  }
  return value;
};
var main = (run) => {
  try {
    run();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
};

// src/image/raster.ts
import { mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import path from "node:path";

// src/image/png.ts
import { deflateSync, inflateSync } from "node:zlib";
var SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
var ADAM7 = [
  { xStart: 0, xStep: 8, yStart: 0, yStep: 8 },
  { xStart: 4, xStep: 8, yStart: 0, yStep: 8 },
  { xStart: 0, xStep: 4, yStart: 4, yStep: 8 },
  { xStart: 2, xStep: 4, yStart: 0, yStep: 4 },
  { xStart: 0, xStep: 2, yStart: 2, yStep: 4 },
  { xStart: 1, xStep: 2, yStart: 0, yStep: 2 },
  { xStart: 0, xStep: 1, yStart: 1, yStep: 2 }
];
var CHANNELS = /* @__PURE__ */ new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4]
]);
var channelsFor = (colorType) => {
  const channels = CHANNELS.get(colorType);
  if (channels === void 0) {
    throw new Error(`PNG: unsupported colour type ${colorType}`);
  }
  return channels;
};
var MAX_PIXELS = 64e6;
var crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();
var crc32 = (bytes) => {
  let c = 4294967295;
  for (const byte of bytes) {
    c = (crcTable[(c ^ byte) & 255] ?? 0) ^ c >>> 8;
  }
  return (c ^ 4294967295) >>> 0;
};
var byteAt = (bytes, i) => bytes[i] ?? 0;
var paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
};
var unfilter = (type, line, prev, bpp) => {
  const len = line.length;
  switch (type) {
    case 0: {
      return;
    }
    case 1: {
      for (let i = bpp; i < len; i += 1) {
        line[i] = (byteAt(line, i) + byteAt(line, i - bpp)) % 256;
      }
      return;
    }
    case 2: {
      for (let i = 0; i < len; i += 1) {
        line[i] = (byteAt(line, i) + byteAt(prev, i)) % 256;
      }
      return;
    }
    case 3: {
      for (let i = 0; i < len; i += 1) {
        const left = byteAt(line, i - bpp);
        line[i] = (byteAt(line, i) + Math.floor((left + byteAt(prev, i)) / 2)) % 256;
      }
      return;
    }
    case 4: {
      for (let i = 0; i < len; i += 1) {
        const a = byteAt(line, i - bpp);
        const b = byteAt(prev, i);
        const c = byteAt(prev, i - bpp);
        line[i] = (byteAt(line, i) + paeth(a, b, c)) % 256;
      }
      return;
    }
    default: {
      throw new Error(`PNG: unknown filter type ${type}`);
    }
  }
};
var sampleAt = (line, index, bitDepth) => {
  if (bitDepth === 8) {
    return byteAt(line, index);
  }
  if (bitDepth === 16) {
    return byteAt(line, index * 2) * 256 + byteAt(line, index * 2 + 1);
  }
  const perByte = 8 / bitDepth;
  const byte = byteAt(line, Math.floor(index / perByte));
  const shift = 8 - bitDepth * (index % perByte + 1);
  return Math.floor(byte / 2 ** shift) % 2 ** bitDepth;
};
var scaleTo8 = (value, bitDepth) => {
  if (bitDepth === 8) {
    return value;
  }
  if (bitDepth === 16) {
    return Math.floor(value / 256);
  }
  return Math.round(value * 255 / (2 ** bitDepth - 1));
};
var expandPass = (raw, offset, passWidth, passHeight, geom, header, palette, transparency, out) => {
  const { width, bitDepth, colorType } = header;
  const channels = channelsFor(colorType);
  const bpp = Math.max(1, Math.ceil(channels * bitDepth / 8));
  const lineBytes = Math.ceil(channels * bitDepth * passWidth / 8);
  let prev = new Uint8Array(lineBytes);
  let cursor = offset;
  for (let row = 0; row < passHeight; row += 1) {
    const filterType = raw[cursor];
    if (filterType === void 0) {
      throw new Error("PNG: truncated pixel data");
    }
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
        if (!palette) {
          throw new Error("PNG: indexed image without a PLTE chunk");
        }
        r = byteAt(palette, index * 3);
        g = byteAt(palette, index * 3 + 1);
        b = byteAt(palette, index * 3 + 2);
        a = transparency?.[index] ?? 255;
      } else if (colorType === 0 || colorType === 4) {
        const grey = sampleAt(line, base, bitDepth);
        r = scaleTo8(grey, bitDepth);
        g = r;
        b = r;
        if (colorType === 4) {
          a = scaleTo8(sampleAt(line, base + 1, bitDepth), bitDepth);
        } else if (transparency && transparency[0] === grey) {
          a = 0;
        }
      } else {
        const rawR = sampleAt(line, base, bitDepth);
        const rawG = sampleAt(line, base + 1, bitDepth);
        const rawB = sampleAt(line, base + 2, bitDepth);
        r = scaleTo8(rawR, bitDepth);
        g = scaleTo8(rawG, bitDepth);
        b = scaleTo8(rawB, bitDepth);
        if (colorType === 6) {
          a = scaleTo8(sampleAt(line, base + 3, bitDepth), bitDepth);
        } else if (transparency && transparency[0] === rawR && transparency[1] === rawG && transparency[2] === rawB) {
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
};
var expectedRawBytes = (header) => {
  const channels = channelsFor(header.colorType);
  const rowBytes = (w) => Math.ceil(channels * header.bitDepth * w / 8);
  if (header.interlace === 0) {
    return header.height === 0 ? 0 : header.height * (1 + rowBytes(header.width));
  }
  let total = 0;
  for (const geom of ADAM7) {
    const passWidth = Math.ceil(Math.max(0, header.width - geom.xStart) / geom.xStep);
    const passHeight = Math.ceil(Math.max(0, header.height - geom.yStart) / geom.yStep);
    if (passWidth === 0 || passHeight === 0) {
      continue;
    }
    total += passHeight * (1 + rowBytes(passWidth));
  }
  return total;
};
var checkSignature = (buffer) => {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (buffer[i] !== SIGNATURE[i]) {
      throw new Error("Not a PNG file (bad signature)");
    }
  }
};
var parseIhdr = (view, pos) => {
  const header = {
    bitDepth: view.getUint8(pos + 16),
    colorType: view.getUint8(pos + 17),
    height: view.getUint32(pos + 12),
    interlace: view.getUint8(pos + 20),
    width: view.getUint32(pos + 8)
  };
  if (view.getUint8(pos + 18) !== 0) {
    throw new Error("PNG: unsupported compression method");
  }
  if (view.getUint8(pos + 19) !== 0) {
    throw new Error("PNG: unsupported filter method");
  }
  if (!CHANNELS.has(header.colorType)) {
    throw new Error(`PNG: unsupported colour type ${header.colorType}`);
  }
  if (header.width < 1 || header.height < 1) {
    throw new Error(`PNG: invalid dimensions ${header.width}x${header.height}`);
  }
  if (header.width * header.height > MAX_PIXELS) {
    throw new Error(
      `PNG: ${header.width}x${header.height} exceeds the ${MAX_PIXELS.toLocaleString("en-US")}-pixel limit`
    );
  }
  return header;
};
var parseTransparency = (body, colorType) => {
  if (colorType === 3) {
    return [...body];
  }
  const sample16 = (i) => byteAt(body, i) * 256 + byteAt(body, i + 1);
  if (colorType === 0) {
    return [sample16(0)];
  }
  return [sample16(0), sample16(2), sample16(4)];
};
var readChunks = (buffer) => {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let pos = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (pos < buffer.length) {
    if (pos + 8 > buffer.length) {
      throw new Error("PNG: truncated before a chunk header");
    }
    const length = view.getUint32(pos);
    const type = String.fromCodePoint(...buffer.subarray(pos + 4, pos + 8));
    if (pos + 12 + length > buffer.length) {
      throw new Error(`PNG: truncated ${type} chunk (wanted ${length} bytes)`);
    }
    const body = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      header = parseIhdr(view, pos);
    } else if (type === "PLTE") {
      palette = Uint8Array.from(body);
    } else if (type === "tRNS") {
      if (!header) {
        throw new Error("PNG: tRNS before IHDR");
      }
      transparency = parseTransparency(body, header.colorType);
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (!header) {
    throw new Error("PNG: missing IHDR");
  }
  return { header, idat, palette, transparency };
};
var expandImage = (raw, chunks) => {
  const { header, palette, transparency } = chunks;
  const { width, height, interlace } = header;
  const out = new Uint8Array(width * height * 4);
  if (interlace === 0) {
    expandPass(
      raw,
      0,
      width,
      height,
      { xStart: 0, xStep: 1, yStart: 0, yStep: 1 },
      header,
      palette,
      transparency,
      out
    );
    return out;
  }
  if (interlace !== 1) {
    throw new Error(`PNG: unsupported interlace method ${interlace}`);
  }
  let cursor = 0;
  for (const geom of ADAM7) {
    const passWidth = Math.ceil(Math.max(0, width - geom.xStart) / geom.xStep);
    const passHeight = Math.ceil(Math.max(0, height - geom.yStart) / geom.yStep);
    if (passWidth === 0 || passHeight === 0) {
      continue;
    }
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
  return out;
};
var decodePng = (buffer) => {
  checkSignature(buffer);
  const chunks = readChunks(buffer);
  const { header, idat } = chunks;
  const { width, height, bitDepth, colorType } = header;
  if (![1, 2, 4, 8, 16].includes(bitDepth)) {
    throw new Error(`PNG: unsupported bit depth ${bitDepth}`);
  }
  if (colorType === 3 && bitDepth === 16) {
    throw new Error("PNG: indexed images cap at 8-bit");
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c)))));
  const expected = expectedRawBytes(header);
  if (raw.length < expected) {
    throw new Error(
      `PNG: truncated pixel data (${raw.length} bytes, expected ${expected} for ${width}x${height})`
    );
  }
  return { data: expandImage(raw, chunks), height, width };
};
var chunk = (type, body) => {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
};
var filterScanlines = (data, width, height) => {
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
        const a = byteAt(line, i - 4);
        const b = byteAt(prev, i);
        const c = byteAt(prev, i - 4);
        const current = byteAt(line, i);
        let value;
        if (type === 0) {
          value = current;
        } else if (type === 1) {
          value = current - a;
        } else if (type === 2) {
          value = current - b;
        } else if (type === 3) {
          value = current - Math.floor((a + b) / 2);
        } else {
          value = current - paeth(a, b, c);
        }
        const wrapped = (value % 256 + 256) % 256;
        candidate[i] = wrapped;
        score += wrapped >= 128 ? 256 - wrapped : wrapped;
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
};
var encodePng = (image) => {
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
};
var readPngSize = (buffer) => {
  checkSignature(buffer);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return { height: view.getUint32(20), width: view.getUint32(16) };
};

// src/image/raster.ts
var at = (buffer, i) => buffer[i] ?? 0;
var clamp8 = (value) => {
  if (value <= 0) {
    return 0;
  }
  if (value >= 255) {
    return 255;
  }
  return Math.round(value);
};
var FILTERS = {
  bicubic: {
    // Catmull-Rom variant with a = -0.5, which is Pillow's BICUBIC and the
    // default filter for `Image.resize`.
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
    support: 2
  },
  bilinear: {
    kernel: (x) => {
      const t = Math.abs(x);
      return t < 1 ? 1 - t : 0;
    },
    support: 1
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
      return 3 * Math.sin(pix) * Math.sin(pix / 3) / (pix * pix);
    },
    support: 3
  }
};
var mulDiv255 = (value, alpha) => {
  const tmp = value * alpha + 128;
  return Math.floor((tmp + Math.floor(tmp / 256)) / 256);
};
var premultiply = (data) => {
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
var quantizeInPlace = (buffer) => {
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = clamp8(at(buffer, i));
  }
};
var unpremultiply = (src, out) => {
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
      out[i + c] = Math.min(255, Math.floor(premul * 255 / a));
    }
  }
};
var resamplePass = (src, srcW, rows, dstW, kernel, support) => {
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
var transpose = (src, width, height) => {
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
    if (fill[0] || fill[1] || fill[2] || fill[3]) {
      bmp.fill(fill);
    }
    return bmp;
  }
  static fromFile(file) {
    const buffer = readFileSync2(file);
    const { width, height, data } = decodePng(buffer);
    return new _Bitmap(width, height, data);
  }
  toFile(file) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    writeFileSync(file, encodePng({ data: this.data, height: this.height, width: this.width }));
  }
  toBuffer() {
    return encodePng({ data: this.data, height: this.height, width: this.width });
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
    return [at(this.data, i), at(this.data, i + 1), at(this.data, i + 2), at(this.data, i + 3)];
  }
  putPixel(x, y, [r, g, b, a]) {
    if (!this.contains(x, y)) {
      return;
    }
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
  paste(src, left, top) {
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
  pasteMasked(src, left, top, mask) {
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
            at(this.data, di + c) * (1 - m) + at(src.data, si + c) * m
          );
        }
      }
    }
  }
  /** Source-over blend of `src` onto this bitmap at (left, top). */
  alphaComposite(src, left = 0, top = 0) {
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
  channel(offset) {
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
        at(this.data, p) * 0.299 + at(this.data, p + 1) * 0.587 + at(this.data, p + 2) * 0.114
      );
    }
    return out;
  }
  /** Composite onto an opaque background — Pillow's `convert("RGB")`. */
  flatten(background = [0, 0, 0]) {
    const out = new _Bitmap(this.width, this.height);
    for (let i = 0; i < this.data.length; i += 4) {
      const a = at(this.data, i + 3) / 255;
      for (let c = 0; c < 3; c += 1) {
        out.data[i + c] = Math.round(at(this.data, i + c) * a + (background[c] ?? 0) * (1 - a));
      }
      out.data[i + 3] = 255;
    }
    return out;
  }
  resize(width, height, mode = "nearest") {
    if (width === this.width && height === this.height) {
      return this.copy();
    }
    if (mode === "nearest") {
      return this.resizeNearest(width, height);
    }
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
        out.data[di] = at(this.data, si);
        out.data[di + 1] = at(this.data, si + 1);
        out.data[di + 2] = at(this.data, si + 2);
        out.data[di + 3] = at(this.data, si + 3);
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
var readJpegSize = (buffer) => {
  let pos = 2;
  while (pos + 9 < buffer.length) {
    if (buffer[pos] !== 255) {
      pos += 1;
      continue;
    }
    const marker = at(buffer, pos + 1);
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      return { height: buffer.readUInt16BE(pos + 5), width: buffer.readUInt16BE(pos + 7) };
    }
    pos += 2 + buffer.readUInt16BE(pos + 2);
  }
  return null;
};
var readWebpSize = (buffer) => {
  const format = buffer.subarray(12, 16).toString("ascii");
  if (format === "VP8X") {
    return {
      height: 1 + buffer.readUIntLE(27, 3),
      width: 1 + buffer.readUIntLE(24, 3)
    };
  }
  if (format === "VP8 ") {
    return { height: buffer.readUInt16LE(28) % 16384, width: buffer.readUInt16LE(26) % 16384 };
  }
  if (format === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { height: 1 + Math.floor(bits / 16384) % 16384, width: 1 + bits % 16384 };
  }
  return null;
};
var readImageSize = (file) => {
  const buffer = readFileSync2(file);
  if (buffer.length >= 24 && buffer[0] === 137 && buffer[1] === 80) {
    return readPngSize(buffer);
  }
  if (buffer[0] === 255 && buffer[1] === 216) {
    return readJpegSize(buffer);
  }
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return { height: buffer.readUInt16LE(8), width: buffer.readUInt16LE(6) };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return readWebpSize(buffer);
  }
  return null;
};

// src/sprite/presets.ts
var action = (name, defaultFrames, recommendedFrames, fps, timing, loopable, selectionPolicy) => ({
  action: name,
  defaultFrames,
  fps,
  loopable,
  recommendedFrames,
  selectionPolicy,
  timing
});
var ACTIONS = {
  attack: action("attack", 8, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  block_high: action("block_high", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  block_low: action("block_low", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  crouch: action("crouch", 6, [5, 6, 8], 8, "hold", true, "hold_pose"),
  dash: action("dash", 6, [5, 6, 8], 14, "one_shot", false, "action_window"),
  death: action("death", 10, [8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  examine: action("examine", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  get_up: action("get_up", 12, [6, 8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  give: action("give", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  heavy_attack: action("heavy_attack", 12, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  hurt: action("hurt", 6, [4, 5, 6, 8], 8, "one_shot", false, "action_window"),
  idle: action("idle", 10, [8, 10, 12], 6, "loop", true, "cycle"),
  interact: action("interact", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  jump: action("jump", 6, [6, 8, 10], 8, "transition", false, "full_duration_include_end"),
  knockdown: action(
    "knockdown",
    12,
    [8, 10, 12],
    8,
    "transition",
    false,
    "full_duration_include_end"
  ),
  light_attack: action("light_attack", 8, [6, 8, 10, 12], 12, "one_shot", false, "action_window"),
  pick_up: action("pick_up", 12, [8, 10, 12], 8, "one_shot", false, "action_window"),
  roll: action("roll", 8, [6, 8, 10], 14, "one_shot", false, "action_window"),
  run: action("run", 8, [8, 10, 12], 12, "loop", true, "cycle"),
  shrug: action("shrug", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  talk: action("talk", 12, [8, 10, 12], 8, "loop", true, "cycle"),
  use: action("use", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  walk: action("walk", 8, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_backward: action("walk_backward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_forward: action("walk_forward", 12, [8, 10, 12], 10, "loop", true, "cycle")
};

// src/sprite/pixel-snap.ts
var DEFAULT_SNAP_CONFIG = {
  fallbackTargetSegments: 64,
  kColors: 16,
  kSeed: 42,
  maxKmeansIterations: 15,
  maxStepRatio: 1.8,
  peakDistanceFilter: 4,
  peakThresholdMultiplier: 0.2,
  walkerMinSearchWindow: 2,
  walkerSearchWindowRatio: 0.35,
  walkerStrengthThreshold: 0.5
};
var makeRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = state + 1831565813 >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};
var sampleWithoutReplacement = (limit, count, seed) => {
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
var rgbAt = (data, p) => [
  data[p] ?? 0,
  data[p + 1] ?? 0,
  data[p + 2] ?? 0
];
var nearestCenter = ([r, g, b], centers) => {
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
var updateCenters = (image, opaque, labels, centers) => {
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
    if (members === 0) {
      continue;
    }
    const next = [sumR / members, sumG / members, sumB / members];
    if (Math.abs(next[0] - center[0]) > 0.5 || Math.abs(next[1] - center[1]) > 0.5 || Math.abs(next[2] - center[2]) > 0.5) {
      moved = true;
    }
    centers[c] = next;
  }
  return moved;
};
var quantize = (image, config) => {
  const opaque = [];
  for (let i = 0; i < image.data.length; i += 4) {
    if ((image.data[i + 3] ?? 0) > 0) {
      opaque.push(i);
    }
  }
  if (opaque.length === 0) {
    return image.copy();
  }
  const k = Math.min(config.kColors, opaque.length);
  const centers = sampleWithoutReplacement(opaque.length, k, config.kSeed).map(
    (index) => rgbAt(image.data, opaque[index] ?? 0)
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
    if (center === void 0) {
      continue;
    }
    out.data[p] = Math.round(center[0]);
    out.data[p + 1] = Math.round(center[1]);
    out.data[p + 2] = Math.round(center[2]);
  }
  return out;
};
var computeProfiles = (image) => {
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
    luma[i] = 0.299 * (image.data[p] ?? 0) + 0.587 * (image.data[p + 1] ?? 0) + 0.114 * (image.data[p + 2] ?? 0);
  }
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
var medianOf = (values) => {
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
};
var estimateStepSize = (profile, config) => {
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
  const peaks = [];
  for (let i = 1; i < profile.length - 1; i += 1) {
    const value = profile[i] ?? 0;
    if (value > threshold && value > (profile[i - 1] ?? 0) && value > (profile[i + 1] ?? 0)) {
      peaks.push(i);
    }
  }
  if (peaks.length < 2) {
    return null;
  }
  const clean = [];
  for (const peak of peaks) {
    const last = clean.at(-1);
    if (last === void 0 || peak - last > config.peakDistanceFilter - 1) {
      clean.push(peak);
    }
  }
  if (clean.length < 2) {
    return null;
  }
  const diffs = clean.slice(1).map((value, i) => value - (clean[i] ?? 0));
  return medianOf(diffs);
};
var resolveStepSizes = (sx, sy, width, height, config) => {
  if (sx !== null && sy !== null) {
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
var walk = (profile, stepSize, limit, config) => {
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
var sanitizeCuts = (cuts, limit) => {
  const seen = [...new Set(cuts.filter((c) => c >= 0 && c <= limit))].toSorted((a, b) => a - b);
  if (seen.length === 0 || seen[0] !== 0) {
    seen.unshift(0);
  }
  if (seen.at(-1) !== limit) {
    seen.push(limit);
  }
  const deduped = [];
  for (const cut of seen) {
    const last = deduped.at(-1);
    if (last === void 0 || cut > last) {
      deduped.push(cut);
    }
  }
  return deduped;
};
var majorityColor = (image, x0, x1, y0, y1) => {
  const counts = /* @__PURE__ */ new Map();
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
      const rgba = [...rgbAt(image.data, p), alpha];
      const key = rgba[0] * 2 ** 24 + rgba[1] * 2 ** 16 + rgba[2] * 2 ** 8 + rgba[3];
      const entry = counts.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        counts.set(key, { count: 1, rgba });
      }
    }
  }
  let best = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) {
      best = entry;
    }
  }
  return best ? best.rgba : null;
};
var resample = (image, colCuts, rowCuts) => {
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
var snapImage = (inputPath, config) => {
  const image = Bitmap.fromFile(inputPath);
  const quantized = quantize(image, config);
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
};
var DEGENERATE_SIDE = 8;
var snapWarning = (input, output, config) => {
  if (output.width < DEGENERATE_SIDE || output.height < DEGENERATE_SIDE) {
    return `recovered grid collapsed to ${output.width}x${output.height} from ${input.width}x${input.height} \u2014 there was no pixel grid to find. Key the background out first (a flat matte hides the grid), or the source is not upscaled pixel art at all`;
  }
  const fallback = config.fallbackTargetSegments;
  if (output.width === fallback && output.height === fallback) {
    return `output is exactly ${fallback}x${fallback}: step detection found no structure and fell back to a fixed segment count, so these are not the source's own pixels`;
  }
  return null;
};
var snapSheet = (image, cols, rows, config) => {
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
      image.crop({ bottom: (r + 1) * fh, left: c * fw, right: (c + 1) * fw, top: r * fh }),
      index * fw,
      0
    );
  }
  const quantized = quantize(strip, config);
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
      snapped.crop({ bottom: sh, left: index * tw, right: (index + 1) * tw, top: 0 }),
      c * tw,
      r * sh
    );
  }
  return {
    image: out,
    info: {
      inputDims: [W, H],
      inputFrameDims: [fw, fh],
      outputDims: [tw * cols, sh * rows],
      targetFrameDims: [tw, sh]
    }
  };
};

// src/skill/normalize-factory.ts
var MARKER = "// @ts-nocheck";
var HEADER = `${MARKER}
// GENERATED by img2threejs, normalized by plugins/asset-pipeline/skills/image-to-threejs.
// Do not edit: re-run the generator, then normalize-factory.mjs. Consume it only
// through its exported factory functions, which are typed at the call site.
`;

// src/skill/zip.ts
var crcTable2 = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();
export {
  Bitmap,
  DEFAULT_SNAP_CONFIG,
  fail,
  failUsage,
  getFlag,
  getInt,
  getString,
  main,
  parseArgs,
  readImageSize,
  snapImage,
  snapSheet,
  snapWarning
};
