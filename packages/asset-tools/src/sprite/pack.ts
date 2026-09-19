import path from "node:path";

import { Bitmap } from "../image/raster.js";
import { loadFrames } from "./frames.js";

/**
 * Pack loose runtime frames into one engine-loadable spritesheet plus a
 * manifest.
 *
 * The default layout is a single horizontal strip, which is what Phaser's
 * `load.spritesheet` + `generateFrameNumbers` expects; `columns` switches to a
 * grid when a strip would be impractically wide. Cells are exact, with no
 * padding, so the sheet dimensions divide cleanly by the frame size — engines
 * derive frame offsets by multiplication and any gap silently shears the
 * animation.
 */

export interface SpritesheetManifest {
  image: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  frameCount: number;
  fps: number;
  animations: Record<string, { fps: number; frames: number[] }>;
}

export type PackResult = SpritesheetManifest & {
  _manifestPath: string;
  _sheetPath: string;
};

export interface PackedSheet {
  manifest: SpritesheetManifest;
  sheet: Bitmap;
}

export const packSpritesheet = (
  inputDir: string,
  out: string,
  options: {
    glob?: string;
    columns?: number | null;
    fps?: number;
    action?: string;
  } = {},
): PackedSheet => {
  const { glob = "frame-*.png", columns = null, fps = 10, action = "anim" } = options;
  const frames = loadFrames(inputDir, glob);

  // Every frame must share one size, or the grid maths silently misaligns and
  // the animation shears at runtime rather than failing here.
  const sizes = new Set(frames.map((f) => `${f.image.width}x${f.image.height}`));
  if (sizes.size !== 1) {
    throw new Error(
      `frames are not a uniform size (${[...sizes].toSorted().join(", ")}); normalize them first (run \`vg sprite normalize-canvas\`).`,
    );
  }

  const [firstFrame] = frames;
  if (firstFrame === undefined) {
    throw new Error(`no frames matching ${glob} in ${inputDir}`);
  }
  const frameWidth = firstFrame.image.width;
  const frameHeight = firstFrame.image.height;
  const count = frames.length;
  const cols = columns === null || columns === 0 ? count : Math.min(columns, count);
  const rows = Math.ceil(count / cols);

  const sheet = Bitmap.create(cols * frameWidth, rows * frameHeight);
  for (const [i, frame] of frames.entries()) {
    const row = Math.floor(i / cols);
    const col = i - row * cols;
    // Exact cell, no gap, alpha copied rather than blended.
    sheet.paste(frame.image, col * frameWidth, row * frameHeight);
  }

  return {
    manifest: {
      animations: { [action]: { fps, frames: Array.from({ length: count }, (_, i) => i) } },
      columns: cols,
      fps,
      frameCount: count,
      frameHeight,
      frameWidth,
      image: path.basename(out),
      rows,
    },
    sheet,
  };
};
