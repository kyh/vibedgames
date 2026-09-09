import type { RGB, RGBA } from "./raster.js";

/**
 * Colour string parsing equivalent to Pillow's `ImageColor.getrgb`, which the
 * sprite scripts used for `--flat-bg` and `--chroma` arguments. Supports the
 * spellings those skills actually pass: `#rgb`, `#rrggbb`, `#rrggbbaa`,
 * `rgb()`/`rgba()`, and the handful of CSS names that show up in prompts.
 */

const NAMED = {
  aqua: [0, 255, 255],
  black: [0, 0, 0],
  blue: [0, 0, 255],
  brown: [165, 42, 42],
  cyan: [0, 255, 255],
  fuchsia: [255, 0, 255],
  gray: [128, 128, 128],
  green: [0, 128, 0],
  grey: [128, 128, 128],
  lime: [0, 255, 0],
  magenta: [255, 0, 255],
  maroon: [128, 0, 0],
  navy: [0, 0, 128],
  olive: [128, 128, 0],
  orange: [255, 165, 0],
  pink: [255, 192, 203],
  purple: [128, 0, 128],
  red: [255, 0, 0],
  silver: [192, 192, 192],
  teal: [0, 128, 128],
  transparent: [0, 0, 0],
  white: [255, 255, 255],
  yellow: [255, 255, 0],
} satisfies Record<string, RGB>;

const isNamedColor = (value: string): value is keyof typeof NAMED => Object.hasOwn(NAMED, value);

const expandHexDigit = (c: string) => Number.parseInt(c + c, 16);

export const parseColor = (input: string): RGBA => {
  const value = input.trim().toLowerCase();

  if (value === "transparent") {
    return [0, 0, 0, 0];
  }
  if (isNamedColor(value)) {
    const named = NAMED[value];
    return [named[0], named[1], named[2], 255];
  }

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    // Validate the whole string up front. Per-digit `parseInt` is not enough:
    // it parses leading digits and stops, so "1z" reads as 1 rather than
    // failing, and a malformed colour would be written into pixels instead of
    // being reported.
    if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.test(hex)) {
      throw new Error(`Unrecognised colour: ${input}`);
    }
    if (hex.length === 3 || hex.length === 4) {
      const a = hex.length === 4 ? expandHexDigit(hex.charAt(3)) : 255;
      return [
        expandHexDigit(hex.charAt(0)),
        expandHexDigit(hex.charAt(1)),
        expandHexDigit(hex.charAt(2)),
        a,
      ];
    }
    const byte = (i: number) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return [byte(0), byte(1), byte(2), hex.length === 8 ? byte(3) : 255];
  }

  const body = /^rgba?\((?<body>[^)]+)\)$/u.exec(value)?.groups?.body;
  if (body !== undefined) {
    const [r, g, b, rawAlpha] = body.split(/[,/\s]+/u).filter(Boolean);
    if (r === undefined || g === undefined || b === undefined) {
      throw new Error(`Unrecognised colour: ${input}`);
    }
    const channel = (raw: string) => {
      // oxlint-disable-next-line unicorn/prefer-number-coercion -- CSS channels carry a `%` suffix, which Number() rejects
      const n = raw.endsWith("%") ? (Number.parseFloat(raw) * 255) / 100 : Number.parseFloat(raw);
      if (Number.isNaN(n)) {
        throw new TypeError(`Unrecognised colour: ${input}`);
      }
      return Math.max(0, Math.min(255, Math.round(n)));
    };
    // The alpha term is 0–1 in CSS but 0–255 in the byte channels.
    const alpha =
      rawAlpha === undefined
        ? 255
        : // oxlint-disable-next-line unicorn/prefer-number-coercion -- CSS alpha may carry a `%` suffix, which Number() rejects
          Math.max(0, Math.min(255, Math.round(Number.parseFloat(rawAlpha) * 255)));
    return [channel(r), channel(g), channel(b), alpha];
  }

  throw new Error(`Unrecognised colour: ${input}`);
};

/** Format as `#rrggbb`, dropping alpha — for JSON reports and prompt text. */
export const toHex = ([r, g, b]: RGB | RGBA): string =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
