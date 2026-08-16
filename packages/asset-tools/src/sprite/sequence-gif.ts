import { encodeGif } from "../image/gif.js";
import { Bitmap, type RGBA } from "../image/raster.js";

/**
 * Build a review GIF from a chosen frame order.
 *
 * The order is explicit rather than alphabetical because reviewing an
 * animation often means trying a different sequence than the one the frames
 * were generated in — swapping two frames of a walk cycle, or holding a
 * wind-up longer — without renaming files.
 */
export function buildSequenceGif(
  frames: { path: string; delayMs: number }[],
  flatBackground: RGBA | null,
): Buffer {
  if (frames.length === 0) throw new Error("No frames selected");

  const composed = frames.map(({ path, delayMs }) => {
    let bitmap = Bitmap.fromFile(path);
    if (flatBackground) {
      // Composite over the flat colour first. GIF has only 1-bit
      // transparency, and the encoder drops alpha outright, so a sprite with
      // soft edges needs a backdrop applied here or those edges keep whatever
      // RGB happened to sit under them.
      const backdrop = Bitmap.create(bitmap.width, bitmap.height, flatBackground);
      backdrop.alphaComposite(bitmap, 0, 0);
      bitmap = backdrop;
    }
    return { bitmap, delayMs };
  });

  return encodeGif(composed);
}
