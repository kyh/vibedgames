import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LuaParseError, parseLua } from "../src/asset/lua.js";
import { checkManifest, exportManifest } from "../src/asset/manifest.js";
import { parseFrame, prettyPath, walkFiles } from "../src/asset/paths.js";
import { analyzeBaseline, probeSheet } from "../src/asset/sheet.js";
import { collectSizes, sizesToCsv } from "../src/asset/sizes.js";
import { Bitmap } from "../src/image/raster.js";
import { roundHalfToEven } from "../src/lib/pymath.js";

/**
 * Behavioural parity tests for the commands ported from
 * `plugins/asset-pipeline/skills/asset-pipeline/scripts/*.py`. The expected
 * values here were produced by running those Python scripts against the same
 * generated corpus.
 */

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "vg-asset-"));
}

/**
 * A sheet whose sprites sit at a different vertical offset per cell, with a
 * softer alpha border — the drift that `sprite-baseline` exists to remove.
 */
function buildSheet(
  path: string,
  cols: number,
  rows: number,
  frame: number,
  skip: Set<string> = new Set(),
): void {
  const sheet = Bitmap.create(cols * frame, rows * frame);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (skip.has(`${c},${r}`)) continue;
      const offset = (c + r) % 5;
      const size = frame / 2;
      const x0 = c * frame + (frame - size) / 2;
      const y0 = r * frame + (frame - size) - offset;
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const alpha = x > 1 && x < size - 2 && y > 1 ? 255 : 128;
          sheet.putPixel(x0 + x, y0 + y, [(c * 40 + 30) % 256, (r * 70 + 20) % 256, 200, alpha]);
        }
      }
    }
  }
  sheet.toFile(path);
}

test("parseFrame accepts WxH and rejects anything else", () => {
  assert.deepEqual(parseFrame("32x32"), { width: 32, height: 32 });
  assert.deepEqual(parseFrame(" 256 X 128 "), { width: 256, height: 128 });
  assert.throws(() => parseFrame("32"), /WxH/);
  assert.throws(() => parseFrame("0x8"), /positive/);
});

test("sheet-probe reports the grid and which cells hold art", () => {
  const dir = workspace();
  const sheet = join(dir, "hero.png");
  buildSheet(sheet, 4, 2, 32, new Set(["3,1", "0,1"]));

  const result = probeSheet(sheet, { width: 32, height: 32 }, true);
  assert.deepEqual(result.grid, { columns: 4, rows: 2 });
  assert.equal(result.non_empty.length, 6);
  assert.equal(result.empty_count, 2);
  assert.deepEqual(result.empty, [
    [0, 1],
    [3, 1],
  ]);
  // Column-major ordering, matching Python's tuple sort.
  assert.deepEqual(result.non_empty[0], [0, 0]);
  assert.deepEqual(result.non_empty.at(-1), [3, 0]);
});

test("sheet-probe refuses a frame size that doesn't divide the sheet", () => {
  const dir = workspace();
  const sheet = join(dir, "hero.png");
  buildSheet(sheet, 4, 2, 32);
  assert.throws(() => probeSheet(sheet, { width: 30, height: 32 }, false), /not divisible/);
});

test("sprite-baseline measures per-frame drift and normalises it away", () => {
  const dir = workspace();
  const sheet = join(dir, "hero.png");
  const fixed = join(dir, "fixed.png");
  buildSheet(sheet, 4, 2, 32, new Set(["3,1", "0,1"]));

  const before = analyzeBaseline(sheet, { width: 32, height: 32 }, 30, 16, fixed);
  // Sprites were authored 0-4px apart vertically, so the audit must see a range.
  assert.notDeepEqual(before.visibleBottomYRange, null);
  assert.ok(
    before.visibleBottomYRange![1] > before.visibleBottomYRange![0],
    "expected the corpus to actually drift",
  );
  assert.equal(before.frames.filter((f) => f.empty).length, 2);

  // Re-auditing the corrected sheet must show every sprite on one baseline.
  const after = analyzeBaseline(fixed, { width: 32, height: 32 }, 30, 16, null);
  assert.deepEqual(after.visibleBottomYRange, [30, 30], "all frames share the target baseline");
  assert.deepEqual(after.shiftYRange, [0, 0], "nothing left to correct");
});

test("sprite-baseline rounds half-way shifts the way Python does", () => {
  // A 16px sprite centred in a 32px frame sits at centre 15.5; targeting 16
  // asks for a 0.5px shift, which Python resolves to 0, not 1.
  assert.equal(roundHalfToEven(0.5), 0);
  assert.equal(roundHalfToEven(1.5), 2);
  assert.equal(roundHalfToEven(2.5), 2);
  assert.equal(roundHalfToEven(-0.5), 0);
  assert.equal(roundHalfToEven(-1.5), -2);
  assert.equal(roundHalfToEven(-2.5), -2);
  assert.equal(roundHalfToEven(2.4), 2);
  assert.equal(roundHalfToEven(2.6), 3);

  const dir = workspace();
  const sheet = join(dir, "hero.png");
  buildSheet(sheet, 1, 1, 32);
  const report = analyzeBaseline(sheet, { width: 32, height: 32 }, 30, 16, null);
  assert.equal(report.frames[0]!.visibleCenterX, 15.5);
  assert.deepEqual(report.frames[0]!.shiftToTarget![0], 0, "half-way shift rounds to even");
});

