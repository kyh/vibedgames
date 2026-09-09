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
  { xStart: 0, xStep: 8, yStart: 0, yStep: 8 },
  { xStart: 4, xStep: 8, yStart: 0, yStep: 8 },
  { xStart: 0, xStep: 4, yStart: 4, yStep: 8 },
  { xStart: 2, xStep: 4, yStart: 0, yStep: 4 },
  { xStart: 0, xStep: 2, yStart: 2, yStep: 4 },
  { xStart: 1, xStep: 2, yStart: 0, yStep: 2 },
  { xStart: 0, xStep: 1, yStart: 1, yStep: 2 },
] as const;

/** Channel count per PNG colour type, keyed by the colour type itself. */
const CHANNELS = new Map<number, number>([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);

const channelsFor = (colorType: number): number => {
  const channels = CHANNELS.get(colorType);
  if (channels === undefined) {
    throw new Error(`PNG: unsupported colour type ${colorType}`);
  }
  return channels;
};

/**
 * Pixel ceiling for a decoded image, ~256 MB of RGBA.
 *
 * Generous next to any game asset, and far below the 2^31-1 per side the
 * format permits, so a corrupt or hostile header is a message instead of an
 * out-of-memory crash.
 */
const MAX_PIXELS = 64_000_000;

export interface DecodedPng {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel, straight (non-premultiplied) alpha. */
  data: Uint8Array;
}

/* oxlint-disable no-bitwise -- CRC-32 is defined as bit mixing */
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xff_ff_ff_ff) >>> 0;
};
/* oxlint-enable no-bitwise */

/** A scanline byte; off either end reads as 0, which is how the filters treat the missing left pixel. */
const byteAt = (bytes: Uint8Array, i: number): number => bytes[i] ?? 0;

/** The Paeth predictor (filter type 4): whichever neighbour is closest to `a + b - c`. */
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
};

/**
 * Undo one scanline's filter in place. `line` is the current (still filtered)
 * scanline, `prev` the already-reconstructed line above it, and `bpp` the
 * byte distance to the pixel on the left — clamped to 1 for sub-byte depths,
 * where filtering operates on bytes rather than pixels.
 */
