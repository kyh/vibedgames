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
var getAll = (args, key) => args.options.get(key) ?? [];
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

// src/image/color.ts
var NAMED = {
  aqua: [0, 255, 255],
  black: [0, 0, 0],
  blue: [0, 0, 255],
  brown: [165, 42, 42],
  cyan: [0, 255, 255],
  fuchsia: [255, 0, 255],
  gray: [128, 128, 128],
  green: [0, 128, 0],
  grey: [128, 128, 128],
  lime: [0, 255, 0],
  magenta: [255, 0, 255],
  maroon: [128, 0, 0],
  navy: [0, 0, 128],
  olive: [128, 128, 0],
  orange: [255, 165, 0],
  pink: [255, 192, 203],
  purple: [128, 0, 128],
  red: [255, 0, 0],
  silver: [192, 192, 192],
  teal: [0, 128, 128],
  transparent: [0, 0, 0],
  white: [255, 255, 255],
  yellow: [255, 255, 0]
};
var isNamedColor = (value) => Object.hasOwn(NAMED, value);
var expandHexDigit = (c) => Number.parseInt(c + c, 16);
var parseColor = (input) => {
  const value = input.trim().toLowerCase();
  if (value === "transparent") {
    return [0, 0, 0, 0];
  }
  if (isNamedColor(value)) {
    const named = NAMED[value];
    return [named[0], named[1], named[2], 255];
  }
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.test(hex)) {
      throw new Error(`Unrecognised colour: ${input}`);
    }
    if (hex.length === 3 || hex.length === 4) {
      const a = hex.length === 4 ? expandHexDigit(hex.charAt(3)) : 255;
      return [
        expandHexDigit(hex.charAt(0)),
        expandHexDigit(hex.charAt(1)),
        expandHexDigit(hex.charAt(2)),
        a
      ];
    }
    const byte = (i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return [byte(0), byte(1), byte(2), hex.length === 8 ? byte(3) : 255];
  }
  const body = /^rgba?\((?<body>[^)]+)\)$/u.exec(value)?.groups?.body;
  if (body !== void 0) {
    const [r, g, b, rawAlpha] = body.split(/[,/\s]+/u).filter(Boolean);
    if (r === void 0 || g === void 0 || b === void 0) {
      throw new Error(`Unrecognised colour: ${input}`);
    }
    const channel = (raw) => {
      const n = raw.endsWith("%") ? Number.parseFloat(raw) * 255 / 100 : Number.parseFloat(raw);
      if (Number.isNaN(n)) {
        throw new TypeError(`Unrecognised colour: ${input}`);
      }
      return Math.max(0, Math.min(255, Math.round(n)));
    };
    const alpha = rawAlpha === void 0 ? 255 : (
      // oxlint-disable-next-line unicorn/prefer-number-coercion -- CSS alpha may carry a `%` suffix, which Number() rejects
      Math.max(0, Math.min(255, Math.round(Number.parseFloat(rawAlpha) * 255)))
    );
    return [channel(r), channel(g), channel(b), alpha];
  }
  throw new Error(`Unrecognised colour: ${input}`);
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

