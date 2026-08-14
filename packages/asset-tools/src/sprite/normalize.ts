import { basename, join } from "node:path";

import { Bitmap } from "../image/raster.js";
import { roundHalfToEven } from "../pymath.js";
import { loadFrames, median } from "./frames.js";

/**
 * Put every frame of one action on a shared runtime canvas.
 *
 * The critical property is that all frames get the *same* crop and the *same*
 * scale. Normalising each frame against its own bounding box would centre the
 * character in every cell and cancel the motion — the sprite would appear to
 * skate in place instead of moving.
 *
 * So the crop is the union bbox across the whole clip (preserving relative
 * travel), and the scale comes from the *median* per-frame visible height,
 * which is robust to a jump or lunge inflating the union. The character is
 * aimed at a fraction of the cell rather than filling it, leaving headroom so
 * an attack arc never clips.
 */
export function normalizeCanvas(
  inputDir: string,
  outDir: string,
  options: {
    glob?: string;
    canvas?: { width: number; height: number };
    pad?: number;
    allowUpscale?: boolean;
    targetHeight?: number | null;
    charFill?: number;
  } = {},
): string[] {
  const {
    glob = "frame-*.png",
    canvas = { width: 256, height: 256 },
    pad = 6,
    allowUpscale = true,
    targetHeight = null,
    charFill = 0.5,
  } = options;

  const frames = loadFrames(inputDir, glob);
  const boxes = frames.map((f) => f.image.getBBox()).filter((b) => b !== null);
  if (boxes.length === 0) throw new Error(`all frames in ${inputDir} are empty`);

  const unionLeft = Math.min(...boxes.map((b) => b.left));
  const unionTop = Math.min(...boxes.map((b) => b.top));
  const unionRight = Math.max(...boxes.map((b) => b.right));
  const unionBottom = Math.max(...boxes.map((b) => b.bottom));
  const unionWidth = unionRight - unionLeft;
  const unionHeight = unionBottom - unionTop;

  const availableWidth = canvas.width - 2 * pad;
  const availableHeight = canvas.height - 2 * pad;

  // Median visible height stands in for "how big is the character", ignoring
  // the vertical travel baked into the union.
  const charHeight = median(boxes.map((b) => b.bottom - b.top)) || 1;
  const charTarget = targetHeight ?? canvas.height * charFill;
  const scaleChar = charTarget / charHeight;
  // Never let the union overflow the cell, so nothing is ever cut off.
  const scaleFit = Math.min(availableWidth / unionWidth, availableHeight / unionHeight);
  let scale = Math.min(scaleChar, scaleFit);
  if (!allowUpscale) scale = Math.min(scale, 1);

  const newWidth = Math.max(1, roundHalfToEven(unionWidth * scale));
  const newHeight = Math.max(1, roundHalfToEven(unionHeight * scale));
  const pasteX = Math.floor((canvas.width - newWidth) / 2); // centred horizontally
  const pasteY = canvas.height - pad - newHeight; // union bottom on the ground line

  const written: string[] = [];
  for (const frame of frames) {
    const cropped = frame.image
      .crop({ left: unionLeft, top: unionTop, right: unionRight, bottom: unionBottom })
      .resize(newWidth, newHeight, "lanczos");
    const out = Bitmap.create(canvas.width, canvas.height);
    out.pasteMasked(cropped, pasteX, pasteY, cropped.channel(3));
    const dst = join(outDir, basename(frame.path));
    out.toFile(dst);
    written.push(dst);
  }
  return written;
}
