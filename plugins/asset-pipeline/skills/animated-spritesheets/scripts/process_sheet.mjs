#!/usr/bin/env node
/**
 * One command: turn a generated image pose board / strip into runtime frames.
 *
 * You generate ONE image whose cells are the animation frames — a uniform
 * R x C grid (or a 1-row strip) of the same character in different poses —
 * then this slices it on that grid, cleans the matte, normalizes every frame
 * to a shared anchor, and packs the spritesheet.
 *
 * By default it assumes a UNIFORM grid (how hand-authored sheets are laid out,
 * and what you should prompt the model for) and slices it directly — far more
 * predictable than recovering drifted blobs. Pass --recover to run
 * connected-component recovery instead, which tolerates a pose spilling across
 * cell borders. Pixel snapping is on by default; --no-pixel-snap keeps the
 * smooth high-res look for painterly sprites.
 *
 * Pipeline: (slice grid | --recover components) -> chroma clean (per cell) ->
 * [pixel-snap as one shared-pitch strip] -> normalize (shared-transform anchor)
 * -> pack -> qc -> gif.
 *
 * Unlike the Python version this calls the shared library directly instead of
 * spawning a subprocess per step, so there is no `uv` and no process overhead.
 *
 * Example:
 *   node process_sheet.mjs board.png --action attack --rows 2 --cols 2 \
 *     --out-dir runs/hero-attack-img
 */
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  actionFacts,
  Bitmap,
  buildSequenceGif,
  cleanChroma,
  DEFAULT_SNAP_CONFIG,
  fail,
  getFlag,
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

/** Uniform grid slice — the default, and the fallback when recovery fails. */
function sliceGrid(board, rows, cols, frames, outDir) {
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
      .crop({ left: c * cw, top: r * ch, right: (c + 1) * cw, bottom: (r + 1) * ch })
      .toFile(join(outDir, frameName(i + 1)));
  }
  return count;
}

/**
 * Connected-component recovery, which re-centres a pose that drifted off-grid.
 * It cannot separate poses that *merged* into one blob (a wide swing bridging
 * two cells reads as a single component), so a failure falls back to a uniform
 * slice rather than aborting — passing --recover is always safe.
 */
