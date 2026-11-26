// GENERATED FILE — do not edit.
// Built from packages/asset-tools by `pnpm --filter @repo/asset-tools build`.
// Contains only the exports this skill's scripts import; edit the TypeScript
// source there and re-run `pnpm dogfood` (or that build) to regenerate.

// src/args.ts
import { readFileSync } from "node:fs";
var headerDoc = (entry) => {
  if (entry === void 0 || entry === "") {
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
    const scaled = (raw, whole) => {
      const n = raw.endsWith("%") ? Number(raw.slice(0, -1)) * whole / 100 : Number(raw);
      if (Number.isNaN(n)) {
        throw new TypeError(`Unrecognised colour: ${input}`);
      }
      return n;
    };
    const channel = (raw) => Math.max(0, Math.min(255, Math.round(scaled(raw, 255))));
    const alpha = rawAlpha === void 0 ? 255 : Math.max(0, Math.min(255, Math.round(scaled(rawAlpha, 1) * 255)));
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
    return [
      at(this.data, i),
      at(this.data, i + 1),
      at(this.data, i + 2),
      at(this.data, i + 3)
    ];
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

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/util.js
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
var EVALUATING = /* @__PURE__ */ Symbol("evaluating");
function defineLazy(object, key, getter) {
  let value = void 0;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) {
        return void 0;
      }
      if (value === void 0) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object, key, {
        value: v
        // configurable: true,
      });
    },
    configurable: true
  });
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {
};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === void 0)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== void 0) {
    if (params?.error !== void 0)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path2, issues) {
  return issues.map((iss) => {
    var _a2;
    (_a2 = iss).path ?? (_a2.path = []);
    iss.path.unshift(path2);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function sizeCaps(defChecks) {
  const caps = [];
  for (const ch of defChecks ?? []) {
    const d = ch._zod.def;
    if (!/_(length|size)$|_equals$/.test(d.check))
      break;
    const max = d.maximum ?? d.length ?? d.size;
    if (max >= 0)
      caps.push([max, ch]);
  }
  return caps;
}
function attachSchema(issues, start, inst) {
  var _a2;
  for (let i = start; i < issues.length; i++) {
    (_a2 = issues[i]).schema ?? (_a2.schema = inst);
  }
}
function finalizeIssue(iss, ctx, config2) {
  var _a2;
  const traits = iss.inst?._zod?.traits;
  if (traits?.has("$ZodType")) {
    if (traits.has("$ZodCheck"))
      (_a2 = iss).schema ?? (_a2.schema = iss.inst);
    else
      iss.schema = iss.inst;
  }
  const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : void 0;
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
  const full = {};
  for (const k of Object.keys(iss)) {
    if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__")
      continue;
    full[k] = iss[k];
  }
  full.path ?? (full.path = []);
  full.message = message;
  if (ctx?.reportInput) {
    full.input = iss.input;
  }
  return full;
}
function members(proto, table) {
  for (const key in table) {
    const desc = Object.getOwnPropertyDescriptor(table, key);
    if (desc.get)
      Object.defineProperty(proto, key, { ...desc, enumerable: false });
    else
      defineBound(proto, key, desc.value);
  }
}
function own(inst, key, value, enumerable = true) {
  Object.defineProperty(inst, key, { configurable: true, writable: true, enumerable, value });
  return value;
}
function hide(inst, key, value) {
  return own(inst, key, value, false);
}
function defineBound(proto, key, fn) {
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      return this == null ? fn : own(this, key, fn.bind(this));
    },
    set(value) {
      own(this, key, value);
    }
  });
}
var installing;
var broke = false;
var breaker = {
  configurable: true,
  get() {
    broke = true;
    return void 0;
  }
};
function defineLazyInternal(inst, key, compute) {
  const proto = Object.getPrototypeOf(inst._zod);
  if (key in proto && installing !== inst._zod) {
    installing = void 0;
    return;
  }
  installing = inst._zod;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      Object.defineProperty(this, key, breaker);
      const outer = broke;
      broke = false;
      try {
        const value = compute(this);
        if (broke)
          delete this[key];
        else
          Object.defineProperty(this, key, { configurable: true, writable: true, value });
        broke = broke || outer;
        return value;
      } catch (err) {
        delete this[key];
        broke = broke || outer;
        throw err;
      }
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, value });
    }
  });
}

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/core.js
var _a;
var _zodDesc = { value: void 0, enumerable: false };
var _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
  const E = _E;
  if (E) {
    const saved = E.stackTraceLimit;
    if (typeof saved === "number") {
      try {
        E.stackTraceLimit = 0;
      } catch {
        _E = null;
        return new Definition();
      }
      try {
        return new Definition();
      } finally {
        E.stackTraceLimit = saved;
      }
    }
  }
  return new Definition();
}
// @__NO_SIDE_EFFECTS__
function $constructor(name, initializer2, proto, params) {
  const zodProto = {};
  function Internals(def) {
    this.def = def;
    this.constr = _;
    this.traits = /* @__PURE__ */ new Set();
  }
  Internals.prototype = zodProto;
  const protoMembers = proto;
  const initialized = protoMembers && /* @__PURE__ */ new WeakSet();
  function init(inst, def) {
    if (!inst._zod) {
      _zodDesc.value = new Internals(def);
      try {
        Object.defineProperty(inst, "_zod", _zodDesc);
      } finally {
        _zodDesc.value = void 0;
      }
    } else if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer2(inst, def);
    if (initialized) {
      const own2 = Object.getPrototypeOf(inst);
      const ctorProto = inst._zod.constr.prototype;
      let up = own2;
      while (up && up !== ctorProto)
        up = Object.getPrototypeOf(up);
      const target = up ?? own2;
      if (!initialized.has(target)) {
        initialized.add(target);
        members(target, protoMembers);
      }
    }
    const proto2 = _.prototype;
    for (const k in proto2) {
      if (!Object.prototype.hasOwnProperty.call(proto2, k))
        continue;
      if (!(k in inst)) {
        inst[k] = proto2[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    const inst = params?.Parent ? newError(Definition) : this;
    init(inst, def);
    const deferred = inst._zod.deferred;
    if (deferred) {
      for (const fn of deferred) {
        fn();
      }
      inst._zod.deferred = void 0;
    }
    const pp = globalThis.__zod_globalConfig?.postProcessor;
    if (pp)
      pp(inst);
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
var $ZodAsyncError = class extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
};
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/errors.js
function _getMessage() {
  const internals = this._zod;
  internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
  return internals.message;
}
function _setMessage(value) {
  this._zod.message = value;
}
var _messageDesc = {
  get: _getMessage,
  set: _setMessage,
  enumerable: true,
  configurable: true
};
var _issuesDesc = { value: void 0, enumerable: false };
var _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  _issuesDesc.value = def;
  Object.defineProperty(inst, "issues", _issuesDesc);
  _issuesDesc.value = void 0;
  Object.defineProperty(inst, "message", _messageDesc);
  const proto = Object.getPrototypeOf(inst);
  if (!_installedToString.has(proto)) {
    _installedToString.add(proto);
    Object.defineProperty(proto, "toString", {
      configurable: true,
      enumerable: false,
      get() {
        const value = () => this.message;
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
        return value;
      },
      set(value) {
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
      }
    });
  }
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, void 0, {
  Parent: Error
});

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/parse.js
var _parse = (_Err) => {
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
    const result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise) {
      throw new $ZodAsyncError();
    }
    if (result.issues.length) {
      const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, _params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var parse = /* @__PURE__ */ _parse($ZodRealError);
var _parseAsync = (_Err) => {
  const fn = async (schema, value, _ctx, params) => {
    const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
    let result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise)
      result = await result;
    if (result.issues.length) {
      const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var parseAsync = /* @__PURE__ */ _parseAsync($ZodRealError);
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
function failure(Err, issues, ctx) {
  let error;
  return {
    success: false,
    get error() {
      if (!error) {
        error = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
        issues = void 0;
        ctx = void 0;
      }
      return error;
    },
    set error(e) {
      error = e;
      issues = void 0;
      ctx = void 0;
    }
  };
}
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/regexes.js
var anyString = /^[\s\S]{0,}$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;
var _null = /^null$/i;

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 6,
  patch: 7
};

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a2;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const defChecks = inst._zod.def.checks;
  const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a2 = inst._zod).deferred ?? (_a2.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks2, ctx) => {
      if (payload.memo)
        return payload;
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks2) {
        if (ch._zod.def.when) {
          if (explicitlyAborted(payload))
            continue;
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError();
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            attachSchema(payload.issues, currLen, inst);
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          attachSchema(payload.issues, currLen, inst);
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary2) => {
            return handleCanaryResult(canary2, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return result.then((result2) => runChecks(result2, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
}, {
  // Wrappers extend this by installing a richer factory over it; reading it eagerly would defeat the laziness.
  get "~standard"() {
    return hide(this, "~standard", standardProps(this));
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  }
});
var toStandardResult = (r, ctx) => r.issues.length ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) } : { value: r.value };
async function validateAsync(inst, value) {
  const ctx = { async: true };
  return toStandardResult(await inst._zod.run({ value, issues: [] }, ctx), ctx);
}
function standardProps(inst) {
  return {
    validate: (value) => {
      const ctx = { async: false };
      try {
        const r = inst._zod.run({ value, issues: [] }, ctx);
        if (!(r instanceof Promise))
          return toStandardResult(r, ctx);
      } catch (_) {
      }
      return validateAsync(inst, value);
    },
    vendor: "zod",
    version: 1
  };
}
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = def.pattern ?? anyString;
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_2) {
      }
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : void 0 : void 0;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _null;
  inst._zod.values = /* @__PURE__ */ new Set([null]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null)
      return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
function capSize(inst, size) {
  const caps = sizeCaps(inst._zod.def.checks);
  if (!caps.length)
    return;
  const cap = Math.min(...caps.map((c) => c[0]));
  const parse2 = inst._zod.parse;
  inst._zod.parse = (payload, ctx) => {
    const n = size(payload.value);
    if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
      for (const [max, ch] of sizeCaps(inst._zod.def.checks)) {
        if (n > max && ch._zod.def.when(payload)) {
          const start = payload.issues.length;
          ch._zod.check(payload);
          payload.issues[start].continue = false;
          attachSchema(payload.issues, start, inst);
          return payload;
        }
      }
    }
    return parse2(payload, ctx);
  };
}
var arraySize = (input) => Array.isArray(input) ? input.length : -1;
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
    const proms = [];
    const abortEarly = ctx?.abortEarly;
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
        if (abortEarly && result.issues.length !== 0 && aborted(result))
          break;
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
  capSize(inst, arraySize);
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== void 0) ? "optional" : void 0);
  defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
  defineLazyInternal(inst, "values", (zod) => {
    if (zod.def.options.every((o) => o._zod.values)) {
      return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return void 0;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    if (zod.def.options.every((o) => o._zod.pattern)) {
      const patterns = zod.def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return void 0;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleUnionResults(results2, payload, inst, ctx);
    });
  };
});
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    const values = def.keyType._zod.values;
    if (values && !def.partial) {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      const recordKeys = /* @__PURE__ */ new Set();
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          recordKeys.add(typeof key === "number" ? key.toString() : key);
          if (key === "__proto__")
            continue;
          const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
          if (keyResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (keyResult.issues.length) {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
            continue;
          }
          const outKey = keyResult.value;
          if (outKey === "__proto__")
            continue;
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result2) => {
              if (result2.issues.length) {
                payload.issues.push(...prefixIssues(key, result2.issues));
              }
              payload.value[outKey] = result2.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!recordKeys.has(key)) {
          if (def.mode === "loose") {
            if (key === "__proto__")
              continue;
            payload.value[key] = input[key];
          } else {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          }
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    } else {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      let unrecognized;
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        if (!Object.prototype.propertyIsEnumerable.call(input, key))
          continue;
        let keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        const checkNumericKey = typeof key === "string" && number.test(key) && keyResult.issues.length;
        if (checkNumericKey) {
          const retryResult = def.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
          if (retryResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (retryResult.issues.length === 0) {
            keyResult = retryResult;
          }
        }
        if (keyResult.issues.length) {
          if (def.mode === "loose") {
            payload.value[key] = input[key];
          } else if (values) {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          } else {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
          }
          continue;
        }
        const outKey = keyResult.value;
        if (outKey === "__proto__")
          continue;
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => {
            if (result2.issues.length) {
              payload.issues.push(...prefixIssues(key, result2.issues));
            }
            payload.value[outKey] = result2.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[outKey] = result.value;
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodLazy = /* @__PURE__ */ $constructor("$ZodLazy", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "innerType", () => {
    const d = def;
    if (!d._cachedInner)
      d._cachedInner = def.getter();
    return d._cachedInner;
  });
  defineLazyInternal(inst, "pattern", (zod) => zod.innerType?._zod?.pattern);
  defineLazyInternal(inst, "propValues", (zod) => zod.innerType?._zod?.propValues);
  defineLazyInternal(inst, "optin", (zod) => zod.innerType?._zod?.optin ?? void 0);
  defineLazyInternal(inst, "optout", (zod) => zod.innerType?._zod?.optout ?? void 0);
  inst._zod.parse = (payload, ctx) => {
    const inner = inst._zod.innerType;
    return inner._zod.run(payload, ctx);
  };
});

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/api.js
function snapshotChecks(def) {
  if (def.checks)
    def.checks = [...def.checks];
  return def;
}
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
  return new Class(snapshotChecks({ type: "string", ...normalizeParams(params) }));
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
  return new Class(snapshotChecks({ type: "number", checks: [], ...normalizeParams(params) }));
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _null2(Class, params) {
  return new Class({
    type: "null",
    ...normalizeParams(params)
  });
}

// ../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/mini/schemas.js
var ZodMiniType = /* @__PURE__ */ $constructor("ZodMiniType", (inst, def) => {
  if (!inst._zod)
    throw new Error("Uninitialized schema in ZodMiniType.");
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
}, {
  // `with` is an alias for `check`: the same function object, not a wrapper.
  get with() {
    return this.check;
  },
  set with(value) {
    own(this, "with", value);
  },
  parse(data, params) {
    return parse(this, data, params, { callee: this.parse });
  },
  parseAsync(data, params) {
    return parseAsync(this, data, params, { callee: this.parseAsync });
  },
  safeParse(data, params) {
    return safeParse(this, data, params);
  },
  safeParseAsync(data, params) {
    return safeParseAsync(this, data, params);
  },
  check(...checks) {
    const def = this.def;
    return this.clone({
      ...def,
      checks: [
        ...def.checks ?? [],
        ...checks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    }, { parent: true });
  },
  clone(_def, params) {
    return clone(this, _def, params);
  },
  brand() {
    return this;
  },
  register(reg, meta2) {
    reg.add(this, meta2);
    return this;
  },
  apply(fn, ...args) {
    return args.length === 0 ? fn(this) : fn(this, ...args);
  }
});
var ZodMiniString = /* @__PURE__ */ $constructor("ZodMiniString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function string2(params) {
  return _string(ZodMiniString, params);
}
var ZodMiniNumber = /* @__PURE__ */ $constructor("ZodMiniNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function number2(params) {
  return _number(ZodMiniNumber, params);
}
var ZodMiniBoolean = /* @__PURE__ */ $constructor("ZodMiniBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function boolean2(params) {
  return _boolean(ZodMiniBoolean, params);
}
var ZodMiniNull = /* @__PURE__ */ $constructor("ZodMiniNull", (inst, def) => {
  $ZodNull.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function _null3(params) {
  return _null2(ZodMiniNull, params);
}
var ZodMiniArray = /* @__PURE__ */ $constructor("ZodMiniArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function array(element, params) {
  return new ZodMiniArray({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
var ZodMiniUnion = /* @__PURE__ */ $constructor("ZodMiniUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function union(options, params) {
  return new ZodMiniUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
var ZodMiniRecord = /* @__PURE__ */ $constructor("ZodMiniRecord", (inst, def) => {
  $ZodRecord.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function record(keyType, valueType, params) {
  if (!valueType || !valueType._zod) {
    return new ZodMiniRecord({
      type: "record",
      keyType: /* @__PURE__ */ string2(),
      valueType: keyType,
      ...normalizeParams(valueType)
    });
  }
  return new ZodMiniRecord({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
var ZodMiniLazy = /* @__PURE__ */ $constructor("ZodMiniLazy", (inst, def) => {
  $ZodLazy.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function _lazy(getter) {
  return new ZodMiniLazy({
    type: "lazy",
    getter
  });
}
// @__NO_SIDE_EFFECTS__
function json() {
  const jsonSchema = /* @__PURE__ */ _lazy(() => {
    return /* @__PURE__ */ union([/* @__PURE__ */ string2(), /* @__PURE__ */ number2(), /* @__PURE__ */ boolean2(), /* @__PURE__ */ _null3(), /* @__PURE__ */ array(jsonSchema), /* @__PURE__ */ record(/* @__PURE__ */ string2(), jsonSchema)]);
  });
  return jsonSchema;
}

// src/asset/json.ts
var parseJsonText = (text) => {
  const value = json().parse(JSON.parse(text));
  return value;
};
var isJsonObject = (value) => Object(value) === value && !Array.isArray(value);
var isJsonString = (value) => Object.prototype.toString.call(value) === "[object String]";
var isFiniteJsonNumber = (value) => Number.isFinite(value);

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
// GENERATED by img2threejs, normalized by plugins/vibedgames/skills/image-to-threejs.
// Do not edit: re-run the generator, then normalize-factory.mjs. Consume it only
// through its exported factory functions, which are typed at the call site.
`;
export {
  Bitmap,
  fail,
  failUsage,
  getInt,
  getString,
  isFiniteJsonNumber,
  isJsonObject,
  isJsonString,
  main,
  parseArgs,
  parseColor,
  parseJsonText
};
