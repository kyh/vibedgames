#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  actionFacts,
  Bitmap,
  buildSequenceGif,
  cleanChroma,
  DEFAULT_SNAP_CONFIG,
  fail,
  failUsage,
  getFlag,
  getInt,
  getNumber,
  getString,
  globFrames,
  main,
  normalizeCanvas,
  packSpritesheet,
  parseArgs,
  parseColor,
  recoverFrames,
  runQc,
  snapImage,
  toPythonJson,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

const frameName = (i) => `frame-${String(i).padStart(2, "0")}.png`;

const sliceGrid = (board, rows, cols, frames, outDir) => {
  const image = Bitmap.fromFile(board);

  if (image.width % cols || image.height % rows) {
    process.stderr.write(
      `[process_sheet] warning: board ${image.width}x${image.height} does not divide evenly into ` +
        `${cols}x${rows} cells (${image.width % cols}px wide / ${image.height % rows}px tall remainder ` +
        `dropped). Regenerate at a divisible size or adjust --rows/--cols if frames look shifted.\n`,
    );
  }

  const cw = Math.floor(image.width / cols);
  const ch = Math.floor(image.height / rows);
  const count = Math.min(frames, rows * cols);

  for (let i = 0; i < count; i += 1) {
    const r = Math.floor(i / cols);
    const c = i - r * cols;
    image
      .crop({ bottom: (r + 1) * ch, left: c * cw, right: (c + 1) * cw, top: r * ch })
      .toFile(path.join(outDir, frameName(i + 1)));
  }

  return count;
};

