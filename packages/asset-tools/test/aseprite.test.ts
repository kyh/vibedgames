import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AsepriteParseError,
  inferBoundsFromPixels,
  inspectAseprite,
} from "../src/asset/aseprite.js";
import { buildAseFile, chunks, sampleIndexedFile, sampleRgbaFile } from "./ase-fixture.js";

const rgba = () => inspectAseprite("rgba.aseprite", sampleRgbaFile());

test("reads the file header", () => {
  const report = rgba();
  assert.deepEqual(report.header, {
    fileSize: sampleRgbaFile().length,
    frames: 2,
    width: 8,
    height: 8,
    colorDepthBpp: 32,
    flags: 4,
    speedDeprecatedMs: 120,
    transparentIndex: 0,
    // A stored count of zero means the full 256-entry palette.
    numColors: 256,
    pixelRatio: { w: 1, h: 1 },
    grid: { x: -2, y: -3, w: 16, h: 16 },
  });
});

test("a zero frame duration falls back to the file-wide speed", () => {
  const report = rgba();
  assert.deepEqual(report.timeline, { frameMs: [100, 120], totalMs: 220 });
  // The raw value is preserved; only the timeline substitutes.
  assert.equal(report.frames[1]!.durationMs, 0);
});

test("reads layers, including tilemap layers and UUIDs", () => {
  const report = rgba();
  assert.equal(report.layers.length, 2);
  assert.equal(report.layers[0]!.name, "background");
  assert.equal(report.layers[0]!.uuid, "1b4e28ba-2fa1-11d2-883f-0016d3cca427");
  assert.equal(report.layers[0]!.tilesetIndex, undefined);
  assert.equal(report.layers[1]!.type, 2);
  assert.equal(report.layers[1]!.tilesetIndex, 0);
});

test("user data attaches to the object that precedes it", () => {
  const report = rgba();
  const ud = report.layers[0]!.userData;
  assert.ok(ud);
  assert.equal(ud.text, "notes — ünicode");
  assert.deepEqual(ud.color, [10, 20, 30, 255]);
  assert.deepEqual(ud.properties?.maps[0]?.properties, {
    visible: true,
    offset: -7,
    mask: 0xdeadbeef,
    weight: 0.125,
    label: "hero",
    anchor: { x: 3, y: -4 },
    hitbox: { x: 1, y: 2, w: 3, h: 4 },
    steps: [1, -2, 3],
    id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  });
  // The second layer got no user data of its own.
  assert.equal(report.layers[1]!.userData, undefined);
});

test("user data after a tags chunk is distributed one per tag", () => {
  const report = rgba();
  assert.deepEqual(
    report.tags.map((t) => [t.name, t.userData?.text ?? t.userData?.color]),
    [
      ["idle", "loop forever"],
      ["blink", [255, 0, 0, 255]],
    ],
  );
});

test("reads every cel type", () => {
  const report = rgba();
  const cels = report.frames.flatMap((f) => f.chunks.filter((c) => c.type === "cel"));
  assert.deepEqual(
    cels.map((c) => c.data.celType),
    [2, 3, 1, 0],
  );

  const compressed = cels[0]!.data;
  assert.deepEqual([compressed.x, compressed.y, compressed.w, compressed.h], [2, 1, 4, 4]);
  assert.equal(Number.isFinite(compressed.compressedBytes), true);

  // Raw pixels are measured, never copied into the report.
  const raw = cels[3]!.data;
  assert.equal(raw.rawBytes, 2 * 2 * 4);
  assert.equal(Object.hasOwn(raw, "pixels"), false);

  const tilemap = cels[1]!.data;
  assert.equal(tilemap.wTiles, 2);
  assert.equal(tilemap.bitsPerTile, 32);
  assert.equal(tilemap.idMask, 0x1fffffff);
});

test("cel extra carries fixed-point bounds", () => {
  const extra = rgba().frames[0]!.chunks.find((c) => c.type === "celExtra");
  assert.deepEqual(extra?.data.precise, { x: 2.5, y: 1.25, w: 4, h: 4 });
});

test("decoding cels infers tight bounds and tilemap summaries", () => {
  const report = inspectAseprite("rgba.aseprite", sampleRgbaFile(), { decodeCels: true });
  const cels = report.frames.flatMap((f) => f.chunks.filter((c) => c.type === "cel"));

  // A 2×2 opaque square at (1,1) inside a 4×4 cel.
  assert.deepEqual(cels[0]!.data.decodedBounds, { x: 1, y: 1, w: 2, h: 2 });

  // One of the four tiles carries the X-flip bit; tile id 0 is not a tile.
  assert.deepEqual(cels[1]!.data.decodedTilemapSummary, {
    nonZeroUniqueTileIds: 3,
    flippedTiles: 1,
  });

  // The linked cel borrows the target frame's decoded bounds and dimensions.
  const linked = cels[2]!.data;
  assert.equal(linked.celType, 1);
  assert.deepEqual(linked.decodedBounds, { x: 1, y: 1, w: 2, h: 2 });
  assert.deepEqual([linked.w, linked.h], [4, 4]);
});

test("without --decode-cels nothing is decompressed", () => {
  const cels = rgba().frames.flatMap((f) => f.chunks.filter((c) => c.type === "cel"));
  for (const cel of cels) {
    assert.equal(cel.data.decodedBounds, undefined);
    assert.equal(cel.data.decodedTilemapSummary, undefined);
  }
});