test("sizes walks a tree and renders CSV", () => {
  const dir = workspace();
  buildSheet(join(dir, "b.png"), 2, 2, 16);
  buildSheet(join(dir, "a.png"), 1, 1, 8);

  const rows = collectSizes(dir);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => `${r.width}x${r.height}`),
    ["8x8", "32x32"],
    "sorted by path, so a.png precedes b.png",
  );
  assert.match(sizesToCsv(rows), /^width,height,path\n8,8,/);
});

test("walkFiles sorts by path and ignores other extensions", () => {
  const dir = workspace();
  buildSheet(join(dir, "z.png"), 1, 1, 8);
  buildSheet(join(dir, "a.png"), 1, 1, 8);
  writeFileSync(join(dir, "notes.txt"), "ignore me");
  const found = walkFiles(dir).map((p) => p.slice(dir.length + 1));
  assert.deepEqual(found, ["a.png", "z.png"]);
});

test("prettyPath prefers a cwd-relative rendering", () => {
  assert.equal(prettyPath(join(process.cwd(), "src", "index.ts")), join("src", "index.ts"));
});

test("parses Lua manifests into JSON-shaped data", () => {
  const parsed = parseLua(`
    -- a comment
    --[[ a long
         comment ]]
    return {
      meta = { root = "assets", version = 2 },
      sprites = {
        { name = "hero", path = "assets/hero.png", frameW = 32, ratio = 1.5 },
      },
      flags = { true, false, nil },
      [3] = "sparse",
      escaped = "a\\tb",
    }
  `);
  const root = parsed as Record<string, unknown>;
  assert.deepEqual(root.meta, { root: "assets", version: 2 });
  // 1..n keys collapse to an array; a gap keeps it an object.
  assert.ok(Array.isArray(root.sprites));
  assert.deepEqual(root.flags, [true, false, null]);
  assert.equal(root.escaped, "a\tb");
  assert.equal((root as Record<string, unknown>)["3"], "sparse");
});

test("reports Lua syntax errors instead of silently returning junk", () => {
  assert.throws(() => parseLua("return { unterminated = 'oops }"), LuaParseError);
  assert.throws(() => parseLua("return { } trailing"), /Trailing tokens/);
  assert.throws(() => parseLua("return { key = someFunction }"), /Unsupported identifier/);
});

test("manifest-export renames terse keys and rebases paths", () => {
  const dir = workspace();
  const manifest = join(dir, "assets_index.lua");
  writeFileSync(
    manifest,
    `return {
       meta = { root = "assets" },
       sprites = { { path = "${join(dir, "hero.png").replaceAll("\\", "/")}", w = 4, h = 8, frameW = 2, frameH = 3, tileW = 5, tileH = 6 } },
     }`,
  );
  buildSheet(join(dir, "hero.png"), 1, 1, 8);

  const exported = exportManifest(manifest, true) as Record<string, any>;
  const sprite = exported.sprites[0];
  assert.deepEqual(Object.keys(sprite).sort(), [
    "frameHeight",
    "frameWidth",
    "height",
    "path",
    "tileHeight",
    "tileWidth",
    "width",
  ]);
  assert.equal(sprite.path, "hero.png", "path rebased onto the manifest folder");
  assert.equal(exported.meta.root, ".", "root reset once paths are relative");
});

test("manifest-check separates undeclared art from missing art", () => {
  const dir = workspace();
  buildSheet(join(dir, "declared.png"), 1, 1, 8);
  buildSheet(join(dir, "undeclared.png"), 1, 1, 8);
  const manifest = join(dir, "assets_index.lua");
  writeFileSync(
    manifest,
    `return { sprites = {
       { path = "declared.png" },
       { path = "ghost.png" },
     } }`,
  );

  const report = checkManifest(manifest, dir);
  assert.equal(report.actual_pngs, 2);
  assert.equal(report.manifest_paths, 2);
  assert.equal(report.missing.length, 1, "undeclared.png is on disk but unlisted");
  assert.match(report.missing[0]!, /undeclared\.png$/);
  assert.equal(report.extra.length, 1, "ghost.png is listed but absent");
  assert.match(report.extra[0]!, /ghost\.png$/);
});

test("manifest-check reads JSON manifests and honours meta.root", () => {
  const dir = workspace();
  buildSheet(join(dir, "hero.png"), 1, 1, 8);
  const manifest = join(dir, "assets_index.json");
  writeFileSync(manifest, JSON.stringify({ meta: { root: "." }, sprites: [{ path: "hero.png" }] }));
  const report = checkManifest(manifest, dir);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.extra, []);
});

test("written PNGs are readable by the decoder that wrote them", () => {
  const dir = workspace();
  const path = join(dir, "roundtrip.png");
  buildSheet(path, 2, 1, 16);
  const reread = Bitmap.fromFile(path);
  assert.deepEqual([reread.width, reread.height], [32, 16]);
  assert.ok(readFileSync(path).length > 0);
});
