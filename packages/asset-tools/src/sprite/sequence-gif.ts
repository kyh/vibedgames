import { encodeGif } from "../image/gif.js";
import { Bitmap } from "../image/raster.js";
import type { RGBA } from "../image/raster.js";

/**
 * Build a review GIF from a chosen frame order.
 *
 * The order is explicit rather than alphabetical because reviewing an
 * animation often means trying a different sequence than the one the frames
 * were generated in — swapping two frames of a walk cycle, or holding a
 * wind-up longer — without renaming files.
 */
export const buildSequenceGif = (
  frames: { path: string; delayMs: number }[],
  flatBackground: RGBA | null,
) => {
  if (frames.length === 0) {
    throw new Error("No frames selected");
  }

  const composed = frames.map(({ path, delayMs }) => {
    let bitmap = Bitmap.fromFile(path);

    if (flatBackground) {
      const backdrop = Bitmap.create(bitmap.width, bitmap.height, flatBackground);
      backdrop.alphaComposite(bitmap, 0, 0);
      bitmap = backdrop;
    }

    return { bitmap, delayMs };
  });

  return encodeGif(composed);
};
