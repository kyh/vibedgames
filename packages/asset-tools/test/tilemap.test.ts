import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  cropBox,
  exportMapRender,
  exportTilesetGrid,
  loadManifestJson,
  makeSelftestMap,
  nonEmptyTileIds,
  sanitizeTilesets,
  tileCount,
  tileIdFromColRow,
  tilesetMetaFromManifest,
} from "../src/asset/tilemap.js";
import { drawDigits, drawLine, fillRect, strokeRect } from "../src/image/draw.js";
import { Bitmap } from "../src/image/raster.js";

/**
 * Parity tests for the headless exports ported from `asset_tilemap_editor.py`.
 * Expected values come from running that script over the same generated
 * tileset; its grid overlays and map renders match these byte for byte.
 */

const TILE = 16;
const COLS = 5;
const ROWS = 3;
const MARGIN = 2;
const SPACING = 1;

/** A tileset with margin and spacing, so the grid maths is actually exercised. */
function buildTileset(dir: string): string {
  const width = MARGIN * 2 + COLS * TILE + (COLS - 1) * SPACING;
  const height = MARGIN * 2 + ROWS * TILE + (ROWS - 1) * SPACING;
  const sheet = Bitmap.create(width, height);
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      if ((c + r) % 7 === 3) continue; // leave some tiles empty
      const x0 = MARGIN + c * (TILE + SPACING);
      const y0 = MARGIN + r * (TILE + SPACING);
      for (let y = 0; y < TILE; y += 1) {
        for (let x = 0; x < TILE; x += 1) {
          sheet.putPixel(x0 + x, y0 + y, [
            (c * 50 + 20) % 256,
            (r * 80 + 40) % 256,
            (x * 16) % 256,
            x % 5 ? 255 : 120,
          ]);
        }
      }
    }
  }
  const path = join(dir, "tiles.png");
  sheet.toFile(path);
  writeFileSync(
    join(dir, "assets_index.json"),
    JSON.stringify({
      tilesets: {
        main: {
          path: "tiles.png",
          tileWidth: TILE,
          tileHeight: TILE,
          margin: MARGIN,
          spacing: SPACING,
        },
      },
    }),
  );
  return join(dir, "assets_index.json");
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "vg-tilemap-"));
}

function meta(dir: string) {
  const manifestPath = buildTileset(dir);
  return tilesetMetaFromManifest(manifestPath, loadManifestJson(manifestPath), "main");
}

test("derives the tile grid from the image when the manifest omits it", () => {
  const m = meta(workspace());
  assert.equal(m.columns, COLS);
  assert.equal(m.rows, ROWS);
  assert.equal(tileCount(m), COLS * ROWS);
});

test("tile IDs are 1-based row-major, and 0 means no tile", () => {
  const m = meta(workspace());
  assert.equal(tileIdFromColRow(m, 0, 0), 1);
  assert.equal(tileIdFromColRow(m, COLS - 1, 0), COLS);
  assert.equal(tileIdFromColRow(m, 0, 1), COLS + 1);
  assert.equal(tileIdFromColRow(m, -1, 0), 0, "out of range reads as empty");
  assert.equal(tileIdFromColRow(m, COLS, 0), 0);
});

test("crop boxes account for margin and spacing", () => {
  const m = meta(workspace());
  assert.deepEqual(cropBox(m, 1), { left: 2, top: 2, right: 18, bottom: 18 });
  // Second column starts one tile plus one spacing pixel further right, and
  // stays on row 0.
  assert.deepEqual(cropBox(m, 2), { left: 19, top: 2, right: 35, bottom: 18 });
  // First tile of row 1 drops by one tile plus one spacing pixel.
  assert.deepEqual(cropBox(m, COLS + 1), { left: 2, top: 19, right: 18, bottom: 35 });
});

test("rejects a manifest without a usable tilesets block", () => {
  assert.throws(() => sanitizeTilesets({}), /missing `tilesets`/);
  assert.throws(() => sanitizeTilesets({ tilesets: { a: { noPath: 1 } } }), /no usable tilesets/);
});

test("the self-test map places every non-empty tile at its own coordinate", () => {
  const m = meta(workspace());
  const nonEmpty = nonEmptyTileIds(m);
  const map = makeSelftestMap(m) as { meta: Record<string, unknown>; data: number[][] };

  assert.equal(map.meta.width, COLS);
  assert.equal(map.meta.height, ROWS);
  assert.equal(map.data.length, ROWS);
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const id = tileIdFromColRow(m, c, r);
      assert.equal(map.data[r]![c], nonEmpty.has(id) ? id : 0);
    }
  }
  // The corpus deliberately blanks some cells, so this must not be all-nonzero.
  assert.ok(map.data.flat().includes(0), "expected some empty tiles");
});