// src/image/draw.ts
var put = (target, x, y, ink) => {
  if (!target.contains(x, y)) {
    return;
  }
  const i = target.index(x, y);
  const [r, g, b, a] = ink;
  target.data[i] = r;
  target.data[i + 1] = g;
  target.data[i + 2] = b;
  target.data[i + 3] = a;
};
var drawLine = (target, x0, y0, x1, y1, ink) => {
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
    if (x === endX && y === endY) {
      return;
    }
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
};
var fillRect = (target, x0, y0, x1, y1, ink) => {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      put(target, x, y, ink);
    }
  }
};
var strokeRect = (target, x0, y0, x1, y1, ink, width = 1) => {
  for (let i = 0; i < Math.max(1, width); i += 1) {
    const left = x0 + i;
    const top = y0 + i;
    const right = x1 - i;
    const bottom = y1 - i;
    if (left > right || top > bottom) {
      return;
    }
    drawLine(target, left, top, right, top, ink);
    drawLine(target, left, bottom, right, bottom, ink);
    drawLine(target, left, top, left, bottom, ink);
    drawLine(target, right, top, right, bottom, ink);
  }
};
var GLYPH_WIDTH = 6;
var GLYPH_HEIGHT = 12;
var GLYPH_DATA = "AAAAAAAAAAAAAAAAD7DEsA8AinIAc4gA1BoAG9MA6wIAAuoA6wIAAuoA1BoAG9MAinIAc4kAD7DEsA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCg8QAAAMNt8AAAABgA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGLD0EYAFcECKNcAKFUAC+oAAAAAX50AAAAj1BUAAAzMNwAAAa1ZAAAAYfTAwLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACqnAzUsAdnQAGeAAEQYARNsAAACj9UMAAAAAT6IAkwQAA+0AolQAPcYAHr/BuygAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASvcAAAANxvIAAACVVvAAADyvAPAAB8gaAPAAWtXAwPyiAAAAAPAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARd7AwIQAXWgAAAAAdk8AAAAAj5rEsiMAjmsAUr4AIAMAA+sAqE8AOr4AJcTAuCMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApLHwiIAaoUAUa4AxSQABnYA63LAryAA8VMAU70A2gMAA+sAmEEAQbwAFrO/uyMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqMDAxuwAAAAAZIIAAAABzxYAAABOmgAAAADBJwAAADexAAAAAK0+AAAAJMcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ8a/wzkA4CEAI9YAzTQANuEANfjT+EwAwVMAVZ4A7gIAA+wAxz0APMwAL8HBwDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIbnAtBcAu0MAQ5cA6wMAA9kAvVEAVPAAIa+/c+oAegYAJcQArlAAhWsAJMTHkwIAAAAAAAAAAAAAAAAA";
var glyphCache = null;
var glyphs = () => {
  glyphCache ??= new Uint8Array(Buffer.from(GLYPH_DATA, "base64"));
  return glyphCache;
};
var drawDigits = (target, x, y, text, ink) => {
  const data = glyphs();
  let cursor = x;
  for (const ch of text) {
    const digit = (ch.codePointAt(0) ?? 0) - 48;
    if (digit < 0 || digit > 9) {
      cursor += GLYPH_WIDTH;
      continue;
    }
    const base = digit * GLYPH_WIDTH * GLYPH_HEIGHT;
    for (let gy = 0; gy < GLYPH_HEIGHT; gy += 1) {
      for (let gx = 0; gx < GLYPH_WIDTH; gx += 1) {
        const coverage = data[base + gy * GLYPH_WIDTH + gx] ?? 0;
        if (coverage === 0) {
          continue;
        }
        const px = cursor + gx;
        const py = y + gy;
        if (!target.contains(px, py)) {
          continue;
        }
        const i = target.index(px, py);
        const m = coverage / 255;
        const transparent = target.data[i + 3] === 0;
        for (let c = 0; c < 3; c += 1) {
          const inkChannel = ink[c] ?? 0;
          target.data[i + c] = transparent ? inkChannel : Math.round((target.data[i + c] ?? 0) * (1 - m) + inkChannel * m);
        }
        target.data[i + 3] = Math.round((target.data[i + 3] ?? 0) * (1 - m) + ink[3] * m);
      }
    }
    cursor += GLYPH_WIDTH;
  }
};

