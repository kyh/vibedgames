import assert from "node:assert/strict";
import { globSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { getAll, getFlag, getString, parseArgs } from "../src/args.js";
import { LuaParseError, parseLua } from "../src/asset/lua.js";
import { checkManifest, exportManifest } from "../src/asset/manifest.js";
import { parseFrame, prettyPath, walkFiles } from "../src/asset/paths.js";
import { analyzeBaseline, probeSheet } from "../src/asset/sheet.js";
import { collectSizes, sizesToCsv } from "../src/asset/sizes.js";
import { Bitmap } from "../src/image/raster.js";
import { createZip } from "../src/skill/zip.js";
import {
  cellSizeOf,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  loadSizeContract,
} from "../src/sprite/size-contract.js";
import { roundHalfToEven } from "../src/pymath.js";

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

  const exported = exportManifest(manifest, true) as Record<string, unknown>;
  const sprite = (exported.sprites as Record<string, unknown>[])[0]!;
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
  assert.equal(
    (exported.meta as Record<string, unknown>).root,
    ".",
    "root reset once paths are relative",
  );
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

// ---- argv parsing ---------------------------------------------------------

test("a declared boolean flag does not swallow the next positional", () => {
  const opts = { booleans: ["pretty", "decode-cels"] };
  // The ordering argparse accepted, and the one the usage text advertises.
  assert.deepEqual(parseArgs(["--pretty", "sprite.ase"], opts).positionals, ["sprite.ase"]);
  assert.equal(getFlag(parseArgs(["--pretty", "sprite.ase"], opts), "pretty"), true);

  const both = parseArgs(["--decode-cels", "--pretty", "a.ase"], opts);
  assert.deepEqual(both.positionals, ["a.ase"]);
  assert.equal(getFlag(both, "decode-cels"), true);
});

test("an option that takes a value still consumes it", () => {
  const args = parseArgs(["--out", "sheet.png", "in.png"], { booleans: ["pretty"] });
  assert.equal(getString(args, "out"), "sheet.png");
  assert.deepEqual(args.positionals, ["in.png"]);
});

test("-h is help, the way argparse gave every script for free", () => {
  assert.equal(getFlag(parseArgs(["-h"]), "help"), true);
  assert.equal(getFlag(parseArgs(["--help"]), "help"), true);
  // And it does not become a filename.
  assert.deepEqual(parseArgs(["-h"]).positionals, []);
});

test("-- ends option parsing", () => {
  const args = parseArgs(["--scale", "2", "--", "--not-an-option.png"]);
  assert.equal(getString(args, "scale"), "2");
  assert.deepEqual(args.positionals, ["--not-an-option.png"]);
});

test("--flag=value still works for a declared boolean", () => {
  const args = parseArgs(["--pretty=false", "x.ase"], { booleans: ["pretty"] });
  assert.equal(getFlag(args, "pretty"), false);
  assert.deepEqual(args.positionals, ["x.ase"]);
});

test("repeated options keep their order", () => {
  const args = parseArgs(["--fill-rect", "a", "--fill-rect", "b"]);
  assert.deepEqual(getAll(args, "fill-rect"), ["a", "b"]);
});

/**
 * The parser can only protect a flag it was told about, so a script that reads
 * `getFlag(args, "x")` without listing `"x"` silently re-opens the bug where
 * `--x FILE` eats the positional. Check every shipped script instead of
 * trusting that they were all updated.
 */
test("every skill script declares the boolean flags it reads", () => {
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const scripts = globSync("plugins/*/skills/*/scripts/*.mjs", { cwd: repoRoot }).map((rel) =>
    join(repoRoot, rel),
  );
  assert.ok(scripts.length >= 20, `expected the skill scripts, found ${scripts.length}`);

  const offenders: string[] = [];
  for (const path of scripts) {
    const source = readFileSync(path, "utf8");
    if (!source.includes('from "./_lib/asset-tools.mjs"')) continue;

    const read = [...source.matchAll(/getFlag\(\s*args\s*,\s*"([^"]+)"/g)].map((m) => m[1]!);
    if (read.length === 0) continue;

    const declared = new Set(
      [...(/booleans:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
        (m) => m[1]!,
      ),
    );
    const missing = [...new Set(read)].filter((name) => !declared.has(name));
    if (missing.length > 0) offenders.push(`${basename(path)}: ${missing.join(", ")}`);
  }
  assert.deepEqual(offenders, []);
});

/**
 * The check above only sees flags a script *reads*. A flag that is accepted and
 * ignored — kept because the Python original took it — is advertised in the
 * usage text, never passed to `getFlag`, and so was invisible: that is how
 * `aseprite_inspect.mjs --json file.ase` kept eating its filename after the
 * first fix. Anything a script's own text spells as `--flag` must therefore be
 * declared, read as a value, or visibly take one.
 */
test("every flag a script advertises is declared or takes a value", () => {
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const scripts = globSync("plugins/*/skills/*/scripts/*.mjs", { cwd: repoRoot }).map((rel) =>
    join(repoRoot, rel),
  );

  const offenders: string[] = [];
  for (const path of scripts) {
    const source = readFileSync(path, "utf8");
    if (!source.includes('from "./_lib/asset-tools.mjs"')) continue;

    const declared = new Set(
      [...(/booleans:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
        (m) => m[1]!,
      ),
    );
    const valued = new Set(
      [...source.matchAll(/get(?:String|Number|All)\(\s*args\s*,\s*"([^"]+)"/g)].map((m) => m[1]!),
    );
    // `--size WxH` / `--out <path>`: a metavar after the flag means it takes one.
    const metavar = new Set(
      [...source.matchAll(/--([a-z0-9][a-z0-9-]*)[= ](?:[A-Z_]{2,}|<)/g)].map((m) => m[1]!),
    );

    const advertised = new Set([...source.matchAll(/--([a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]!));
    const gap = [...advertised].filter(
      (name) => !declared.has(name) && !valued.has(name) && !metavar.has(name),
    );
    if (gap.length > 0) offenders.push(`${basename(path)}: ${gap.sort().join(", ")}`);
  }
  assert.deepEqual(offenders, []);
});

// ---- zip ------------------------------------------------------------------

test("filenames are flagged UTF-8 in both headers", () => {
  const zip = createZip([{ name: "assets/é.png", data: new Uint8Array([1, 2, 3]) }]);

  // Local header: signature at 0, general-purpose flags at offset 6.
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(6) & 0x0800, 0x0800, "local header missing the UTF-8 bit");

  // Central directory: find its signature, flags at offset 8 from there.
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0, "no central directory");
  assert.equal(zip.readUInt16LE(central + 8) & 0x0800, 0x0800, "central header missing the bit");

  // And the name really is UTF-8, which is what the bit is promising.
  const nameLength = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLength).toString("utf8"), "assets/é.png");
});

// ---- size contract --------------------------------------------------------

test("a malformed runtimeCell is rejected where the message can name the file", () => {
  const base = { kind: "sprite-size-contract" };
  assert.deepEqual(cellSizeOf(loadSizeContract(base, "c.json")).length, 2);

  for (const bad of ["64x64", [64], [64, 64, 64], ["64", "64"], [64, null], []]) {
    assert.throws(
      () => loadSizeContract({ ...base, runtimeCell: bad }, "contract.json"),
      /runtimeCell must be \[width, height\] numbers.*contract\.json/,
      `accepted ${JSON.stringify(bad)}`,
    );
  }

  const good = loadSizeContract({ ...base, runtimeCell: [96, 128.9] }, "c.json");
  assert.deepEqual(cellSizeOf(good), [96, 128]);
});

test("a non-object tolerances is rejected rather than spread", () => {
  assert.throws(
    () => loadSizeContract({ kind: "sprite-size-contract", tolerances: 3 }, "c.json"),
    /tolerances must be an object.*c\.json/,
  );
  const merged = loadSizeContract(
    { kind: "sprite-size-contract", tolerances: { visibleHeightPx: 9 } },
    "c.json",
  );
  assert.equal((merged.tolerances as Record<string, number>).visibleHeightPx, 9);
});

test("cellSizeOf falls back rather than producing NaN", () => {
  assert.deepEqual(cellSizeOf({}), [FRAME_WIDTH, FRAME_HEIGHT]);
  assert.deepEqual(cellSizeOf({ runtimeCell: "nonsense" }), [FRAME_WIDTH, FRAME_HEIGHT]);
});