const unfilter = (type: number, line: Uint8Array, prev: Uint8Array, bpp: number): void => {
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

/** Read the `index`-th sample of `bitDepth` bits from a packed scanline. */
const sampleAt = (line: Uint8Array, index: number, bitDepth: number): number => {
  if (bitDepth === 8) {
    return byteAt(line, index);
  }
  if (bitDepth === 16) {
    return byteAt(line, index * 2) * 256 + byteAt(line, index * 2 + 1);
  }
  const perByte = 8 / bitDepth;
  const byte = byteAt(line, Math.floor(index / perByte));
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  return Math.floor(byte / 2 ** shift) % 2 ** bitDepth;
};

/** Scale a sample of `bitDepth` bits up to the full 0–255 range. */
const scaleTo8 = (value: number, bitDepth: number): number => {
  if (bitDepth === 8) {
    return value;
  }
  if (bitDepth === 16) {
    return Math.floor(value / 256);
  }
  return Math.round((value * 255) / (2 ** bitDepth - 1));
};

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/**
 * Expand one interlace pass (or the whole image, for pass geometry covering
 * every pixel) from unfiltered scanlines into the RGBA output buffer.
 */
const expandPass = (
  raw: Uint8Array,
  offset: number,
  passWidth: number,
  passHeight: number,
  geom: { xStart: number; yStart: number; xStep: number; yStep: number },
  header: Header,
  palette: Uint8Array | null,
  transparency: number[] | null,
  out: Uint8Array,
): number => {
  const { width, bitDepth, colorType } = header;
  const channels = channelsFor(colorType);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const lineBytes = Math.ceil((channels * bitDepth * passWidth) / 8);
  let prev = new Uint8Array(lineBytes);
  let cursor = offset;

  for (let row = 0; row < passHeight; row += 1) {
    const filterType = raw[cursor];
    if (filterType === undefined) {
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

      let r: number;
      let g: number;
      let b: number;
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
        } else if (
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
};

/**
 * Bytes of unfiltered scanline data a valid image of this shape must carry:
 * one filter byte per row, plus the packed samples. Adam7 splits the image
 * into seven passes, each with its own rows and its own filter bytes.
 */
const expectedRawBytes = (header: Header): number => {
  const channels = channelsFor(header.colorType);
  const rowBytes = (w: number) => Math.ceil((channels * header.bitDepth * w) / 8);

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

const checkSignature = (buffer: Uint8Array): void => {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (buffer[i] !== SIGNATURE[i]) {
      throw new Error("Not a PNG file (bad signature)");
    }
  }
};

const parseIhdr = (view: DataView, pos: number): Header => {
  const header: Header = {
    bitDepth: view.getUint8(pos + 16),
    colorType: view.getUint8(pos + 17),
    height: view.getUint32(pos + 12),
    interlace: view.getUint8(pos + 20),
    width: view.getUint32(pos + 8),
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
  // The dimensions come straight off the file, and the RGBA buffer is sized
  // from them, so a corrupt IHDR would otherwise be an allocation the size
  // of whatever the header claims — a `RangeError` from the engine rather
  // than something a caller can report. Zero is invalid per spec, and would
  // otherwise decode "successfully" to an empty image.
  if (header.width < 1 || header.height < 1) {
    throw new Error(`PNG: invalid dimensions ${header.width}x${header.height}`);
  }
  if (header.width * header.height > MAX_PIXELS) {
    throw new Error(
      `PNG: ${header.width}x${header.height} exceeds the ${MAX_PIXELS.toLocaleString("en-US")}-pixel limit`,
    );
  }
  return header;
};

/** A `tRNS` chunk: one alpha per palette entry, or the 16-bit sample(s) that read as transparent. */
const parseTransparency = (body: Uint8Array, colorType: number): number[] => {
  if (colorType === 3) {
    return [...body];
  }
  const sample16 = (i: number) => byteAt(body, i) * 256 + byteAt(body, i + 1);
  if (colorType === 0) {
    return [sample16(0)];
  }
  return [sample16(0), sample16(2), sample16(4)];
};

interface Chunks {
  header: Header;
  palette: Uint8Array | null;
  transparency: number[] | null;
  idat: Uint8Array[];
}

const readChunks = (buffer: Uint8Array): Chunks => {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let pos = 8;
  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  let transparency: number[] | null = null;
  const idat: Uint8Array[] = [];

  while (pos < buffer.length) {
    // A truncated file must be reported as truncated. Without this the reads
    // below run off the end of the DataView, and the caller gets an engine
    // `RangeError` about offsets instead of something it can act on.
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

const expandImage = (raw: Uint8Array, chunks: Chunks): Uint8Array => {
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
      out,
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
      out,
    );
  }
  return out;
};

/** Decode a PNG buffer into 8-bit RGBA. Throws on malformed input. */
export const decodePng = (buffer: Uint8Array): DecodedPng => {
  checkSignature(buffer);
  const chunks = readChunks(buffer);
  const { header, idat } = chunks;
  const { width, height, bitDepth, colorType } = header;
  if (![1, 2, 4, 8, 16].includes(bitDepth)) {
    throw new Error(`PNG: unsupported bit depth ${bitDepth}`);
  }
  // A 16-bit palette index is meaningless; the spec caps indexed at 8.
  if (colorType === 3 && bitDepth === 16) {
    throw new Error("PNG: indexed images cap at 8-bit");
  }

  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c)))));

  // The scanlines have to actually be there. Short IDAT data used to read past
  // the end of `raw`, where `subarray` clamps and missing bytes come back as
  // `undefined`: a 1x1 image with two bytes of pixel data decoded to a colour
  // nobody wrote, and exited 0. Larger images happened to trip "unknown filter
  // type undefined" instead, which is the same bug wearing a message.
  const expected = expectedRawBytes(header);
  if (raw.length < expected) {
    throw new Error(
      `PNG: truncated pixel data (${raw.length} bytes, expected ${expected} for ${width}x${height})`,
    );
  }

  return { data: expandImage(raw, chunks), height, width };
};

const chunk = (type: string, body: Uint8Array): Buffer => {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
};

/**
 * Pick a filter per scanline using the standard minimum-sum-of-absolute-
 * differences heuristic, then emit the filtered bytes. This is what makes
 * encoded sprites compress to roughly what Pillow produced; writing every
 * line unfiltered would inflate spritesheets several-fold.
 */
const filterScanlines = (data: Uint8Array, width: number, height: number): Buffer => {
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
        let value: number;
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
        const wrapped = ((value % 256) + 256) % 256;
        candidate[i] = wrapped;
        // Treat bytes as signed when scoring: the heuristic is about how close
        // residuals sit to zero, and 0xff means -1, not 255.
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

/** Encode 8-bit RGBA pixels as a non-interlaced colour-type-6 PNG. */
export const encodePng = (image: DecodedPng): Buffer => {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new Error(
      `PNG: pixel buffer is ${data.length} bytes, expected ${width * height * 4} for ${width}x${height}`,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  // bit depth
  ihdr[8] = 8;
  // colour type: RGBA
  ihdr[9] = 6;
  // compression: deflate
  ihdr[10] = 0;
  // filter: adaptive
  ihdr[11] = 0;
  // interlace: none
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filterScanlines(data, width, height), { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
};

/**
 * Read just the dimensions from a PNG header without inflating pixel data —
 * the fast path for `vg asset sizes`, which probes hundreds of files.
 */
export const readPngSize = (buffer: Uint8Array) => {
  checkSignature(buffer);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return { height: view.getUint32(20), width: view.getUint32(16) };
};