// src/asset/lua.ts
var LuaParseError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "LuaParseError";
  }
};
var IDENT_START = /[A-Za-z_]/u;
var IDENT_BODY = /[A-Za-z0-9_]/u;
var punctuationOf = (ch) => {
  switch (ch) {
    case "{":
    case "}":
    case "[":
    case "]":
    case "=":
    case ",":
    case ";": {
      return ch;
    }
    default: {
      return null;
    }
  }
};
var isSpace = (ch) => ch !== "" && /\s/u.test(ch);
var isDigit = (ch) => ch >= "0" && ch <= "9";
var peek = (cur, n = 0) => cur.text.charAt(cur.i + n);
var skipTrivia = (cur) => {
  for (; ; ) {
    while (isSpace(peek(cur))) {
      cur.i += 1;
    }
    if (peek(cur) !== "-" || peek(cur, 1) !== "-") {
      return;
    }
    cur.i += 2;
    if (peek(cur) === "[" && peek(cur, 1) === "[") {
      cur.i += 2;
      const end = cur.text.indexOf("]]", cur.i);
      cur.i = end === -1 ? cur.text.length : end + 2;
    } else {
      while (peek(cur) !== "" && peek(cur) !== "\n") {
        cur.i += 1;
      }
    }
  }
};
var ESCAPES = /* @__PURE__ */ new Map([
  ["n", "\n"],
  ["t", "	"],
  ["r", "\r"],
  ['"', '"'],
  ["'", "'"],
  ["\\", "\\"]
]);
var readString = (cur) => {
  const quote = peek(cur);
  cur.i += 1;
  const out = [];
  for (; ; ) {
    const c = peek(cur);
    if (c === "") {
      throw new LuaParseError("Unterminated string");
    }
    if (c === quote) {
      cur.i += 1;
      return out.join("");
    }
    if (c === "\\") {
      cur.i += 1;
      const esc = peek(cur);
      out.push(ESCAPES.get(esc) ?? `\\${esc}`);
      if (esc !== "") {
        cur.i += 1;
      }
      continue;
    }
    out.push(c);
    cur.i += 1;
  }
};
var readWhile = (cur, from, accept) => {
  let j = from;
  while (j < cur.text.length && accept(cur.text.charAt(j))) {
    j += 1;
  }
  const value = cur.text.slice(cur.i, j);
  cur.i = j;
  return value;
};
var tokenize = (text) => {
  const tokens = [];
  const cur = { i: 0, text };
  for (; ; ) {
    skipTrivia(cur);
    if (cur.i >= text.length) {
      tokens.push({ pos: cur.i, type: "eof", value: "" });
      return tokens;
    }
    const ch = peek(cur);
    const pos = cur.i;
    const punctuation = punctuationOf(ch);
    if (punctuation !== null) {
      tokens.push({ pos, type: punctuation, value: punctuation });
      cur.i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      tokens.push({ pos, type: "string", value: readString(cur) });
      continue;
    }
    if (isDigit(ch) || ch === "-" && isDigit(peek(cur, 1))) {
      const from = ch === "-" ? cur.i + 1 : cur.i;
      const value = readWhile(cur, from, (c) => isDigit(c) || c === ".");
      tokens.push({ pos, type: "number", value });
      continue;
    }
    if (IDENT_START.test(ch)) {
      const value = readWhile(cur, cur.i + 1, (c) => IDENT_BODY.test(c));
      tokens.push({ pos, type: "ident", value });
      continue;
    }
    throw new LuaParseError(`Unexpected character at ${pos}: '${ch}'`);
  }
};
var numberTokenValue = (raw) => (
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- a token like `1.2.3` must read its leading number, not NaN
  raw.includes(".") ? Number.parseFloat(raw) : Number.parseInt(raw, 10)
);
var parseLua = (text) => {
  const tokens = tokenize(text);
  let k = 0;
  const EOF = { pos: text.length, type: "eof", value: "" };
  const cur = () => tokens[k] ?? EOF;
  const peekToken = (n = 1) => tokens[Math.min(k + n, tokens.length - 1)] ?? EOF;
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
    if (token.type === "{") {
      return parseTable();
    }
    if (token.type === "string") {
      eat("string");
      return token.value;
    }
    if (token.type === "number") {
      eat("number");
      return numberTokenValue(token.value);
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
      if (cur().type === "ident" && peekToken().type === "=") {
        const key = eat("ident").value;
        eat("=");
        items.push([{ kind: "name", name: key }, parseValue()]);
      } else if (cur().type === "[") {
        eat("[");
        const keyToken = cur();
        parseValue();
        eat("]");
        eat("=");
        if (keyToken.type === "string") {
          items.push([{ kind: "name", name: keyToken.value }, parseValue()]);
        } else if (keyToken.type === "number") {
          items.push([{ index: numberTokenValue(keyToken.value), kind: "index" }, parseValue()]);
        } else {
          throw new LuaParseError("Only string/int table keys are supported");
        }
      } else {
        items.push([{ index: arrayIndex, kind: "index" }, parseValue()]);
        arrayIndex += 1;
      }
      if (cur().type === "," || cur().type === ";") {
        eat();
      }
    }
    eat("}");
    const numeric = [];
    for (const [key] of items) {
      if (key.kind === "index") {
        numeric.push(key.index);
      }
    }
    if (items.length > 0 && numeric.length === items.length) {
      const max = Math.max(...numeric);
      const dense = new Set(numeric).size === numeric.length && max === numeric.length;
      if (dense) {
        const out2 = Array.from({ length: max }, () => null);
        for (const [key, value2] of items) {
          if (key.kind === "index") {
            out2[key.index - 1] = value2;
          }
        }
        return out2;
      }
    }
    const out = {};
    for (const [key, value2] of items) {
      out[key.kind === "index" ? String(key.index) : key.name] = value2;
    }
    return out;
  };
  if (cur().type === "ident" && cur().value === "return") {
    eat("ident");
  }
  const value = parseValue();
  if (cur().type !== "eof") {
    throw new LuaParseError(`Trailing tokens at ${cur().pos}`);
  }
  return value;
};

// src/asset/tilemap-server.ts
import { randomUUID } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { createServer } from "node:http";
import path3 from "node:path";

// src/asset/json.ts
var parseJsonText = (text) => JSON.parse(text);
var isJsonObject = (value) => Object(value) === value && !Array.isArray(value);
var isJsonString = (value) => String(value) === value;
var isFiniteJsonNumber = (value) => Number.isFinite(value);

