import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { Bitmap } from "../../image/raster.js";
import { processSheet } from "../process-sheet.js";

const dir = mkdtempSync(path.join(tmpdir(), "process-sheet-"));

after(() => rmSync(dir, { force: true, recursive: true }));

const CELL = 64;

const writeBoard = (rows: number, cols: number) => {
  const board = Bitmap.create(CELL * cols, CELL * rows);

  for (let i = 0; i < board.data.length; i += 4) {
    board.data[i + 1] = 255;
    board.data[i + 3] = 255;
  }

  for (let k = 0; k < rows * cols; k += 1) {
    const left = (k % cols) * CELL;
    const top = Math.floor(k / cols) * CELL;

    for (let y = top + 16; y < top + 52; y += 1) {
      for (let x = left + 20; x < left + 44; x += 1) {
        const i = (y * board.width + x) * 4;
        board.data[i] = 200;
        board.data[i + 1] = 40;
        board.data[i + 2] = 60;
      }
    }
  }

  const file = path.join(dir, `board-${rows}x${cols}.png`);
  board.toFile(file);

  return file;
};

test("turns a pose board into a sheet, manifest, review gif and QC verdict", () => {
  const outDir = path.join(dir, "out");

  const result = processSheet({
    action: "walk",
    board: writeBoard(2, 4),
    cols: 4,
    outDir,
    rows: 2,
  });

  assert.equal(result.frames, 8);
  assert.equal(result.slicing, "naive");

  for (const file of [result.spritesheet, result.manifest, result.gif]) {
    assert.ok(existsSync(file), file);
  }

  const manifest = JSON.parse(readFileSync(result.manifest, "utf-8"));

  assert.equal(manifest.fps, result.fps);
  assert.ok(result.qc, "QC runs by default");
});

test("keeps the requested frames and skips QC when asked", () => {
  const result = processSheet({
    action: "walk",
    board: writeBoard(2, 4),
    cols: 4,
    frames: 3,
    outDir: path.join(dir, "out-3"),
    pixelSnap: false,
    qc: false,
    rows: 2,
  });

  assert.equal(result.frames, 3);
  assert.equal(result.qc, null);
});

test("reports a board that does not divide into its grid", () => {
  const warnings: string[] = [];

  processSheet({
    action: "walk",
    board: writeBoard(2, 4),
    cols: 3,
    outDir: path.join(dir, "out-uneven"),
    qc: false,
    rows: 2,
    warn: (message) => warnings.push(message),
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /does not divide evenly/u);
});
