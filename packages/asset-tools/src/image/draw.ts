import type { Bitmap, RGBA } from "./raster.js";

const put = (target: Bitmap, x: number, y: number, ink: RGBA) => {
  if (!target.contains(x, y)) {
    return;
  }

  const i = target.index(x, y);
  const [r, g, b, a] = ink;
  target.data[i] = r;
  target.data[i + 1] = g;
  target.data[i + 2] = b;
  target.data[i + 3] = a;
};

/** A straight line between two inclusive endpoints (Bresenham). */
export const drawLine = (
  target: Bitmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ink: RGBA,
) => {
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

    if (x === endX && y === endY) {
      return;
    }

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
};

/** A filled rectangle. Both corners are inclusive, as in Pillow. */
export const fillRect = (
  target: Bitmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ink: RGBA,
) => {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      put(target, x, y, ink);
    }
  }
};

/**
 * A rectangle outline `width` pixels thick, growing inward from the given box
 * — Pillow's `rectangle(..., width=n)`.
 */
export const strokeRect = (
  target: Bitmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ink: RGBA,
  width = 1,
) => {
  for (let i = 0; i < Math.max(1, width); i += 1) {
    const left = x0 + i;
    const top = y0 + i;
    const right = x1 - i;
    const bottom = y1 - i;

    if (left > right || top > bottom) {
      return;
    }

    drawLine(target, left, top, right, top, ink);
    drawLine(target, left, bottom, right, bottom, ink);
    drawLine(target, left, top, left, bottom, ink);
    drawLine(target, right, top, right, bottom, ink);
  }
};

const GLYPH_WIDTH = 6;
const GLYPH_HEIGHT = 12;

const GLYPH_DATA =
  "AAAAAAAAAAAAAAAAD7DEsA8AinIAc4gA1BoAG9MA6wIAAuoA6wIAAuoA1BoAG9MAinIAc4kAD7DEsA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCg8QAAAMNt8AAAABgA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGLD0EYAFcECKNcAKFUAC+oAAAAAX50AAAAj1BUAAAzMNwAAAa1ZAAAAYfTAwLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACqnAzUsAdnQAGeAAEQYARNsAAACj9UMAAAAAT6IAkwQAA+0AolQAPcYAHr/BuygAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASvcAAAANxvIAAACVVvAAADyvAPAAB8gaAPAAWtXAwPyiAAAAAPAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARd7AwIQAXWgAAAAAdk8AAAAAj5rEsiMAjmsAUr4AIAMAA+sAqE8AOr4AJcTAuCMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApLHwiIAaoUAUa4AxSQABnYA63LAryAA8VMAU70A2gMAA+sAmEEAQbwAFrO/uyMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqMDAxuwAAAAAZIIAAAABzxYAAABOmgAAAADBJwAAADexAAAAAK0+AAAAJMcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ8a/wzkA4CEAI9YAzTQANuEANfjT+EwAwVMAVZ4A7gIAA+wAxz0APMwAL8HBwDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIbnAtBcAu0MAQ5cA6wMAA9kAvVEAVPAAIa+/c+oAegYAJcQArlAAhWsAJMTHkwIAAAAAAAAAAAAAAAAA";

let glyphCache: Uint8Array | null = null;

const glyphs = () => {
  glyphCache ??= new Uint8Array(Buffer.from(GLYPH_DATA, "base64"));

  return glyphCache;
};

/**
 * Draw a run of digits at (x, y), blending each glyph through its coverage
 * mask. Non-digit characters advance the cursor without drawing, which only
 * matters if a caller ever labels something other than a numeric tile ID.
 */
export const drawDigits = (target: Bitmap, x: number, y: number, text: string, ink: RGBA) => {
  const data = glyphs();
  let cursor = x;

  for (const ch of text) {
    const digit = (ch.codePointAt(0) ?? 0) - 48;

    if (digit < 0 || digit > 9) {
      cursor += GLYPH_WIDTH;
      continue;
    }

    const base = digit * GLYPH_WIDTH * GLYPH_HEIGHT;

    for (let gy = 0; gy < GLYPH_HEIGHT; gy += 1) {
      for (let gx = 0; gx < GLYPH_WIDTH; gx += 1) {
        const coverage = data[base + gy * GLYPH_WIDTH + gx] ?? 0;

        if (coverage === 0) {
          continue;
        }

        const px = cursor + gx;
        const py = y + gy;

        if (!target.contains(px, py)) {
          continue;
        }

        const i = target.index(px, py);
        const m = coverage / 255;
        const transparent = target.data[i + 3] === 0;

        for (let c = 0; c < 3; c += 1) {
          const inkChannel = ink[c] ?? 0;
          target.data[i + c] = transparent
            ? inkChannel
            : Math.round((target.data[i + c] ?? 0) * (1 - m) + inkChannel * m);
        }

        target.data[i + 3] = Math.round((target.data[i + 3] ?? 0) * (1 - m) + ink[3] * m);
      }
    }

    cursor += GLYPH_WIDTH;
  }
};