function recoverGrid(board, rows, cols, frames, outDir) {
  try {
    const { crops } = recoverFrames(board, { rows, cols, frames, threshold: 15 });
    for (const crop of crops) crop.image.toFile(join(outDir, `frame-${crop.label}.png`));
    return crops.length;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[process_sheet] --recover fell back to uniform slice: ${reason}\n`);
    return sliceGrid(board, rows, cols, frames, outDir);
  }
}

/**
 * Snap every frame onto ONE shared native pixel grid, in place, before
 * normalize.
 *
 * The frames are assembled into a single strip and that strip is snapped once,
 * so the snapper discovers a single pitch for the whole action. Snapping each
 * frame independently would recover a slightly different pitch per frame,
 * drifting the character's size between frames — a "breathing" wobble that
 * normalize re-centres but cannot rescale away. One strip = one pitch = one
 * scale.
 */
function pixelSnapFrames(framesDir, kColors) {
  const paths = globFrames(framesDir, "frame-*.png");
  if (paths.length === 0) return;

  const images = paths.map((p) => Bitmap.fromFile(p));
  const n = images.length;
  const cw = Math.max(...images.map((im) => im.width));
  const ch = Math.max(...images.map((im) => im.height));

  const strip = Bitmap.create(cw * n, ch);
  images.forEach((im, i) => {
    const x = i * cw + Math.floor((cw - im.width) / 2);
    const y = Math.floor((ch - im.height) / 2);
    strip.pasteMasked(im, x, y, im.channel(3));
  });

  const stripPath = join(framesDir, "_snap_strip.png");
  strip.toFile(stripPath);
  const snapped = snapImage(stripPath, { ...DEFAULT_SNAP_CONFIG, kColors });
  unlinkSync(stripPath);

  // The character sits in the centred margin, so a sub-pixel boundary drift
  // lands in empty space and normalize re-crops it away.
  const fw = Math.floor(snapped.width / n);
  paths.forEach((path, i) => {
    const right = i === n - 1 ? snapped.width : (i + 1) * fw;
    snapped.crop({ left: i * fw, top: 0, right, bottom: snapped.height }).toFile(path);
  });
}

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["json", "no-pixel-snap", "no-qc", "recover"],
  });
  const board = args.positionals[0];
  if (!board) fail("a pose board PNG is required");
  if (!existsSync(board)) fail(`board not found: ${board}`);

  const action = getString(args, "action");
  if (!action) fail("--action is required");
  const outDir = getString(args, "out-dir");
  if (!outDir) fail("--out-dir is required");

  const rows = getNumber(args, "rows", 0);
  const cols = getNumber(args, "cols", 0);
  if (rows <= 0 || cols <= 0) fail("--rows and --cols must be positive integers");

  const charFill = getNumber(args, "char-fill", 0.5);
  if (!(charFill > 0 && charFill <= 1)) fail("--char-fill must be in (0, 1]");
  const snapKColors = getNumber(args, "snap-k-colors", 16);
  if (snapKColors <= 0) fail("--snap-k-colors must be a positive integer");

  const facts = actionFacts(action);
  const fps = facts.fps;
  const cells = rows * cols;
  // Default to the preset's recommended frame count (the board was prompted
  // for that many), not rows*cols — trailing grid cells are flat chroma and
  // would pack as junk.
  const requested = getString(args, "frames");
  if (requested !== undefined && getNumber(args, "frames", 0) <= 0) {
    fail("--frames must be a positive integer");
  }
  const frames =
    requested === undefined ? Math.min(facts.defaultFrames, cells) : getNumber(args, "frames", 0);

  const dCells = join(outDir, "cells");
  const dKeyed = join(outDir, "_keyed");
  const dRuntime = join(outDir, "runtime");
  const dReview = join(outDir, "review");
  // Clear intermediates so a rerun (especially with fewer --frames) cannot
  // pack stale frames.
  for (const dir of [dCells, dKeyed, dRuntime]) rmSync(dir, { recursive: true, force: true });

  const recover = getFlag(args, "recover");
  const n = recover
    ? recoverGrid(board, rows, cols, frames, dCells)
    : sliceGrid(board, rows, cols, frames, dCells);

  const chroma = parseColor(getString(args, "chroma") ?? "#00FF00").slice(0, 3);
  for (const path of globFrames(dCells, "frame-*.png")) {
    const result = cleanChroma(Bitmap.fromFile(path), { chroma });
    result.image.toFile(join(dKeyed, path.slice(dCells.length + 1)));
  }

  if (!getFlag(args, "no-pixel-snap")) pixelSnapFrames(dKeyed, snapKColors);

  normalizeCanvas(dKeyed, dRuntime, {
    glob: "frame-*.png",
    canvas: { width: 256, height: 256 },
    charFill,
  });

  const sheetPng = join(outDir, "spritesheet.png");
  const sheetJson = join(outDir, "spritesheet.json");
  const packed = packSpritesheet(dRuntime, sheetPng, { glob: "frame-*.png", fps, action });
  packed.sheet.toFile(sheetPng);
  writeJsonFile(sheetJson, packed.manifest);

  const gif = join(dReview, `${action}.gif`);
  const delay = Math.round(1000 / fps);
  const gifBytes = buildSequenceGif(
    Array.from({ length: n }, (_, i) => ({
      path: join(dRuntime, frameName(i + 1)),
      delayMs: delay,
    })),
    null,
  );
  mkdirSync(dReview, { recursive: true });
  writeFileSync(gif, gifBytes);

  const qc = getFlag(args, "no-qc") ? null : runQc(sheetPng, null, null);

  const summary = {
    action,
    frames: n,
    fps,
    path: "image",
    slicing: recover ? "recover" : "naive",
    pixelSnap: !getFlag(args, "no-pixel-snap"),
    spritesheet: sheetPng,
    gif,
    runtimeFrames: dRuntime,
    qc: qc ? qc.verdict : "skipped",
  };

  if (getFlag(args, "json")) {
    if (qc) summary.qcChecks = qc.checks;
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