// src/asset/tilemap.ts
import { existsSync, readFileSync as readFileSync3 } from "node:fs";
import path2 from "node:path";
var MANIFEST_JSON_CANDIDATES = [
  "assets_index.json",
  "asset_index.json",
  "assets/assets_index.json",
  "assets/asset_index.json"
];
var asInt = (value, fallback) => isFiniteJsonNumber(value) ? Math.trunc(value) : fallback;
var loadManifestJson = (manifestPath) => {
  const payload = parseJsonText(readFileSync3(manifestPath, "utf-8"));
  if (!isJsonObject(payload)) {
    throw new Error("Manifest JSON must be an object at top-level.");
  }
  return payload;
};
var sanitizeTilesets = (manifest) => {
  const { tilesets } = manifest;
  if (!isJsonObject(tilesets)) {
    throw new Error("Manifest missing `tilesets` object.");
  }
  const out = {};
  for (const [name, entry] of Object.entries(tilesets)) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const { path: tilesetPath } = entry;
    if (!isJsonString(tilesetPath)) {
      continue;
    }
    out[name] = { ...entry, path: tilesetPath };
  }
  if (Object.keys(out).length === 0) {
    throw new Error("Manifest has no usable tilesets (each needs a string `path`).");
  }
  return out;
};
var resolveAssetPath = (manifestPath, manifest, rel) => {
  const manifestDir = path2.resolve(path2.dirname(manifestPath));
  const { meta } = manifest;
  const root = isJsonObject(meta) && isJsonString(meta.root) ? meta.root : null;
  const base = root === null ? manifestDir : path2.resolve(manifestDir, root);
  if (path2.isAbsolute(rel)) {
    return path2.resolve(rel);
  }
  const preferred = path2.resolve(base, rel);
  const candidates = [preferred, path2.resolve(manifestDir, rel), path2.resolve(process.cwd(), rel)];
  return candidates.find((c) => existsSync(c)) ?? preferred;
};
var tilesetMetaFromManifest = (manifestPath, manifest, name) => {
  const tilesets = sanitizeTilesets(manifest);
  const entry = tilesets[name];
  if (!entry) {
    throw new Error(`Tileset not found in manifest: ${name}`);
  }
  const assetPath = resolveAssetPath(manifestPath, manifest, entry.path);
  if (!existsSync(assetPath)) {
    throw new Error(`Tileset file not found: ${path2}`);
  }
  const tileW = asInt(entry.tileWidth ?? entry.tileW, 16);
  const tileH = asInt(entry.tileHeight ?? entry.tileH, 16);
  const margin = asInt(entry.margin, 0);
  const spacing = asInt(entry.spacing, 0);
  const size = readImageSize(assetPath);
  if (!size) {
    throw new Error(`Could not read tileset dimensions: ${assetPath}`);
  }
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
    columns,
    imageH: size.height,
    imageW: size.width,
    margin,
    name,
    path: assetPath,
    rows,
    spacing,
    tileH,
    tileW
  };
};
var tileCount = (meta) => meta.columns * meta.rows;
var tileIdFromColRow = (meta, col, row) => {
  if (col < 0 || row < 0 || col >= meta.columns || row >= meta.rows) {
    return 0;
  }
  return row * meta.columns + col + 1;
};
var colRowFromTileId = (meta, tileId) => {
  if (tileId <= 0) {
    return [0, 0];
  }
  const index = tileId - 1;
  const row = Math.floor(index / meta.columns);
  return [index - row * meta.columns, row];
};
var cropBox = (meta, tileId) => {
  const [col, row] = colRowFromTileId(meta, tileId);
  const left = meta.margin + col * (meta.tileW + meta.spacing);
  const top = meta.margin + row * (meta.tileH + meta.spacing);
  return { bottom: top + meta.tileH, left, right: left + meta.tileW, top };
};
var trimTransparent = (image) => {
  const bbox = image.getBBox();
  return bbox ? image.crop(bbox) : image;
};
var exportTilesetGrid = (meta, outPath, options) => {
  const scale = Math.max(1, Math.trunc(options.scale));
  let image = Bitmap.fromFile(meta.path);
  if (scale !== 1) {
    image = image.resize(image.width * scale, image.height * scale, "nearest");
  }
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
};
var newMap = (width, height) => Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
var normalizeMapData = (data, width, height) => {
  const rows = Array.isArray(data) ? data : [];
  const out = newMap(width, height);
  for (const [y, outRow] of out.entries()) {
    const row = rows[y];
    if (!Array.isArray(row)) {
      continue;
    }
    for (let x = 0; x < width; x += 1) {
      const cell = row[x];
      outRow[x] = isFiniteJsonNumber(cell) ? Math.trunc(cell) : 0;
    }
  }
  return out;
};
var exportMapRender = (meta, outPath, options) => {
  const scale = Math.max(1, Math.trunc(options.scale));
  const { data } = options.mapPayload;
  if (!Array.isArray(data)) {
    throw new TypeError("Map JSON must have `data` as a 2D array.");
  }
  const mapMeta = options.mapPayload.meta;
  let width = isJsonObject(mapMeta) ? asInt(mapMeta.width, 0) : 0;
  let height = isJsonObject(mapMeta) ? asInt(mapMeta.height, 0) : 0;
  if (width <= 0) {
    for (const row of data) {
      if (Array.isArray(row)) {
        width = Math.max(width, row.length);
      }
    }
  }
  if (height <= 0) {
    height = data.length;
  }
  if (width <= 0 || height <= 0) {
    throw new Error("Invalid map dimensions.");
  }
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
      const id = grid[y]?.[x] ?? 0;
      if (id <= 0) {
        continue;
      }
      out.alphaComposite(sheet.crop(cropBox(meta, id)), x * meta.tileW, y * meta.tileH);
    }
  }
  if (scale !== 1) {
    out = out.resize(out.width * scale, out.height * scale, "nearest");
  }
  (options.trim ? trimTransparent(out) : out).toFile(outPath);
};
var nonEmptyTileIds = (meta) => {
  const image = Bitmap.fromFile(meta.path);
  const out = /* @__PURE__ */ new Set();
  for (let id = 1; id <= tileCount(meta); id += 1) {
    if (image.crop(cropBox(meta, id)).getBBox()) {
      out.add(id);
    }
  }
  return out;
};
var MAP_MIN = 1;
var MAP_MAX = 512;
var tilemapPayload = (meta, width, height, data) => ({
  data,
  meta: {
    height,
    tileHeight: meta.tileH,
    tileWidth: meta.tileW,
    tileset: meta.name,
    version: 1,
    width
  }
});
var parseTilemap = (payload, fallback) => {
  if (!isJsonObject(payload)) {
    throw new Error("Map JSON must be an object.");
  }
  const { meta } = payload;
  if (!isJsonObject(meta) || !Array.isArray(payload.data)) {
    throw new Error("Map JSON must have a `meta` object and a `data` array.");
  }
  const clamp = (value) => Math.max(MAP_MIN, Math.min(MAP_MAX, value));
  const width = clamp(asInt(meta.width, fallback.width));
  const height = clamp(asInt(meta.height, fallback.height));
  return {
    data: normalizeMapData(payload.data, width, height),
    height,
    tileset: isJsonString(meta.tileset) ? meta.tileset : null,
    width
  };
};
var makeSelftestMap = (meta) => {
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
    data,
    meta: {
      generatedFrom: meta.path.split(/[/\\]/u).join("/"),
      generator: "asset-tilemap-editor.mjs --make-selftest-map",
      height: meta.rows,
      tileHeight: meta.tileH,
      tileWidth: meta.tileW,
      tileset: meta.name,
      version: 1,
      width: meta.columns
    }
  };
};

