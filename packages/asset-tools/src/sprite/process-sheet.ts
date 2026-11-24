import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../asset/paths.js";
import { Bitmap } from "../image/raster.js";
import type { RGB } from "../image/raster.js";
import { cleanChroma } from "./chroma.js";
import { globFrames } from "./frames.js";
import { normalizeCanvas } from "./normalize.js";
import { packSpritesheet } from "./pack.js";
import { DEFAULT_SNAP_CONFIG, snapImage } from "./pixel-snap.js";
import { actionFacts } from "./presets.js";
import { runQc } from "./qc.js";
import type { QcReport } from "./qc.js";
import { recoverFrames } from "./recover.js";
import { buildSequenceGif } from "./sequence-gif.js";

/** What `processSheet` turns a pose board into, and how. */
export interface ProcessSheetOptions {
  board: string;
  action: string;
  outDir: string;
  rows: number;
  cols: number;
  /** Frames to keep; defaults to the action's own count, capped at the grid. */
  frames?: number;
  charFill?: number;
  chroma?: RGB;
  snapKColors?: number;
  pixelSnap?: boolean;
  qc?: boolean;
  /** Cut frames at their components instead of the uniform grid. */
  recover?: boolean;
  /** Receives each non-fatal problem; defaults to stderr. */
  warn?: (message: string) => void;
}

/** Where `processSheet` wrote each output, and the QC verdict on the sheet. */
export interface ProcessSheetResult {
  action: string;
  fps: number;
  frames: number;
  slicing: "naive" | "recover";
  pixelSnap: boolean;
  spritesheet: string;
  manifest: string;
  gif: string;
  runtimeFrames: string;
  qc: QcReport | null;
}

const RUNTIME_CANVAS = { height: 256, width: 256 };

const frameName = (i: number) => `frame-${String(i).padStart(2, "0")}.png`;

const sliceGrid = (
  board: string,
  rows: number,
  cols: number,
  frames: number,
  outDir: string,
  warn: (message: string) => void,
) => {
  const image = Bitmap.fromFile(board);

  if (image.width % cols || image.height % rows) {
    warn(
      `board ${image.width}x${image.height} does not divide evenly into ${cols}x${rows} cells ` +
        `(${image.width % cols}px wide / ${image.height % rows}px tall remainder dropped). ` +
        "Regenerate at a divisible size or adjust --rows/--cols if frames look shifted.",
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

const recoverGrid = (
  board: string,
  rows: number,
  cols: number,
  frames: number,
  outDir: string,
  warn: (message: string) => void,
) => {
  try {
    const { crops } = recoverFrames(board, { cols, frames, rows, threshold: 15 });

    for (const crop of crops) {
      crop.image.toFile(path.join(outDir, `frame-${crop.label}.png`));
    }

    return crops.length;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warn(`--recover fell back to uniform slice: ${reason}`);

    return sliceGrid(board, rows, cols, frames, outDir, warn);
  }
};

const pixelSnapFrames = (framesDir: string, kColors: number) => {
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

/**
 * Turns a generated pose board into an engine-ready animation: slices (or
 * recovers) its frames, keys out the chroma background, optionally snaps
 * them to a pixel grid, centres them on a shared canvas, packs the sheet and
 * its JSON manifest, renders a review GIF and runs sheet QC. Every output
 * lands under `outDir`, whose `cells`, `_keyed` and `runtime` folders are
 * rebuilt from scratch.
 */
export const processSheet: (options: ProcessSheetOptions) => ProcessSheetResult = (options) => {
  const {
    action,
    board,
    charFill = 0.5,
    chroma = [0, 255, 0],
    cols,
    outDir,
    pixelSnap = true,
    qc: runSheetQc = true,
    recover = false,
    rows,
    snapKColors = 16,
    warn = (message) => process.stderr.write(`warning: ${message}\n`),
  } = options;

  const { defaultFrames, fps } = actionFacts(action);
  const frames = options.frames ?? Math.min(defaultFrames, rows * cols);

  const dCells = path.join(outDir, "cells");
  const dKeyed = path.join(outDir, "_keyed");
  const dRuntime = path.join(outDir, "runtime");
  const dReview = path.join(outDir, "review");

  for (const dir of [dCells, dKeyed, dRuntime]) {
    rmSync(dir, { force: true, recursive: true });
  }

  const n = recover
    ? recoverGrid(board, rows, cols, frames, dCells, warn)
    : sliceGrid(board, rows, cols, frames, dCells, warn);

  for (const framePath of globFrames(dCells, "frame-*.png")) {
    const result = cleanChroma(Bitmap.fromFile(framePath), { chroma });
    result.image.toFile(path.join(dKeyed, framePath.slice(dCells.length + 1)));
  }

  if (pixelSnap) {
    pixelSnapFrames(dKeyed, snapKColors);
  }

  normalizeCanvas(dKeyed, dRuntime, { canvas: RUNTIME_CANVAS, charFill, glob: "frame-*.png" });

  const spritesheet = path.join(outDir, "spritesheet.png");
  const manifest = path.join(outDir, "spritesheet.json");
  const packed = packSpritesheet(dRuntime, spritesheet, { action, fps, glob: "frame-*.png" });
  packed.sheet.toFile(spritesheet);
  writeJsonFile(manifest, packed.manifest);

  const gif = path.join(dReview, `${action}.gif`);
  const delayMs = Math.round(1000 / fps);

  const gifBytes = buildSequenceGif(
    Array.from({ length: n }, (_, i) => ({ delayMs, path: path.join(dRuntime, frameName(i + 1)) })),
    null,
  );

  mkdirSync(dReview, { recursive: true });
  writeFileSync(gif, gifBytes);

  return {
    action,
    fps,
    frames: n,
    gif,
    manifest,
    pixelSnap,
    qc: runSheetQc ? runQc(spritesheet, null, null) : null,
    runtimeFrames: dRuntime,
    slicing: recover ? "recover" : "naive",
    spritesheet,
  };
};
