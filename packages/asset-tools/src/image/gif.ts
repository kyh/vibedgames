import type { Bitmap, RGB } from "./raster.js";

/**
 * Minimal GIF89a writer: median-cut quantisation, LZW compression, and the
 * Netscape looping extension. It exists to replace Pillow's `save_all=True`
 * animated-GIF path used by the sprite review pipeline, which is the only
 * GIF writing these skills ever did.
 */

export interface GifFrame {
  bitmap: Bitmap;
  /** Frame delay in milliseconds. GIF stores hundredths, so this rounds. */
  delayMs: number;
}

interface Palette {
  colors: RGB[];
  lookup: Map<number, number>;
}

/**
 * Median-cut colour quantisation. Repeatedly split the colour box with the
 * widest channel range at its median until we have `maxColors` boxes, then
 * average each box. This is the same family of algorithm as Pillow's ADAPTIVE
 * palette, so review GIFs look the way they did before.
 */
const CHANNELS = [0, 1, 2] as const;

const quantize = (pixels: RGB[], maxColors: number): Palette => {
  let boxes: RGB[][] = [pixels];

  while (boxes.length < maxColors) {
    // Split the box with the largest single-channel spread; stop when every
    // remaining box is a single colour and nothing can be usefully divided.
    let target = -1;
    let box: RGB[] | undefined;
    let bestRange = 0;
    let bestChannel: 0 | 1 | 2 = 0;
    for (const [i, candidate] of boxes.entries()) {
      if (candidate.length < 2) {
        continue;
      }
      for (const c of CHANNELS) {
        let min = 255;
        let max = 0;
        for (const p of candidate) {
          if (p[c] < min) {
            min = p[c];
          }
          if (p[c] > max) {
            max = p[c];
          }
        }
        if (max - min > bestRange) {
          bestRange = max - min;
          target = i;
          box = candidate;
          bestChannel = c;
        }
      }
    }
    if (box === undefined || bestRange === 0) {
      break;
    }

    box.sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = Math.floor(box.length / 2);
    boxes = [
      ...boxes.slice(0, target),
      box.slice(0, mid),
      box.slice(mid),
      ...boxes.slice(target + 1),
    ];
  }

  const colors = boxes
    .filter((box) => box.length > 0)
    .map((box): RGB => {
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

  if (colors.length === 0) {
    colors.push([0, 0, 0]);
  }
  return { colors, lookup: new Map() };
};

/** Nearest palette entry by squared RGB distance, memoised per colour. */
const nearest = (palette: Palette, r: number, g: number, b: number): number => {
  const key = r * 0x1_00_00 + g * 0x1_00 + b;
  const cached = palette.lookup.get(key);
  if (cached !== undefined) {
    return cached;
  }

  let best = 0;
  let bestDist = Infinity;
  for (const [i, c] of palette.colors.entries()) {
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
};

/* oxlint-disable no-bitwise -- packs variable-width LZW codes into a byte stream */
/** Variable-width LZW bitstream packer, emitting GIF sub-blocks of <=255 bytes. */
class BitWriter {
  private readonly bytes: number[] = [];
  private accumulator = 0;
  private bits = 0;

  write(code: number, width: number): void {
    this.accumulator |= code << this.bits;
    this.bits += width;
    while (this.bits >= 8) {
      this.bytes.push(this.accumulator & 0xff);
      this.accumulator >>= 8;
      this.bits -= 8;
    }
  }

  finish(): Buffer {
    if (this.bits > 0) {
      this.bytes.push(this.accumulator & 0xff);
    }
    const out: number[] = [];
    for (let i = 0; i < this.bytes.length; i += 255) {
      const chunk = this.bytes.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    // block terminator
    out.push(0);
    return Buffer.from(out);
  }
}
/* oxlint-enable no-bitwise */

const lzwCompress = (indices: Uint8Array, minCodeSize: number): Buffer => {
  const clearCode = 2 ** minCodeSize;
  const endCode = clearCode + 1;
  const writer = new BitWriter();

  let dict = new Map<string, number>();
  let next = endCode + 1;
  let codeWidth = minCodeSize + 1;
  const resetDict = () => {
    dict = new Map();
    next = endCode + 1;
    codeWidth = minCodeSize + 1;
  };

  // Exactly one clear code opens the stream. Emitting a second is tolerated by
  // lenient decoders but is not a valid bitstream.
  resetDict();
  writer.write(clearCode, codeWidth);

  let prefix = String(indices[0] ?? 0);
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i] ?? 0;
    const combined = `${prefix},${k}`;
    if (dict.has(combined)) {
      prefix = combined;
      continue;
    }
    writer.write(dict.get(prefix) ?? Number(prefix), codeWidth);
    dict.set(combined, next);
    next += 1;
    if (next > 2 ** codeWidth && codeWidth < 12) {
      codeWidth += 1;
    } else if (next > 0xf_ff) {
      writer.write(clearCode, codeWidth);
      resetDict();
    }
    prefix = String(k);
  }

  writer.write(dict.get(prefix) ?? Number(prefix), codeWidth);
  writer.write(endCode, codeWidth);
  return writer.finish();
};

/**
 * Encode frames as a looping animated GIF.
 *
 * Alpha is discarded, not composited — each frame's RGB is quantised as-is,
 * which is what Pillow's `convert("RGB")` did in the pipeline this replaces
 * (it drops the alpha band rather than blending against anything). Callers
 * that want a backdrop behind transparent pixels must composite the frames
 * onto one before calling, exactly as the sprite review flow does with its
 * `--flat-bg` option.
 */
export const encodeGif = (frames: GifFrame[], loop = 0): Buffer => {
  const [first] = frames;
  if (first === undefined) {
    throw new Error("GIF: no frames to encode");
  }
  const { width, height } = first.bitmap;
  for (const frame of frames) {
    if (frame.bitmap.width !== width || frame.bitmap.height !== height) {
      throw new Error(
        `GIF: every frame must be ${width}x${height}, got ${frame.bitmap.width}x${frame.bitmap.height}`,
      );
    }
  }

  const parts: Buffer[] = [];

  // Header + logical screen descriptor. No global colour table: each frame
  // carries its own, which keeps colour fidelity when frames differ a lot.
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  // no global colour table
  header[10] = 0;
  // background colour index
  header[11] = 0;
  // pixel aspect ratio
  header[12] = 0;
  parts.push(header);

  // Netscape 2.0 application extension: loop count.
  const netscape = Buffer.from([
    0x21,
    0xff,
    0x0b,
    ...Buffer.from("NETSCAPE2.0", "ascii"),
    0x03,
    0x01,
    0,
    0,
    0x00,
  ]);
  netscape.writeUInt16LE(loop, 16);
  parts.push(netscape);

  for (const frame of frames) {
    const { bitmap } = frame;
    const pixels: RGB[] = [];
    for (let i = 0; i < bitmap.data.length; i += 4) {
      pixels.push([bitmap.data[i] ?? 0, bitmap.data[i + 1] ?? 0, bitmap.data[i + 2] ?? 0]);
    }

    const palette = quantize(
      pixels.map((p) => [...p]),
      256,
    );
    const indices = new Uint8Array(width * height);
    for (const [i, p] of pixels.entries()) {
      indices[i] = nearest(palette, p[0], p[1], p[2]);
    }

    // Colour table sizes are powers of two, minimum 2 entries.
    let tableBits = 1;
    while (2 ** tableBits < palette.colors.length) {
      tableBits += 1;
    }
    const tableSize = 2 ** tableBits;

    // Graphic control extension: disposal method 2 (restore to background),
    // matching the Pillow call this replaces.
    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 0x04;
    // disposal method 2 in bits 2-4, no transparency
    gce[3] = 0b0000_1000;
    gce.writeUInt16LE(Math.max(0, Math.round(frame.delayMs / 10)), 4);
    // transparent colour index (unused)
    gce[6] = 0;
    gce[7] = 0;
    parts.push(gce);

    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    // left
    descriptor.writeUInt16LE(0, 1);
    // top
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    // local colour table flag, then its size exponent in the low three bits
    descriptor[9] = 0x80 + (tableBits - 1);
    parts.push(descriptor);

    const table = Buffer.alloc(tableSize * 3);
    for (const [i, [r, g, b]] of palette.colors.entries()) {
      table[i * 3] = r;
      table[i * 3 + 1] = g;
      table[i * 3 + 2] = b;
    }
    parts.push(table);

    // The LZW minimum code size must be at least 2 even for tiny palettes.
    const minCodeSize = Math.max(2, tableBits);
    parts.push(Buffer.from([minCodeSize]), lzwCompress(indices, minCodeSize));
  }

  // trailer
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
};