// src/asset/tilemap-server.ts
var DEFAULT_MAP_WIDTH = 64;
var DEFAULT_MAP_HEIGHT = 36;
var CONTENT_TYPES = /* @__PURE__ */ new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"]
]);
var isInside = (root, candidate) => {
  const rel = path3.relative(path3.resolve(root), path3.resolve(candidate));
  return rel === "" || !rel.startsWith("..") && !path3.isAbsolute(rel);
};
var sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8"
  });
  res.end(payload);
};
var readBody = (req, limitBytes = 8 * 1024 * 1024) => (
  // oxlint-disable-next-line promise/avoid-new -- wraps the stream's event callbacks
  new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk2) => {
      total += chunk2.length;
      if (total > limitBytes) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk2);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  })
);
var tilesetSummary = (meta) => ({
  columns: meta.columns,
  imageHeight: meta.imageH,
  imageWidth: meta.imageW,
  margin: meta.margin,
  name: meta.name,
  path: meta.path,
  rows: meta.rows,
  spacing: meta.spacing,
  tileHeight: meta.tileH,
  tileWidth: meta.tileW
});
var createTilemapEditor = (options) => {
  const token = randomUUID();
  const manifestPath = path3.resolve(options.manifestPath);
  const writeRoot = path3.resolve(options.writeRoot);
  const readTilesets = () => {
    const manifest = loadManifestJson(manifestPath);
    return { manifest, tilesets: sanitizeTilesets(manifest) };
  };
  const metaFor = (name) => {
    const { manifest, tilesets } = readTilesets();
    if (!(name in tilesets)) {
      throw new Error(`No such tileset: ${name}`);
    }
    return tilesetMetaFromManifest(manifestPath, manifest, name);
  };
  const resolveWritable = (raw) => {
    const target = path3.resolve(writeRoot, raw);
    if (!isInside(writeRoot, target)) {
      throw new Error(`Refusing to touch a path outside ${writeRoot}: ${raw}`);
    }
    return target;
  };
  const handlers = /* @__PURE__ */ new Map([
    [
      "/api/state",
      () => {
        const { tilesets } = readTilesets();
        const names = Object.keys(tilesets).toSorted();
        const [first] = names;
        if (first === void 0) {
          throw new Error("Manifest has no tilesets.");
        }
        const selected = options.tileset && names.includes(options.tileset) ? options.tileset : first;
        const map = options.mapPath && existsSync2(options.mapPath) ? parseTilemap(parseJsonText(readFileSync4(options.mapPath, "utf-8")), {
          height: DEFAULT_MAP_HEIGHT,
          width: DEFAULT_MAP_WIDTH
        }) : {
          data: newMap(DEFAULT_MAP_WIDTH, DEFAULT_MAP_HEIGHT),
          height: DEFAULT_MAP_HEIGHT,
          tileset: null,
          width: DEFAULT_MAP_WIDTH
        };
        const initial = map.tileset && names.includes(map.tileset) ? map.tileset : selected;
        return {
          manifestPath,
          map,
          mapPath: options.mapPath ?? null,
          tileset: tilesetSummary(metaFor(initial)),
          tilesetNames: names,
          writeRoot
        };
      }
    ],
    [
      "/api/tileset",
      (url) => {
        const name = url.searchParams.get("name");
        if (!name) {
          throw new Error("name is required");
        }
        return tilesetSummary(metaFor(name));
      }
    ],
    [
      "/api/load",
      (url) => {
        const rawPath = url.searchParams.get("path");
        if (!rawPath) {
          throw new Error("path is required");
        }
        const target = resolveWritable(rawPath);
        if (!existsSync2(target)) {
          throw new Error(`Map not found: ${rawPath}`);
        }
        return {
          path: target,
          ...parseTilemap(parseJsonText(readFileSync4(target, "utf-8")), {
            height: DEFAULT_MAP_HEIGHT,
            width: DEFAULT_MAP_WIDTH
          })
        };
      }
    ],
    [
      "/api/save",
      async (url, req) => {
        const body = parseJsonText(await readBody(req));
        if (!isJsonObject(body)) {
          throw new Error("Body must be an object.");
        }
        const raw = isJsonString(body.path) && body.path ? body.path : options.mapPath;
        if (!raw) {
          throw new Error("No path given and no --map to fall back on.");
        }
        const target = resolveWritable(raw);
        if (!isJsonString(body.tileset)) {
          throw new Error("tileset is required");
        }
        const meta = metaFor(body.tileset);
        const parsed = parseTilemap(
          {
            data: body.data ?? null,
            meta: { height: body.height ?? null, width: body.width ?? null }
          },
          { height: DEFAULT_MAP_HEIGHT, width: DEFAULT_MAP_WIDTH }
        );
        mkdirSync2(path3.dirname(target), { recursive: true });
        writeFileSync2(
          target,
          `${JSON.stringify(tilemapPayload(meta, parsed.width, parsed.height, parsed.data), null, 2)}
`
        );
        return { height: parsed.height, path: target, width: parsed.width };
      }
    ]
  ]);
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
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8"
        });
        res.end(options.html);
        return;
      }
      if (url.pathname === "/api/sheet") {
        try {
          const name = url.searchParams.get("name");
          if (!name) {
            throw new Error("name is required");
          }
          const meta = metaFor(name);
          const bytes = readFileSync4(meta.path);
          res.writeHead(200, {
            "cache-control": "no-store",
            "content-length": bytes.length,
            "content-type": CONTENT_TYPES.get(path3.extname(meta.path).toLowerCase()) ?? "image/png"
          });
          res.end(bytes);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      const handler = handlers.get(url.pathname);
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
};

// src/asset/manifest.ts
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "node:fs";
import path5 from "node:path";

// src/asset/paths.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readdirSync, statSync, writeFileSync as writeFileSync3 } from "node:fs";
import path4 from "node:path";
var parseFrame = (text) => {
  const groups = /^(?<width>\d+)\s*x\s*(?<height>\d+)$/iu.exec(text.trim())?.groups;
  if (!groups) {
    throw new Error(`frame must be WxH, e.g. 32x32 (got "${text}")`);
  }
  const width = Number(groups.width);
  const height = Number(groups.height);
  if (width <= 0 || height <= 0) {
    throw new Error(`frame dimensions must be positive: ${text}`);
  }
  return { height, width };
};
var compareStrings = (a, b) => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};
var walkFiles = (root, extension = ".png") => {
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
      const full = path4.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.name.toLowerCase().endsWith(suffix)) {
        out.push(full);
      }
    }
  };
  visit(root);
  return out.toSorted(compareStrings);
};
var resolveTargets = (target, extension = ".png") => {
  if (!existsSync3(target)) {
    throw new Error(`Path not found: ${target}`);
  }
  return statSync(target).isFile() ? [target] : walkFiles(target, extension);
};
var defaultRoot = (explicit) => {
  if (explicit) {
    return explicit;
  }
  return existsSync3("assets") ? "assets" : ".";
};
var prettyPath = (target) => {
  const rel = path4.relative(process.cwd(), path4.resolve(target));
  return rel && !rel.startsWith(`..${path4.sep}`) && rel !== ".." ? rel : path4.resolve(target);
};
var toPythonJson = (payload) => JSON.stringify(payload, null, 2).replaceAll(
  /[\u007F-\u{10FFFF}]/gu,
  (ch) => (
    // Escape per UTF-16 unit: an astral character becomes its surrogate pair,
    // as Python writes it.
    [...ch].map((unit) => `\\u${(unit.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`).join("")
  )
);
var writeJsonFile = (target, payload) => {
  mkdirSync3(path4.dirname(path4.resolve(target)), { recursive: true });
  writeFileSync3(target, `${toPythonJson(payload)}
`);
};
var writeTextFile = (target, contents) => {
  mkdirSync3(path4.dirname(path4.resolve(target)), { recursive: true });
  writeFileSync3(target, contents);
};