test("renders a tilemap at the requested scale", () => {
  const dir = workspace();
  const m = meta(dir);
  const out = join(dir, "render.png");
  writeFileSync(
    join(dir, "level.json"),
    JSON.stringify({
      meta: { width: 4, height: 3 },
      data: [
        [1, 2, 0, 4],
        [5, 0, 7, 8],
        [0, 11, 12, 0],
      ],
    }),
  );

  exportMapRender(m, out, {
    mapPayload: loadManifestJson(join(dir, "level.json")),
    scale: 2,
    background: [16, 32, 48, 255],
    fills: [],
    trim: false,
  });

  const rendered = Bitmap.fromFile(out);
  assert.deepEqual([rendered.width, rendered.height], [4 * TILE * 2, 3 * TILE * 2]);
  // A zero tile leaves the background showing through.
  assert.deepEqual(rendered.getPixel(2 * TILE * 2 + 4, 4), [16, 32, 48, 255]);
});

test("map render infers dimensions when meta omits them", () => {
  const dir = workspace();
  const m = meta(dir);
  const out = join(dir, "render.png");
  writeFileSync(join(dir, "level.json"), JSON.stringify({ data: [[1, 2, 3]] }));
  exportMapRender(m, out, {
    mapPayload: loadManifestJson(join(dir, "level.json")),
    scale: 1,
    background: null,
    fills: [],
    trim: false,
  });
  const rendered = Bitmap.fromFile(out);
  assert.deepEqual([rendered.width, rendered.height], [3 * TILE, TILE]);
});

test("grid overlay scales the sheet and can label tile IDs", () => {
  const dir = workspace();
  const m = meta(dir);
  const plain = join(dir, "grid.png");
  const labelled = join(dir, "grid-labelled.png");

  exportTilesetGrid(m, plain, { scale: 3, labelIds: false, trim: false });
  exportTilesetGrid(m, labelled, { scale: 3, labelIds: true, trim: false });

  const a = Bitmap.fromFile(plain);
  const b = Bitmap.fromFile(labelled);
  assert.deepEqual([a.width, a.height], [m.imageW * 3, m.imageH * 3]);
  assert.deepEqual([b.width, b.height], [a.width, a.height]);
  assert.notEqual(
    Buffer.from(a.data).toString("base64"),
    Buffer.from(b.data).toString("base64"),
    "labelling must actually change pixels",
  );
});

test("draw primitives write ink directly rather than blending", () => {
  // Grid overlays rely on this: a translucent ink is stored as-is, not
  // composited over what was underneath.
  const bmp = Bitmap.create(8, 8, [0, 0, 0, 255]);
  drawLine(bmp, 0, 0, 7, 0, [255, 255, 255, 80]);
  assert.deepEqual(bmp.getPixel(3, 0), [255, 255, 255, 80]);

  fillRect(bmp, 2, 2, 4, 4, [10, 20, 30, 40]);
  assert.deepEqual(bmp.getPixel(2, 2), [10, 20, 30, 40]);
  assert.deepEqual(bmp.getPixel(4, 4), [10, 20, 30, 40], "both corners are inclusive");
  assert.deepEqual(bmp.getPixel(5, 5), [0, 0, 0, 255], "and it stops there");
});

test("strokeRect thickens inward", () => {
  const bmp = Bitmap.create(8, 8, [0, 0, 0, 255]);
  strokeRect(bmp, 0, 0, 7, 7, [1, 2, 3, 4], 2);
  assert.deepEqual(bmp.getPixel(0, 0), [1, 2, 3, 4]);
  assert.deepEqual(bmp.getPixel(1, 1), [1, 2, 3, 4], "second ring is inside the first");
  assert.deepEqual(bmp.getPixel(2, 2), [0, 0, 0, 255], "and no further");
});

test("digit labels take ink outright over transparent pixels", () => {
  // Pillow lerps a glyph's coverage against the destination, except where the
  // destination is fully transparent — there the ink colour wins outright.
  // Blending instead turns white labels over empty tiles into grey mush.
  const transparent = Bitmap.create(12, 14);
  drawDigits(transparent, 0, 0, "8", [255, 255, 255, 200]);
  let sawInk = false;
  for (let y = 0; y < 14; y += 1) {
    for (let x = 0; x < 12; x += 1) {
      const [r, g, b, a] = transparent.getPixel(x, y);
      if (a === 0) continue;
      sawInk = true;
      assert.deepEqual([r, g, b], [255, 255, 255], `pixel ${x},${y} kept the ink colour`);
      assert.ok(a <= 200, "alpha never exceeds the ink's own");
    }
  }
  assert.ok(sawInk, "expected the glyph to draw something");

  // Over an opaque background the same glyph blends normally.
  const opaque = Bitmap.create(12, 14, [0, 0, 0, 255]);
  drawDigits(opaque, 0, 0, "8", [255, 255, 255, 200]);
  const shades = new Set<number>();
  for (let x = 0; x < 12; x += 1) shades.add(opaque.getPixel(x, 5)[0]);
  assert.ok(shades.size > 2, "expected antialiased shades, not a hard mask");
});
