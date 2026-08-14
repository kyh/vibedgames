import type { RGB, RGBA } from "./raster.js";

/**
 * Colour string parsing equivalent to Pillow's `ImageColor.getrgb`, which the
 * sprite scripts used for `--flat-bg` and `--chroma` arguments. Supports the
 * spellings those skills actually pass: `#rgb`, `#rrggbb`, `#rrggbbaa`,
 * `rgb()`/`rgba()`, and the handful of CSS names that show up in prompts.
 */

const NAMED: Record<string, RGB> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  lime: [0, 255, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  aqua: [0, 255, 255],
  magenta: [255, 0, 255],
  fuchsia: [255, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  maroon: [128, 0, 0],
  olive: [128, 128, 0],
  navy: [0, 0, 128],
  purple: [128, 0, 128],
  teal: [0, 128, 128],
  orange: [255, 165, 0],
  pink: [255, 192, 203],
  brown: [165, 42, 42],
  transparent: [0, 0, 0],
};

export function parseColor(input: string): RGBA {
  const value = input.trim().toLowerCase();

  if (value === "transparent") return [0, 0, 0, 0];
  const named = NAMED[value];
  if (named) return [named[0], named[1], named[2], 255];

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const expand = (c: string) => parseInt(c + c, 16);
    if (hex.length === 3 || hex.length === 4) {
      const a = hex.length === 4 ? expand(hex[3]!) : 255;
      return [expand(hex[0]!), expand(hex[1]!), expand(hex[2]!), a];
    }
    if (hex.length === 6 || hex.length === 8) {
      const byte = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      const a = hex.length === 8 ? byte(3) : 255;
      const rgba: RGBA = [byte(0), byte(1), byte(2), a];
      if (rgba.some((c) => Number.isNaN(c))) throw new Error(`Unrecognised colour: ${input}`);
      return rgba;
    }
    throw new Error(`Unrecognised colour: ${input}`);
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (fn) {
    const parts = fn[1]!.split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) throw new Error(`Unrecognised colour: ${input}`);
    const channel = (raw: string) => {
      const n = raw.endsWith("%") ? (Number.parseFloat(raw) * 255) / 100 : Number.parseFloat(raw);
      if (Number.isNaN(n)) throw new Error(`Unrecognised colour: ${input}`);
      return Math.max(0, Math.min(255, Math.round(n)));
    };
    // The alpha term is 0–1 in CSS but 0–255 in the byte channels.
    const alpha =
      parts.length > 3
        ? Math.max(0, Math.min(255, Math.round(Number.parseFloat(parts[3]!) * 255)))
        : 255;
    return [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!), alpha];
  }

  throw new Error(`Unrecognised colour: ${input}`);
}

/** Format as `#rrggbb`, dropping alpha — for JSON reports and prompt text. */
export function toHex([r, g, b]: RGB | RGBA): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