// src/asset/manifest.ts
var MANIFEST_CANDIDATES = [
  "assets_index.lua",
  "asset_index.lua",
  "assets/assets_index.lua",
  "assets/asset_index.lua"
];
var LUA_PATH_RE = /path\s*=\s*"(?<file>[^"]+\.png)"/gu;
var LUA_META_ROOT_RE = /meta\s*=\s*\{[^}]*\broot\s*=\s*"(?<root>[^"]*)"/u;
var resolveManifestPath = (raw, manifestDir, root) => {
  if (path5.isAbsolute(raw)) {
    return path5.resolve(raw);
  }
  return root ? path5.resolve(manifestDir, root, raw) : path5.resolve(manifestDir, raw);
};
var metaRootOf = (payload) => {
  if (!isJsonObject(payload)) {
    return null;
  }
  const { meta } = payload;
  if (!isJsonObject(meta)) {
    return null;
  }
  const { root } = meta;
  return isJsonString(root) && root ? root : null;
};
var collectJsonPaths = (payload) => {
  const paths = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (!isJsonObject(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "path" && isJsonString(value) && value.toLowerCase().endsWith(".png")) {
        paths.push(value);
      } else {
        visit(value);
      }
    }
  };
  visit(payload);
  return paths;
};
var extractManifestPaths = (manifestPath) => {
  const manifestDir = path5.resolve(path5.dirname(manifestPath));
  if (manifestPath.toLowerCase().endsWith(".json")) {
    const payload = parseJsonText(readFileSync5(manifestPath, "utf-8"));
    if (!isJsonObject(payload)) {
      throw new Error("JSON manifest must be an object at top-level.");
    }
    const jsonRoot = metaRootOf(payload);
    return new Set(
      collectJsonPaths(payload).map((p) => resolveManifestPath(p, manifestDir, jsonRoot))
    );
  }
  const text = readFileSync5(manifestPath, "utf-8");
  const luaRoot = LUA_META_ROOT_RE.exec(text)?.groups?.root ?? null;
  const out = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(LUA_PATH_RE)) {
    out.add(resolveManifestPath(match.groups?.file ?? "", manifestDir, luaRoot));
  }
  return out;
};
var checkManifest = (manifestPath, root) => {
  const manifestPaths = extractManifestPaths(manifestPath);
  const actualPaths = new Set(walkFiles(root, ".png").map((p) => path5.resolve(p)));
  const missing = [...actualPaths].filter((p) => !manifestPaths.has(p)).map(prettyPath);
  const extra = [...manifestPaths].filter((p) => !actualPaths.has(p)).map(prettyPath);
  return {
    actual_pngs: actualPaths.size,
    extra: extra.toSorted(compareStrings),
    manifest_paths: manifestPaths.size,
    missing: missing.toSorted(compareStrings)
  };
};
var autoDetectManifest = () => MANIFEST_CANDIDATES.find((p) => existsSync4(p)) ?? null;
var KEY_RENAMES = /* @__PURE__ */ new Map([
  ["w", "width"],
  ["h", "height"],
  ["tileW", "tileWidth"],
  ["tileH", "tileHeight"],
  ["frameW", "frameWidth"],
  ["frameH", "frameHeight"]
]);
var renameTableKeys = (table) => {
  const out = {};
  for (const [key, nested] of Object.entries(table)) {
    out[KEY_RENAMES.get(key) ?? key] = renameKeys(nested);
  }
  return out;
};
var renameKeys = (value) => {
  if (Array.isArray(value)) {
    return value.map(renameKeys);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  return renameTableKeys(value);
};
var rewriteTablePaths = (base, sourceRoot, table) => {
  const out = {};
  for (const [key, nested] of Object.entries(table)) {
    if (key === "path" && isJsonString(nested) && nested.toLowerCase().endsWith(".png")) {
      const absolute = path5.isAbsolute(nested) ? path5.resolve(nested) : path5.resolve(sourceRoot, nested);
      const rel = path5.relative(path5.resolve(base), absolute);
      out[key] = rel ? rel.split(/[/\\]/u).join("/") : nested;
    } else {
      out[key] = rewritePaths(base, sourceRoot, nested);
    }
  }
  return out;
};
var rewritePaths = (base, sourceRoot, value) => {
  if (Array.isArray(value)) {
    return value.map((item) => rewritePaths(base, sourceRoot, item));
  }
  if (!isJsonObject(value)) {
    return value;
  }
  return rewriteTablePaths(base, sourceRoot, value);
};
var exportManifest = (manifestPath, packRelative, outPath) => {
  if (manifestPath.toLowerCase().endsWith(".json")) {
    const payload = parseJsonText(readFileSync5(manifestPath, "utf-8"));
    if (!isJsonObject(payload)) {
      throw new Error("JSON manifest must be an object at top-level.");
    }
    return payload;
  }
  const parsed = parseLua(readFileSync5(manifestPath, "utf-8"));
  if (!isJsonObject(parsed)) {
    throw new Error("Lua manifest must return a table/object.");
  }
  let normalized = renameTableKeys(parsed);
  if (packRelative) {
    const manifestDir = path5.resolve(path5.dirname(manifestPath));
    const sourceRoot = path5.resolve(manifestDir, metaRootOf(normalized) ?? ".");
    const base = outPath ? path5.resolve(path5.dirname(outPath)) : manifestDir;
    normalized = rewriteTablePaths(base, sourceRoot, normalized);
    const { meta } = normalized;
    if (isJsonObject(meta)) {
      meta.root = ".";
    } else {
      normalized.meta = { root: "." };
    }
  }
  return normalized;
};

// src/pymath.ts
var roundHalfToEven = (value) => {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) {
    return floor + 1;
  }
  if (diff < 0.5) {
    return floor;
  }
  return floor % 2 === 0 ? floor : floor + 1;
};