test("indexed transparency is the declared index, not alpha", () => {
  const bytes = sampleIndexedFile();
  const plain = inspectAseprite("indexed.aseprite", bytes, { decodeCels: true });
  const flagged = inspectAseprite("indexed.aseprite", bytes, {
    decodeCels: true,
    treatIndex0Transparent: true,
  });

  const boundsOf = (r: ReturnType<typeof inspectAseprite>) =>
    r.frames[0]!.chunks.find((c) => c.type === "cel")!.data.decodedBounds;

  // Index 2 is transparent, so the index-0 background still counts as drawn.
  assert.deepEqual(boundsOf(plain), { x: 0, y: 0, w: 4, h: 4 });
  // Opting index 0 in leaves only the index-3 square.
  assert.deepEqual(boundsOf(flagged), { x: 2, y: 2, w: 2, h: 2 });
});

test("a fully transparent cel has no bounds", () => {
  const empty = buildAseFile({
    width: 4,
    height: 4,
    colorDepth: 32,
    frames: [
      {
        durationMs: 50,
        chunks: [
          chunks.layer({ name: "blank" }),
          chunks.compressedCel({
            layerIndex: 0,
            x: 0,
            y: 0,
            w: 4,
            h: 4,
            pixels: new Uint8Array(4 * 4 * 4),
          }),
        ],
      },
    ],
  });
  const report = inspectAseprite("blank.aseprite", empty, { decodeCels: true });
  const chunk = report.frames[0]!.chunks[0]!;
  if (chunk.type !== "cel") throw new Error("expected a cel chunk");
  assert.equal(chunk.data.decodedBounds, null);
});

test("palette entries are previewed but all are consumed", () => {
  const bytes = sampleIndexedFile();
  const full = inspectAseprite("indexed.aseprite", bytes).palettes[0]!;
  assert.equal(full.changedCount, 4);
  assert.equal(full.entriesPreviewCount, 4);
  assert.deepEqual(full.entriesPreview, [
    { rgba: [0, 0, 0, 255], name: "black" },
    { rgba: [255, 255, 255, 255] },
    { rgba: [0, 0, 0, 0], name: "clear" },
    { rgba: [220, 60, 40, 255] },
  ]);

  // Truncating the preview must not desynchronise the reader: named entries
  // past the cut still have their names consumed.
  const clipped = inspectAseprite("indexed.aseprite", bytes, { paletteEntries: 1 });
  assert.equal(clipped.palettes[0]!.entriesPreviewCount, 1);
  assert.equal(clipped.palettes[0]!.changedCount, 4);
  assert.equal(clipped.frames[0]!.chunks.length, 1);
});

test("slices, tilesets and external files are read", () => {
  const report = rgba();
  assert.deepEqual(report.slices, [
    {
      name: "body",
      flags: 3,
      keys: [
        {
          frame: 0,
          bounds: { x: 1, y: 1, w: 6, h: 6 },
          center: { x: 2, y: 2, w: 2, h: 2 },
          pivot: { x: 3, y: 3 },
        },
      ],
    },
  ]);
  assert.deepEqual(report.tilesets, [
    { id: 0, flags: 0, numTiles: 4, tileW: 8, tileH: 8, baseIndex: 1, name: "terrain" },
  ]);
  assert.deepEqual(report.externalFiles, [
    { id: 0, type: 0, name: "palette.gpl" },
    { id: 1, type: 1, name: "tiles.aseprite" },
  ]);
  assert.deepEqual(report.colorProfile, { type: 1, flags: 0, gamma: 1, iccBytes: 0 });
});

test("unknown chunks are skipped by their declared size", () => {
  const report = rgba();
  assert.deepEqual(report.unknownChunks, [{ type: 0x0004, size: 18 }]);
  // Everything after the unknown chunk still parsed, so the skip was exact.
  assert.equal(report.frames[1]!.chunks.length, 2);
});

test("every chunk is summarised in order", () => {
  const summaries = rgba().frames[0]!.chunkSummaries!;
  assert.equal(summaries.length, 14);
  assert.deepEqual(summaries[0], { type: 0x2007, size: 22, parsed: { type: 1 } });
  assert.deepEqual(summaries.at(-1), { type: 0x0004, size: 18 });
});

test("a bad magic number is rejected", () => {
  const bytes = sampleRgbaFile();
  bytes[4] = 0;
  assert.throws(() => inspectAseprite("x.aseprite", bytes), {
    name: "AsepriteParseError",
    message: "Bad magic 0xa500 (expected 0xA5E0).",
  });
});

test("a truncated file reports how far it got", () => {
  assert.throws(() => inspectAseprite("x.aseprite", sampleRgbaFile().subarray(0, 60)), {
    message: "Unexpected EOF (wanted 128 bytes, got 60).",
  });
});

test("decompression is bounded", () => {
  assert.throws(
    () =>
      inspectAseprite("rgba.aseprite", sampleRgbaFile(), {
        decodeCels: true,
        maxDecompressMib: 0,
      }),
    { message: "Decompressed data exceeds limit (0 bytes)." },
  );
});

test("bounds inference rejects a payload of the wrong size", () => {
  assert.throws(() => inferBoundsFromPixels(new Uint8Array(10), 2, 2, 32, 0, false), {
    message: "Unexpected decoded pixel length (got 10, expected 16).",
  });
  assert.throws(() => inferBoundsFromPixels(new Uint8Array(0), 0, 0, 24, 0, false), {
    message: "Unsupported color depth: 24 bpp",
  });
  assert.ok(new AsepriteParseError("x") instanceof Error);
});

test("grayscale transparency reads the alpha byte", () => {
  // value/alpha pairs: only the second pixel is opaque.
  const pixels = Uint8Array.from([9, 0, 9, 255, 9, 0, 9, 0]);
  assert.deepEqual(inferBoundsFromPixels(pixels, 2, 2, 16, 0, false), {
    x: 1,
    y: 0,
    w: 1,
    h: 1,
  });
});
