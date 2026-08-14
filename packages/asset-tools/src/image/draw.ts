import type { Bitmap, RGBA } from "./raster.js";

/**
 * The `ImageDraw` subset the asset tooling uses: lines, rectangles and digit
 * labels for debug overlays.
 *
 * One Pillow behaviour is load-bearing here and surprises people: `ImageDraw`
 * does **not** alpha-blend. Drawing with `fill=(255, 255, 255, 80)` writes
 * those four bytes into the pixel, translucent alpha and all, rather than
 * compositing a 31%-opaque white over what was there. Grid overlays depend on
 * exactly that, so these primitives write ink directly too.
 *
 * Text is the one exception: glyphs blend through their coverage mask, the
 * way `draw_bitmap` does.
 */

/** Write ink into a single pixel, ignoring anything off-canvas. */
function put(target: Bitmap, x: number, y: number, ink: RGBA): void {
  if (!target.contains(x, y)) return;
  const i = target.index(x, y);
  target.data[i] = ink[0];
  target.data[i + 1] = ink[1];
  target.data[i + 2] = ink[2];
  target.data[i + 3] = ink[3];
}

/** A straight line between two inclusive endpoints (Bresenham). */
export function drawLine(
  target: Bitmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ink: RGBA,
): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const endX = Math.round(x1);
  const endY = Math.round(y1);
  const dx = Math.abs(endX - x);
  const dy = -Math.abs(endY - y);
  const stepX = x < endX ? 1 : -1;
  const stepY = y < endY ? 1 : -1;
  let error = dx + dy;

  for (;;) {
    put(target, x, y, ink);
    if (x === endX && y === endY) return;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += stepX;
    }
    if (doubled <= dx) {
      error += dx;
      y += stepY;
    }
  }
}

/** A filled rectangle. Both corners are inclusive, as in Pillow. */
export function fillRect(
  target: Bitmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ink: RGBA,
): void {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) put(target, x, y, ink);
  }
}

/**
 * A rectangle outline `width` pixels thick, growing inward from the given box
 * — Pillow's `rectangle(..., width=n)`.
 */
export function strokeRect(
  target: Bitmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ink: RGBA,
  width = 1,
): void {
  for (let i = 0; i < Math.max(1, width); i += 1) {
    const left = x0 + i;
    const top = y0 + i;
    const right = x1 - i;
    const bottom = y1 - i;
    if (left > right || top > bottom) return;
    drawLine(target, left, top, right, top, ink);
    drawLine(target, left, bottom, right, bottom, ink);
    drawLine(target, left, top, left, bottom, ink);
    drawLine(target, right, top, right, bottom, ink);
  }
}

/**
 * Antialiased coverage maps for the digits 0-9, lifted from the font
 * `ImageFont.load_default()` resolves to, at its default size.
 *
 * Only digits are stored because the only text these exports draw is a tile
 * ID. Embedding the coverage rather than a vector font keeps the labels
 * pixel-identical to what the Python exporter produced, with no font
 * rasteriser and no font file to ship.
 */
const GLYPH_WIDTH = 6;
const GLYPH_HEIGHT = 12;
const GLYPH_DATA =
  "AAAAAAAAAAAAAAAAD7DEsA8AinIAc4gA1BoAG9MA6wIAAuoA6wIAAuoA1BoAG9MAinIAc4kAD7DEsA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCg8QAAAMNt8AAAABgA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGLD0EYAFcECKNcAKFUAC+oAAAAAX50AAAAj1BUAAAzMNwAAAa1ZAAAAYfTAwLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACqnAzUsAdnQAGeAAEQYARNsAAACj9UMAAAAAT6IAkwQAA+0AolQAPcYAHr/BuygAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASvcAAAANxvIAAACVVvAAADyvAPAAB8gaAPAAWtXAwPyiAAAAAPAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARd7AwIQAXWgAAAAAdk8AAAAAj5rEsiMAjmsAUr4AIAMAA+sAqE8AOr4AJcTAuCMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApLHwiIAaoUAUa4AxSQABnYA63LAryAA8VMAU70A2gMAA+sAmEEAQbwAFrO/uyMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqMDAxuwAAAAAZIIAAAABzxYAAABOmgAAAADBJwAAADexAAAAAK0+AAAAJMcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ8a/wzkA4CEAI9YAzTQANuEANfjT+EwAwVMAVZ4A7gIAA+wAxz0APMwAL8HBwDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIbnAtBcAu0MAQ5cA6wMAA9kAvVEAVPAAIa+/c+oAegYAJcQArlAAhWsAJMTHkwIAAAAAAAAAAAAAAAAA";

let glyphCache: Uint8Array | null = null;

function glyphs(): Uint8Array {
  glyphCache ??= new Uint8Array(Buffer.from(GLYPH_DATA, "base64"));
  return glyphCache;
}

/**
 * Draw a run of digits at (x, y), blending each glyph through its coverage
 * mask. Non-digit characters advance the cursor without drawing, which only
 * matters if a caller ever labels something other than a numeric tile ID.
 */
export function drawDigits(target: Bitmap, x: number, y: number, text: string, ink: RGBA): void {
  const data = glyphs();
  let cursor = x;

  for (const ch of text) {
    const digit = ch.charCodeAt(0) - 48;
    if (digit < 0 || digit > 9) {
      cursor += GLYPH_WIDTH;
      continue;
    }
    const base = digit * GLYPH_WIDTH * GLYPH_HEIGHT;
    for (let gy = 0; gy < GLYPH_HEIGHT; gy += 1) {
      for (let gx = 0; gx < GLYPH_WIDTH; gx += 1) {
        const coverage = data[base + gy * GLYPH_WIDTH + gx]!;
        if (coverage === 0) continue;
        const px = cursor + gx;
        const py = y + gy;
        if (!target.contains(px, py)) continue;

        // Pillow blends a glyph through its coverage mask as a per-band lerp,
        // with one exception that matters here: where the destination is
        // *fully* transparent its RGB carries no information, so the ink
        // colour is taken outright instead of being averaged toward it. Blend
        // there and white labels over empty tiles come out grey and muddy.
        const i = target.index(px, py);
        const m = coverage / 255;
        const transparent = target.data[i + 3] === 0;
        for (let c = 0; c < 3; c += 1) {
          target.data[i + c] = transparent
            ? ink[c]!
            : Math.round(target.data[i + c]! * (1 - m) + ink[c]! * m);
        }
        target.data[i + 3] = Math.round(target.data[i + 3]! * (1 - m) + ink[3]! * m);
      }
    }
    cursor += GLYPH_WIDTH;
  }
}