// src/asset/sheet.ts
var gridFor = (path6, size, frame) => {
  if (size.width % frame.width !== 0 || size.height % frame.height !== 0) {
    throw new Error(
      `${path6} size ${size.width}x${size.height} not divisible by ${frame.width}x${frame.height}`
    );
  }
  return { columns: size.width / frame.width, rows: size.height / frame.height };
};
var byColumnThenRow = (a, b) => a[0] - b[0] || a[1] - b[1];
var probeSheet = (path6, frame, includeEmpty) => {
  const image = Bitmap.fromFile(path6);
  const { columns, rows } = gridFor(path6, image, frame);
  const nonEmpty = [];
  const empty = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const cell = image.crop({
        bottom: (row + 1) * frame.height,
        left: col * frame.width,
        right: (col + 1) * frame.width,
        top: row * frame.height
      });
      if (cell.getBBox()) {
        nonEmpty.push([col, row]);
      } else {
        empty.push([col, row]);
      }
    }
  }
  const result = {
    empty_count: empty.length,
    frame: { h: frame.height, w: frame.width },
    grid: { columns, rows },
    non_empty: [...nonEmpty].toSorted(byColumnThenRow),
    path: path6
  };
  if (includeEmpty) {
    result.empty = empty;
  }
  return result;
};
var analyzeBaseline = (path6, frame, targetBottom, targetCenterX, outPath) => {
  const image = Bitmap.fromFile(path6);
  const { columns, rows } = gridFor(path6, image, frame);
  const fixed = outPath ? Bitmap.create(image.width, image.height) : null;
  const frames = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const left = col * frame.width;
      const top = row * frame.height;
      const cell = image.crop({
        bottom: top + frame.height,
        left,
        right: left + frame.width,
        top
      });
      const bbox = cell.getBBox();
      const index = row * columns + col;
      if (!bbox) {
        frames.push({ col, empty: true, index, row });
        if (fixed) {
          fixed.alphaComposite(cell, left, top);
        }
        continue;
      }
      const bottomY = bbox.bottom - 1;
      const centerX = (bbox.left + bbox.right - 1) / 2;
      const shiftY = targetBottom - bottomY;
      const shiftX = targetCenterX === null ? 0 : roundHalfToEven(targetCenterX - centerX);
      frames.push({
        alphaBBox: [bbox.left, bbox.top, bbox.right, bbox.bottom],
        col,
        empty: false,
        index,
        row,
        shiftToTarget: [shiftX, shiftY],
        visibleBottomY: bottomY,
        visibleCenterX: centerX
      });
      if (fixed) {
        const shifted = Bitmap.create(frame.width, frame.height);
        shifted.pasteMasked(cell, shiftX, shiftY, cell.channel(3));
        fixed.alphaComposite(shifted, left, top);
      }
    }
  }
  if (fixed && outPath) {
    fixed.toFile(outPath);
  }
  const visible = frames.filter((f) => !f.empty);
  const bottoms = visible.flatMap(
    (f) => f.visibleBottomY === void 0 ? [] : [f.visibleBottomY]
  );
  const shifts = visible.flatMap(
    (f) => f.shiftToTarget === void 0 ? [] : [f.shiftToTarget[1]]
  );
  return {
    frame: { height: frame.height, width: frame.width },
    frames,
    grid: { columns, rows },
    out: outPath,
    path: path6,
    shiftYRange: shifts.length ? [Math.min(...shifts), Math.max(...shifts)] : null,
    size: { height: image.height, width: image.width },
    targetBottomY: targetBottom,
    targetCenterX,
    visibleBottomYRange: bottoms.length ? [Math.min(...bottoms), Math.max(...bottoms)] : null
  };
};

// src/asset/sizes.ts
var collectSizes = (root) => {
  const rows = [];
  for (const path6 of walkFiles(root, ".png")) {
    const size = readImageSize(path6);
    if (!size) {
      throw new Error(`Could not read image dimensions: ${path6}`);
    }
    rows.push({ height: size.height, path: path6, width: size.width });
  }
  return rows;
};
var escapeCsv = (value) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
var sizesToCsv = (rows) => {
  const lines = ["width,height,path"];
  for (const row of rows) {
    lines.push(`${row.width},${row.height},${escapeCsv(row.path)}`);
  }
  return `${lines.join("\n")}
`;
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
  failUsage,
  getAll,
  getFlag,
  getInt,
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
