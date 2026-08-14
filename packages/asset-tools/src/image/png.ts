import { deflateSync, inflateSync } from "node:zlib";

/**
 * Pure-TypeScript PNG codec built on `node:zlib`.
 *
 * The asset-pipeline skills used to shell out to Python + Pillow for every
 * pixel operation, which meant an agent needed `uv` (or a system Python with
 * Pillow) before it could touch a sprite. PNG is the only format those scripts
 * actually decoded, and `zlib` ships with Node, so decoding it here costs no
 * dependency at all — `vg` stays a plain `npm install`.
 *
 * Decoding covers everything the spec allows for still images: colour types
 * 0/2/3/4/6, bit depths 1/2/4/8/16, `tRNS` transparency, and Adam7 interlace.
 * Everything is normalised to 8-bit RGBA on the way out, so callers only ever
 * see one pixel layout. Encoding always emits non-interlaced 8-bit RGBA
 * (colour type 6) — the asset pipeline has no use for the other permutations
 * and a single output path is one less thing to get subtly wrong.
 */

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Adam7 interlace pass geometry: x/y origin and x/y stride per pass. */
const ADAM7 = [
  { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
  { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
  { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
  { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
  { xStart: 0, yStart: 1, xStep: 1, yStep: 2 },
] as const;

/** Channel count per PNG colour type, indexed by the colour type itself. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export type DecodedPng = {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel, straight (non-premultiplied) alpha. */
  data: Uint8Array;
};

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Undo one scanline's filter in place. `line` is the current (still filtered)
 * scanline, `prev` the already-reconstructed line above it, and `bpp` the
 * byte distance to the pixel on the left — clamped to 1 for sub-byte depths,
 * where filtering operates on bytes rather than pixels.
 */
function unfilter(type: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
  const len = line.length;
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < len; i += 1) line[i] = (line[i]! + line[i - bpp]!) & 0xff;
      return;
    case 2:
      for (let i = 0; i < len; i += 1) line[i] = (line[i]! + prev[i]!) & 0xff;
      return;
    case 3:
      for (let i = 0; i < len; i += 1) {
        const left = i >= bpp ? line[i - bpp]! : 0;
        line[i] = (line[i]! + ((left + prev[i]!) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < len; i += 1) {
        const a = i >= bpp ? line[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i]! + pred) & 0xff;
      }
      return;
    default:
      throw new Error(`PNG: unknown filter type ${type}`);
  }
}

/** Read the `index`-th sample of `bitDepth` bits from a packed scanline. */
function sampleAt(line: Uint8Array, index: number, bitDepth: number): number {
  if (bitDepth === 8) return line[index]!;
  if (bitDepth === 16) return (line[index * 2]! << 8) | line[index * 2 + 1]!;
  const perByte = 8 / bitDepth;
  const byte = line[Math.floor(index / perByte)]!;
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

/** Scale a sample of `bitDepth` bits up to the full 0–255 range. */
function scaleTo8(value: number, bitDepth: number): number {
  if (bitDepth === 8) return value;
  if (bitDepth === 16) return value >> 8;
  return Math.round((value * 255) / ((1 << bitDepth) - 1));
}

type Header = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
};

/**
 * Expand one interlace pass (or the whole image, for pass geometry covering
 * every pixel) from unfiltered scanlines into the RGBA output buffer.
 */
function expandPass(
  raw: Uint8Array,
  offset: number,
  passWidth: number,
  passHeight: number,
  geom: { xStart: number; yStart: number; xStep: number; yStep: number },
  header: Header,
  palette: Uint8Array | null,
  transparency: number[] | null,
  out: Uint8Array,
): number {
  const { width, bitDepth, colorType } = header;
  const channels = CHANNELS[colorType]!;
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const lineBytes = Math.ceil((channels * bitDepth * passWidth) / 8);
  let prev = new Uint8Array(lineBytes);
  let cursor = offset;

  for (let row = 0; row < passHeight; row += 1) {
    const filterType = raw[cursor]!;
    cursor += 1;
    const line = raw.subarray(cursor, cursor + lineBytes);
    cursor += lineBytes;
    unfilter(filterType, line, prev, bpp);

    const y = geom.yStart + row * geom.yStep;
    for (let col = 0; col < passWidth; col += 1) {
      const x = geom.xStart + col * geom.xStep;
      const target = (y * width + x) * 4;
      const base = col * channels;

      let r: number;
      let g: number;
      let b: number;
      let a = 255;

      if (colorType === 3) {
        const index = sampleAt(line, base, bitDepth);
        if (!palette) throw new Error("PNG: indexed image without a PLTE chunk");
        r = palette[index * 3]!;
        g = palette[index * 3 + 1]!;
        b = palette[index * 3 + 2]!;
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
        else if (
          transparency &&
          transparency[0] === rawR &&
          transparency[1] === rawG &&
          transparency[2] === rawB
        ) {
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

/** Decode a PNG buffer into 8-bit RGBA. Throws on malformed input. */
export function decodePng(buffer: Uint8Array): DecodedPng {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error("Not a PNG file (bad signature)");
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let pos = 8;
  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  let transparency: number[] | null = null;
  const idat: Uint8Array[] = [];

  while (pos < buffer.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(
      buffer[pos + 4]!,
      buffer[pos + 5]!,
      buffer[pos + 6]!,
      buffer[pos + 7]!,
    );
    const body = buffer.subarray(pos + 8, pos + 8 + length);

    if (type === "IHDR") {
      header = {
        width: view.getUint32(pos + 8),
        height: view.getUint32(pos + 12),
        bitDepth: buffer[pos + 16]!,
        colorType: buffer[pos + 17]!,
        interlace: buffer[pos + 20]!,
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
      else if (header.colorType === 0) transparency = [(body[0]! << 8) | body[1]!];
      else {
        transparency = [
          (body[0]! << 8) | body[1]!,
          (body[2]! << 8) | body[3]!,
          (body[4]! << 8) | body[5]!,
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
  // A 16-bit palette index is meaningless; the spec caps indexed at 8.
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
      out,
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
        out,
      );
    }
  } else {
    throw new Error(`PNG: unsupported interlace method ${interlace}`);
  }

  return { width, height, data: out };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/**
 * Pick a filter per scanline using the standard minimum-sum-of-absolute-
 * differences heuristic, then emit the filtered bytes. This is what makes
 * encoded sprites compress to roughly what Pillow produced; writing every
 * line unfiltered would inflate spritesheets several-fold.
 */
function filterScanlines(data: Uint8Array, width: number, height: number): Buffer {
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
        const a = i >= 4 ? line[i - 4]! : 0;
        const b = prev[i]!;
        const c = i >= 4 ? prev[i - 4]! : 0;
        let value: number;
        if (type === 0) value = line[i]!;
        else if (type === 1) value = line[i]! - a;
        else if (type === 2) value = line[i]! - b;
        else if (type === 3) value = line[i]! - ((a + b) >> 1);
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = line[i]! - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        candidate[i] = value & 0xff;
        // Treat bytes as signed when scoring: the heuristic is about how close
        // residuals sit to zero, and 0xff means -1, not 255.
        score += Math.abs(((value & 0xff) << 24) >> 24);
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

/** Encode 8-bit RGBA pixels as a non-interlaced colour-type-6 PNG. */
export function encodePng(image: DecodedPng): Buffer {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new Error(
      `PNG: pixel buffer is ${data.length} bytes, expected ${width * height * 4} for ${width}x${height}`,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filterScanlines(data, width, height), { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * Read just the dimensions from a PNG header without inflating pixel data —
 * the fast path for `vg asset sizes`, which probes hundreds of files.
 */
export function readPngSize(buffer: Uint8Array): { width: number; height: number } {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error("Not a PNG file (bad signature)");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