const recoverGrid = (board, rows, cols, frames, outDir) => {
  try {
    const { crops } = recoverFrames(board, { cols, frames, rows, threshold: 15 });

    for (const crop of crops) {
      crop.image.toFile(path.join(outDir, `frame-${crop.label}.png`));
    }

    return crops.length;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[process_sheet] --recover fell back to uniform slice: ${reason}\n`);

    return sliceGrid(board, rows, cols, frames, outDir);
  }
};

const pixelSnapFrames = (framesDir, kColors) => {
  const paths = globFrames(framesDir, "frame-*.png");

  if (paths.length === 0) {
    return;
  }

  const images = paths.map((p) => Bitmap.fromFile(p));
  const n = images.length;
  const cw = Math.max(...images.map((im) => im.width));
  const ch = Math.max(...images.map((im) => im.height));

  const strip = Bitmap.create(cw * n, ch);

  for (const [i, im] of images.entries()) {
    const x = i * cw + Math.floor((cw - im.width) / 2);
    const y = Math.floor((ch - im.height) / 2);
    strip.pasteMasked(im, x, y, im.channel(3));
  }

  const stripPath = path.join(framesDir, "_snap_strip.png");
  strip.toFile(stripPath);
  const snapped = snapImage(stripPath, { ...DEFAULT_SNAP_CONFIG, kColors });
  unlinkSync(stripPath);

  const fw = Math.floor(snapped.width / n);

  for (const [i, framePath] of paths.entries()) {
    const right = i === n - 1 ? snapped.width : (i + 1) * fw;
    snapped.crop({ bottom: snapped.height, left: i * fw, right, top: 0 }).toFile(framePath);
  }
};

const readOptions = (args) => {
  const [board] = args.positionals;

  if (!board) {
    failUsage("a pose board PNG is required");
  }

  if (!existsSync(board)) {
    fail(`board not found: ${board}`);
  }

  const action = getString(args, "action");

  if (!action) {
    failUsage("--action is required");
  }

  const outDir = getString(args, "out-dir");

  if (!outDir) {
    failUsage("--out-dir is required");
  }

  const rows = getInt(args, "rows", 0);
  const cols = getInt(args, "cols", 0);

  if (rows <= 0 || cols <= 0) {
    fail("--rows and --cols must be positive integers");
  }

  const charFill = getNumber(args, "char-fill", 0.5);

  if (!(charFill > 0 && charFill <= 1)) {
    fail("--char-fill must be in (0, 1]");
  }

  const snapKColors = getInt(args, "snap-k-colors", 16);

  if (snapKColors <= 0) {
    fail("--snap-k-colors must be a positive integer");
  }

  const facts = actionFacts(action);
  const requested = getString(args, "frames");

  if (requested !== undefined && getInt(args, "frames", 0) <= 0) {
    fail("--frames must be a positive integer");
  }

  const frames =
    requested === undefined
      ? Math.min(facts.defaultFrames, rows * cols)
      : getInt(args, "frames", 0);

  return { action, board, charFill, cols, fps: facts.fps, frames, outDir, rows, snapKColors };
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["json", "no-pixel-snap", "no-qc", "recover"],
    values: ["action", "char-fill", "chroma", "cols", "frames", "out-dir", "rows", "snap-k-colors"],
  });

  const { action, board, charFill, cols, fps, frames, outDir, rows, snapKColors } =
    readOptions(args);

  const dCells = path.join(outDir, "cells");
  const dKeyed = path.join(outDir, "_keyed");
  const dRuntime = path.join(outDir, "runtime");
  const dReview = path.join(outDir, "review");

  for (const dir of [dCells, dKeyed, dRuntime]) {
    rmSync(dir, { force: true, recursive: true });
  }

  const recover = getFlag(args, "recover");

  const n = recover
    ? recoverGrid(board, rows, cols, frames, dCells)
    : sliceGrid(board, rows, cols, frames, dCells);

  const chroma = parseColor(getString(args, "chroma") ?? "#00FF00").slice(0, 3);

  for (const framePath of globFrames(dCells, "frame-*.png")) {
    const result = cleanChroma(Bitmap.fromFile(framePath), { chroma });
    result.image.toFile(path.join(dKeyed, framePath.slice(dCells.length + 1)));
  }

  if (!getFlag(args, "no-pixel-snap")) {
    pixelSnapFrames(dKeyed, snapKColors);
  }

  normalizeCanvas(dKeyed, dRuntime, {
    canvas: { height: 256, width: 256 },
    charFill,
    glob: "frame-*.png",
  });

  const sheetPng = path.join(outDir, "spritesheet.png");
  const sheetJson = path.join(outDir, "spritesheet.json");
  const packed = packSpritesheet(dRuntime, sheetPng, { action, fps, glob: "frame-*.png" });
  packed.sheet.toFile(sheetPng);
  writeJsonFile(sheetJson, packed.manifest);

  const gif = path.join(dReview, `${action}.gif`);
  const delay = Math.round(1000 / fps);

  const gifBytes = buildSequenceGif(
    Array.from({ length: n }, (_, i) => ({
      delayMs: delay,
      path: path.join(dRuntime, frameName(i + 1)),
    })),
    null,
  );

  mkdirSync(dReview, { recursive: true });
  writeFileSync(gif, gifBytes);

  const qc = getFlag(args, "no-qc") ? null : runQc(sheetPng, null, null);

  const summary = {
    action,
    fps,
    frames: n,
    gif,
    path: "image",
    pixelSnap: !getFlag(args, "no-pixel-snap"),
    qc: qc ? qc.verdict : "skipped",
    runtimeFrames: dRuntime,
    slicing: recover ? "recover" : "naive",
    spritesheet: sheetPng,
  };

  if (getFlag(args, "json")) {
    if (qc) {
      summary.qcChecks = qc.checks;
    }

    console.log(toPythonJson(summary));

    return;
  }

  const lines = [
    `\n=== ${action} (image): ${n} frames @ ${fps}fps ===`,
    `  sheet: ${sheetPng}`,
    `  gif: ${gif}`,
  ];

  if (qc) {
    lines.push(`  qc: [${qc.verdict.toUpperCase()}]`);

    for (const check of qc.checks) {
      lines.push(
        `      ${check.severity === "warn" ? "!" : "?"} ${check.check}: ` +
          `frames [${check.frames.join(", ")}] — ${check.detail}`,
      );
    }
  }

  console.log(lines.join("\n"));
});
