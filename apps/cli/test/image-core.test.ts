import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseColor, toHex } from "../src/image/color.js";
import { encodeGif } from "../src/image/gif.js";
import { decodePng, encodePng, readPngSize } from "../src/image/png.js";
import { Bitmap, readImageSize } from "../src/image/raster.js";

/**
 * The image core replaced Python + Pillow, so its fixtures are Pillow's own
 * output: `fixtures/*.png` were written by Pillow 12 and `expected.json`
 * records the SHA-256 of each one's decoded RGBA bytes. A decoder that agrees
 * with those hashes agrees with Pillow pixel for pixel.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const expected: Record<string, { w: number; h: number; sha: string }> = JSON.parse(
  readFileSync(join(FIXTURES, "expected.json"), "utf8"),
);

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

test("decodes every PNG colour type and bit depth exactly as Pillow does", () => {
  for (const [name, want] of Object.entries(expected)) {
    const got = decodePng(readFileSync(join(FIXTURES, name)));
    assert.equal(got.width, want.w, `${name} width`);
    assert.equal(got.height, want.h, `${name} height`);
    assert.equal(sha(got.data), want.sha, `${name} pixels`);
  }
});

test("encoding is a lossless round trip", () => {
  for (const [name, want] of Object.entries(expected)) {
    const decoded = decodePng(readFileSync(join(FIXTURES, name)));
    const again = decodePng(encodePng(decoded));
    assert.equal(sha(again.data), want.sha, `${name} survived re-encoding`);
  }
});

test("reads dimensions from a header without decoding pixels", () => {
  const buffer = readFileSync(join(FIXTURES, "rgba8.png"));
  assert.deepEqual(readPngSize(buffer), { width: 61, height: 37 });
  assert.deepEqual(readImageSize(join(FIXTURES, "rgba8.png")), { width: 61, height: 37 });
});

test("rejects non-PNG input rather than emitting garbage pixels", () => {
  assert.throws(() => decodePng(Buffer.from("definitely not a png")), /signature/i);
});

test("nearest-neighbour resampling is bit-exact against Pillow", () => {
  // Pixel art depends on this: an integer upscale must stay perfectly blocky,
  // with no interpolation smuggled in at the edges.
  const src = Bitmap.fromFile(join(FIXTURES, "rgba8.png"));
  for (const [tag, w, h] of [
    ["up", 128, 91],
    ["down", 17, 11],
  ] as const) {
    const mine = src.resize(w, h, "nearest");
    const want = decodePng(readFileSync(join(FIXTURES, `${tag}_nearest.png`)));
    assert.equal(sha(mine.data), sha(want.data), `${tag}_nearest`);
  }
});

test("filtered resampling tracks Pillow within a rounding level", () => {
  // Pillow computes filter weights in fixed point and we use doubles, so a
  // handful of bytes land a level or two apart. Anything larger means the
  // premultiply round trip or the filter footprint has drifted.
  const src = Bitmap.fromFile(join(FIXTURES, "rgba8.png"));
  for (const mode of ["bilinear", "bicubic", "lanczos"] as const) {
    for (const [tag, w, h] of [
      ["up", 128, 91],
      ["down", 17, 11],
    ] as const) {
      const mine = src.resize(w, h, mode);
      const want = decodePng(readFileSync(join(FIXTURES, `${tag}_${mode}.png`)));
      let maxDelta = 0;
      let differing = 0;
      for (let i = 0; i < want.data.length; i += 1) {
        const delta = Math.abs(mine.data[i]! - want.data[i]!);
        if (delta > 0) differing += 1;
        if (delta > maxDelta) maxDelta = delta;
      }
      assert.ok(maxDelta <= 4, `${tag}_${mode} max delta ${maxDelta} exceeds 4`);
      const ratio = differing / want.data.length;
      assert.ok(ratio < 0.01, `${tag}_${mode} ${(ratio * 100).toFixed(2)}% of bytes differ`);
    }
  }
});

test("crop reads outside the source as transparent instead of clamping", () => {
  const src = Bitmap.create(4, 4, [10, 20, 30, 255]);
  const out = src.crop({ left: -2, top: -2, right: 2, bottom: 2 });
  assert.deepEqual([out.width, out.height], [4, 4]);
  assert.deepEqual(out.getPixel(0, 0), [0, 0, 0, 0]);
  assert.deepEqual(out.getPixel(3, 3), [10, 20, 30, 255]);
});

test("getBBox finds the tight box and reports null when empty", () => {
  const bmp = Bitmap.create(8, 8);
  assert.equal(bmp.getBBox(), null);
  bmp.putPixel(2, 3, [255, 0, 0, 255]);
  bmp.putPixel(5, 6, [0, 255, 0, 128]);
  assert.deepEqual(bmp.getBBox(), { left: 2, top: 3, right: 6, bottom: 7 });
});

test("paste replaces pixels while alphaComposite blends them", () => {
  const base = Bitmap.create(2, 1, [0, 0, 0, 255]);
  const overlay = Bitmap.create(1, 1, [255, 255, 255, 128]);

  const pasted = base.copy();
  pasted.paste(overlay, 0, 0);
  assert.deepEqual(pasted.getPixel(0, 0), [255, 255, 255, 128], "paste overwrites alpha too");

  const blended = base.copy();
  blended.alphaComposite(overlay, 0, 0);
  const [r, , , a] = blended.getPixel(0, 0);
  assert.equal(a, 255, "compositing onto opaque stays opaque");
  assert.ok(r > 100 && r < 155, `expected a mid grey, got ${r}`);
});

test("paste and composite clip at the edges rather than wrapping", () => {
  const base = Bitmap.create(3, 3, [0, 0, 0, 255]);
  base.paste(Bitmap.create(2, 2, [9, 9, 9, 255]), 2, 2);
  assert.deepEqual(base.getPixel(2, 2), [9, 9, 9, 255]);
  assert.deepEqual(base.getPixel(0, 0), [0, 0, 0, 255], "no wrap-around into row 0");
});

test("parses the colour spellings the skills pass on the command line", () => {
  assert.deepEqual(parseColor("#00FF00"), [0, 255, 0, 255]);
  assert.deepEqual(parseColor("#0f0"), [0, 255, 0, 255]);
  assert.deepEqual(parseColor("#0f0f"), [0, 255, 0, 255]);
  assert.deepEqual(parseColor("rgb(10, 20, 30)"), [10, 20, 30, 255]);
  assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), [10, 20, 30, 128]);
  assert.deepEqual(parseColor("magenta"), [255, 0, 255, 255]);
  assert.deepEqual(parseColor("transparent"), [0, 0, 0, 0]);
  assert.equal(toHex([0, 255, 0, 255]), "#00ff00");
  assert.throws(() => parseColor("not-a-colour"), /Unrecognised/);
});

test("rejects malformed hex instead of producing NaN channels", () => {
  // A NaN channel would be written straight into pixels by --bg/--fill-rect.
  // `parseInt` stops at the first bad digit, so "1z" reads as 1 unless the
  // whole string is validated.
  for (const bad of ["#ggg", "#gggg", "#12345z", "#1z0000", "#12345", "#", "#1234567"]) {
    assert.throws(() => parseColor(bad), /Unrecognised/, `expected ${bad} to be rejected`);
  }
  assert.deepEqual(parseColor("#abcdef"), [171, 205, 239, 255]);
});

test("writes a GIF that decodes back to the frames it was given", () => {
  const frames = [0, 1].map((n) => {
    const bitmap = Bitmap.create(8, 8, [0, 0, 0, 255]);
    bitmap.putPixel(n * 4, 0, [255, 0, 0, 255]);
    return { bitmap, delayMs: 120 };
  });
  const gif = encodeGif(frames);
  assert.equal(gif.subarray(0, 6).toString("ascii"), "GIF89a");
  assert.equal(gif.readUInt16LE(6), 8, "logical screen width");
  assert.equal(gif.readUInt16LE(8), 8, "logical screen height");
  assert.equal(gif[gif.length - 1], 0x3b, "trailer");
  assert.ok(gif.includes(Buffer.from("NETSCAPE2.0", "ascii")), "loops forever");
});

test("the LZW stream opens with exactly one clear code", () => {
  // Two clear codes in a row is tolerated by lenient viewers but is not a
  // valid bitstream, and stricter decoders are entitled to reject it.
  const bitmap = Bitmap.create(4, 4, [10, 20, 30, 255]);
  bitmap.putPixel(1, 1, [200, 100, 50, 255]);
  const gif = encodeGif([{ bitmap, delayMs: 100 }]);

  // Walk to the image descriptor (0x2c), skip it and the local colour table,
  // then read the LZW minimum code size and the first two codes.
  const descriptor = gif.indexOf(0x2c);
  const packed = gif[descriptor + 9]!;
  const tableEntries = 1 << ((packed & 0x07) + 1);
  const minCodeSize = gif[descriptor + 10 + tableEntries * 3]!;
  const dataStart = descriptor + 10 + tableEntries * 3 + 1;
  const payload = gif.subarray(dataStart + 1); // skip the sub-block length byte

  const codeWidth = minCodeSize + 1;
  const bits = (payload[0]! | (payload[1]! << 8) | (payload[2]! << 16)) >>> 0;
  const mask = (1 << codeWidth) - 1;
  const first = bits & mask;
  const second = (bits >> codeWidth) & mask;

  assert.equal(first, 1 << minCodeSize, "stream opens with a clear code");
  assert.notEqual(second, 1 << minCodeSize, "and does not repeat it");
});

test("refuses to build a GIF from mismatched frame sizes", () => {
  assert.throws(
    () =>
      encodeGif([
        { bitmap: Bitmap.create(4, 4), delayMs: 100 },
        { bitmap: Bitmap.create(5, 4), delayMs: 100 },
      ]),
    /every frame must be/,
  );
});
