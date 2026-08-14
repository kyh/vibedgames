import type { Bitmap } from "./raster.js";

/**
 * Minimal GIF89a writer: median-cut quantisation, LZW compression, and the
 * Netscape looping extension. It exists to replace Pillow's `save_all=True`
 * animated-GIF path used by the sprite review pipeline, which is the only
 * GIF writing these skills ever did.
 */

export type GifFrame = {
  bitmap: Bitmap;
  /** Frame delay in milliseconds. GIF stores hundredths, so this rounds. */
  delayMs: number;
};

type Palette = { colors: number[][]; lookup: Map<number, number> };

/**
 * Median-cut colour quantisation. Repeatedly split the colour box with the
 * widest channel range at its median until we have `maxColors` boxes, then
 * average each box. This is the same family of algorithm as Pillow's ADAPTIVE
 * palette, so review GIFs look the way they did before.
 */
function quantize(pixels: number[][], maxColors: number): Palette {
  let boxes: number[][][] = [pixels];

  while (boxes.length < maxColors) {
    // Split the box with the largest single-channel spread; stop when every
    // remaining box is a single colour and nothing can be usefully divided.
    let target = -1;
    let bestRange = 0;
    let bestChannel = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i]!;
      if (box.length < 2) continue;
      for (let c = 0; c < 3; c += 1) {
        let min = 255;
        let max = 0;
        for (const p of box) {
          if (p[c]! < min) min = p[c]!;
          if (p[c]! > max) max = p[c]!;
        }
        if (max - min > bestRange) {
          bestRange = max - min;
          target = i;
          bestChannel = c;
        }
      }
    }
    if (target < 0 || bestRange === 0) break;

    const box = boxes[target]!;
    box.sort((a, b) => a[bestChannel]! - b[bestChannel]!);
    const mid = box.length >> 1;
    boxes = [
      ...boxes.slice(0, target),
      box.slice(0, mid),
      box.slice(mid),
      ...boxes.slice(target + 1),
    ];
  }

  const colors = boxes
    .filter((box) => box.length > 0)
    .map((box) => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const p of box) {
        r += p[0]!;
        g += p[1]!;
        b += p[2]!;
      }
      return [Math.round(r / box.length), Math.round(g / box.length), Math.round(b / box.length)];
    });

  if (colors.length === 0) colors.push([0, 0, 0]);
  return { colors, lookup: new Map() };
}

/** Nearest palette entry by squared RGB distance, memoised per colour. */
function nearest(palette: Palette, r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b;
  const cached = palette.lookup.get(key);
  if (cached !== undefined) return cached;

  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.colors.length; i += 1) {
    const c = palette.colors[i]!;
    const dr = c[0]! - r;
    const dg = c[1]! - g;
    const db = c[2]! - b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  palette.lookup.set(key, best);
  return best;
}

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
    if (this.bits > 0) this.bytes.push(this.accumulator & 0xff);
    const out: number[] = [];
    for (let i = 0; i < this.bytes.length; i += 255) {
      const chunk = this.bytes.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0); // block terminator
    return Buffer.from(out);
  }
}

function lzwCompress(indices: Uint8Array, minCodeSize: number): Buffer {
  const clearCode = 1 << minCodeSize;
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

  writer.write(clearCode, codeWidth);
  resetDict();
  writer.write(clearCode, codeWidth);

  let prefix = String(indices[0]!);
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i]!;
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
    } else if (next > 0xfff) {
      writer.write(clearCode, codeWidth);
      resetDict();
    }
    prefix = String(k);
  }

  writer.write(dict.get(prefix) ?? Number(prefix), codeWidth);
  writer.write(endCode, codeWidth);
  return writer.finish();
}

/**
 * Encode frames as a looping animated GIF. Frames are composited against
 * `background` first, since GIF has only 1-bit transparency and the sprite
 * review flow always wanted a flat backdrop anyway.
 */
export function encodeGif(frames: GifFrame[], loop = 0): Buffer {
  if (frames.length === 0) throw new Error("GIF: no frames to encode");
  const width = frames[0]!.bitmap.width;
  const height = frames[0]!.bitmap.height;
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
  header[10] = 0; // no global colour table
  header[11] = 0; // background colour index
  header[12] = 0; // pixel aspect ratio
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
    const pixels: number[][] = [];
    for (let i = 0; i < bitmap.data.length; i += 4) {
      pixels.push([bitmap.data[i]!, bitmap.data[i + 1]!, bitmap.data[i + 2]!]);
    }

    const palette = quantize(
      pixels.map((p) => [...p]),
      256,
    );
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i += 1) {
      const p = pixels[i]!;
      indices[i] = nearest(palette, p[0]!, p[1]!, p[2]!);
    }

    // Colour table sizes are powers of two, minimum 2 entries.
    let tableBits = 1;
    while (1 << tableBits < palette.colors.length) tableBits += 1;
    const tableSize = 1 << tableBits;

    // Graphic control extension: disposal method 2 (restore to background),
    // matching the Pillow call this replaces.
    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 0x04;
    gce[3] = 2 << 2; // disposal method 2, no transparency
    gce.writeUInt16LE(Math.max(0, Math.round(frame.delayMs / 10)), 4);
    gce[6] = 0; // transparent colour index (unused)
    gce[7] = 0;
    parts.push(gce);

    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1); // left
    descriptor.writeUInt16LE(0, 3); // top
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0x80 | (tableBits - 1); // local colour table, size
    parts.push(descriptor);

    const table = Buffer.alloc(tableSize * 3);
    for (let i = 0; i < palette.colors.length; i += 1) {
      const c = palette.colors[i]!;
      table[i * 3] = c[0]!;
      table[i * 3 + 1] = c[1]!;
      table[i * 3 + 2] = c[2]!;
    }
    parts.push(table);

    // The LZW minimum code size must be at least 2 even for tiny palettes.
    const minCodeSize = Math.max(2, tableBits);
    parts.push(Buffer.from([minCodeSize]));
    parts.push(lzwCompress(indices, minCodeSize));
  }

  parts.push(Buffer.from([0x3b])); // trailer
  return Buffer.concat(parts);
}
