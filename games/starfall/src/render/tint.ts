import {
  BOOSTER_KINDS,
  BOOSTER_SPECS,
  SHIELD_MOD_KINDS,
  SHIELD_MOD_SPECS,
  WEAPONS_SPECIAL,
} from "../shared/constants";
import type { ItemState } from "../shared/constants";

/** Colour plumbing: CSS colour strings ↔ 0xRRGGBB ints, plus the tint lookups for weapons and pickups. */

export const itemTint = (it: ItemState): number => {
  if (it.kind === "weapon") {
    return WEAPONS_SPECIAL[it.weaponIdx]?.tint ?? 0xff_ff_ff;
  }
  if (it.kind === "booster") {
    return BOOSTER_SPECS[BOOSTER_KINDS[it.boosterIdx] ?? "repair"].tint;
  }
  return SHIELD_MOD_SPECS[SHIELD_MOD_KINDS[it.shieldIdx] ?? "overshield"].tint;
};

/** Remote windup glow tint from the shooter's weaponName (white fallback). */
export const weaponTint = (name: string): number =>
  WEAPONS_SPECIAL.find((w) => w.name === name)?.tint ?? 0xff_ff_ff;

/** Random lerp between two 0xRRGGBB tints (PLASMA's per-shot gradient). */
/* oxlint-disable no-bitwise -- unpacks and repacks 8-bit channels */
export const lerpTint = (a: number, b: number): number => {
  const t = Math.random();
  const ch = (shift: number): number => {
    const ca = (a >> shift) & 0xff;
    const cb = (b >> shift) & 0xff;
    return Math.round(ca + (cb - ca) * t) << shift;
  };
  return ch(16) | ch(8) | ch(0);
};
/* oxlint-enable no-bitwise */

export const hexCss = (tint: number): string => `#${tint.toString(16).padStart(6, "0")}`;

/* oxlint-disable no-bitwise -- packs 8-bit channels into 0xRRGGBB */
export const hslToInt = (h: number, s: number, l: number): number => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
};

/** Server player colors are `hsl(h, s%, l%)` strings; Graphics wants ints. */
export const cssToInt = (css: string | undefined): number => {
  if (!css) {
    return 0xff_ff_ff;
  }
  const hsl = /hsl\(\s*(?<h>[\d.]+)\s*,\s*(?<s>[\d.]+)%\s*,\s*(?<l>[\d.]+)%\s*\)/u.exec(
    css,
  )?.groups;
  if (hsl) {
    return hslToInt(
      Number(hsl["h"] ?? 0),
      Number(hsl["s"] ?? 0) / 100,
      Number(hsl["l"] ?? 100) / 100,
    );
  }
  const rgb = /rgb\(\s*(?<r>\d+)\s*,\s*(?<g>\d+)\s*,\s*(?<b>\d+)\s*\)/u.exec(css)?.groups;
  if (rgb) {
    return (
      (Number(rgb["r"] ?? 255) << 16) | (Number(rgb["g"] ?? 255) << 8) | Number(rgb["b"] ?? 255)
    );
  }
  const hex = /^#(?<hex>[0-9a-f]{6})$/iu.exec(css)?.groups;
  if (hex) {
    return Number.parseInt(hex["hex"] ?? "ffffff", 16);
  }
  return 0xff_ff_ff;
};
/* oxlint-enable no-bitwise */
