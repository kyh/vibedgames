import * as THREE from "three";

/** Tones on a ramp, dark to light. A flat face in plain light sits on `BASE`. */
export const STEPS = 8;
export const BASE = 4;

/** Past the tones, every ramp carries its outline colour and its checker-shadow colour. */
export const INK_COLUMN = STEPS;
export const SHADE_COLUMN = STEPS + 1;
const COLUMNS = STEPS + 2;

const SEEDS = [
  ["sand", "#d8bd92"],
  ["tile", "#d6d0c4"],
  ["stone", "#b3a48c"],
  ["wood", "#a9764c"],
  ["cream", "#ecdcb4"],
  ["hazard", "#e2a22c"],
  ["iron", "#565664"],
  ["steel", "#9097a8"],
  ["white", "#dcdde4"],
  ["black", "#3f3d4c"],
  ["glass", "#44597a"],
  ["red", "#cf4339"],
  ["orange", "#e57c2e"],
  ["yellow", "#e8be3c"],
  ["lime", "#93bd3f"],
  ["green", "#4fa858"],
  ["cyan", "#2faea6"],
  ["blue", "#4a88d8"],
  ["purple", "#8a58cc"],
  ["pink", "#dc5a9c"],
  ["chalk", "#c3c8d6"],
] as const;

export type RampName = (typeof SEEDS)[number][0];

const indexOf = (name: RampName) => SEEDS.findIndex((row) => row[0] === name);

/** Ramp ids by name. */
export const RAMP = {
  black: indexOf("black"),
  blue: indexOf("blue"),
  chalk: indexOf("chalk"),
  cream: indexOf("cream"),
  cyan: indexOf("cyan"),
  glass: indexOf("glass"),
  green: indexOf("green"),
  hazard: indexOf("hazard"),
  iron: indexOf("iron"),
  lime: indexOf("lime"),
  orange: indexOf("orange"),
  pink: indexOf("pink"),
  purple: indexOf("purple"),
  red: indexOf("red"),
  sand: indexOf("sand"),
  steel: indexOf("steel"),
  stone: indexOf("stone"),
  tile: indexOf("tile"),
  white: indexOf("white"),
  wood: indexOf("wood"),
  yellow: indexOf("yellow"),
} as const;

export const RAMP_COUNT = SEEDS.length;

/** A model's stand-in for "this car's colour", swapped for a real ramp when drawn. */
export const TEAM_RAMP = 31;

/** A tone id: a ramp and a step on it. */
export const tone = (ramp: number, step: number) => ramp * STEPS + step;

/** The ramps a car can wear: eight that stay apart on a pale board. */
export const CAR_RAMPS = [
  RAMP.cyan,
  RAMP.pink,
  RAMP.lime,
  RAMP.purple,
  RAMP.orange,
  RAMP.chalk,
  RAMP.yellow,
  RAMP.red,
] as const;

interface Lch {
  l: number;
  c: number;
  h: number;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

const lchOf = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = toLinear(Math.floor(n / 65_536) / 255);
  const g = toLinear((Math.floor(n / 256) % 256) / 255);
  const b = toLinear((n % 256) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const k = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return {
    c: Math.hypot(a, k),
    h: Math.atan2(k, a),
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
  } satisfies Lch;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const channel = (v: number) => Math.round(clamp01(toGamma(clamp01(v))) * 255);

const rgbOf = ({ c, h, l }: Lch) => {
  const a = Math.cos(h) * c;
  const k = Math.sin(h) * c;
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * k) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * k) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * k) ** 3;

  return [
    channel(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    channel(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    channel(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  ] as const;
};

const COOL = (285 * Math.PI) / 180;
const WARM = (85 * Math.PI) / 180;

const towards = (from: number, to: number, share: number) => {
  const turn = Math.atan2(Math.sin(to - from), Math.cos(to - from));

  return from + turn * share;
};

const grow = (seed: Lch, step: number) => {
  const off = step - BASE;
  const down = Math.max(0, -off);
  const up = Math.max(0, off);
  const room = off < 0 ? seed.l - 0.2 : 0.975 - seed.l;
  const reach = off < 0 ? Math.min(0.085, room / BASE) : Math.min(0.07, room / (STEPS - 1 - BASE));

  return {
    c: seed.c * (1 + down * 0.05 - up * 0.2) * (step === 0 ? 0.85 : 1),
    h: towards(seed.h, off < 0 ? COOL : WARM, off < 0 ? down * 0.07 : up * 0.1),
    l: seed.l + off * reach,
  } satisfies Lch;
};

const INK: Lch = { c: 0.03, h: COOL, l: 0.24 };

const inkOf = (seed: Lch) =>
  ({
    c: Math.min(0.06, seed.c * 0.5),
    h: towards(seed.h, COOL, 0.6),
    l: Math.min(0.3, INK.l + seed.l * 0.05),
  }) satisfies Lch;

const shadeOf = (seed: Lch) =>
  ({
    c: Math.min(0.05, seed.c * 0.6),
    h: towards(seed.h, COOL, 0.7),
    l: Math.max(0.3, seed.l * 0.5),
  }) satisfies Lch;

const TABLE = SEEDS.map(([, hex]) => {
  const seed = lchOf(hex);
  const row: (readonly [number, number, number])[] = [];

  for (let step = 0; step < STEPS; step += 1) {
    row.push(rgbOf(grow(seed, step)));
  }

  row.push(rgbOf(inkOf(seed)), rgbOf(shadeOf(seed)));

  return row;
});

const hex2 = (v: number) => v.toString(16).padStart(2, "0");

/** A tone as the page sees it. */
export const rampCss = (ramp: number, step: number) => {
  const row = TABLE[ramp] ?? TABLE[0];
  const [r, g, b] = row?.[Math.min(STEPS - 1, Math.max(0, Math.round(step)))] ?? [0, 0, 0];

  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
};

/** The outline colour everything shares when it has no ramp of its own. */
export const INK_CSS = (() => {
  const [r, g, b] = rgbOf(INK);

  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
})();

const SCRATCH = new THREE.Color();
const HSL = { h: 0, l: 0, s: 0 };

const hueOf = (css: string) => {
  SCRATCH.set(css).getHSL(HSL);

  return { h: HSL.h, l: HSL.l, s: HSL.s };
};

/** The car ramp closest in hue to any colour, skipping ramps already `taken`. */
export const carRampFor = (css: string, taken: ReadonlySet<number>) => {
  const want = hueOf(css);
  let best: number = CAR_RAMPS[0];
  let bestGap = Number.POSITIVE_INFINITY;

  for (const ramp of CAR_RAMPS) {
    if (!taken.has(ramp)) {
      const have = hueOf(rampCss(ramp, BASE));
      const turn = Math.abs(want.h - have.h);
      const grey = want.s < 0.25 && have.s < 0.25;

      const gap = grey
        ? Math.abs(want.l - have.l)
        : Math.min(turn, 1 - turn) + Math.abs(want.s - have.s) * 0.4;

      if (gap < bestGap) {
        bestGap = gap;
        best = ramp;
      }
    }
  }

  return best;
};

/**
 * Every ramp as a texture: x is the step, then the ramp's ink and its shadow
 * colour; y is the ramp. Bytes go to the screen untouched.
 */
export const rampTexture = () => {
  const data = new Uint8Array(COLUMNS * RAMP_COUNT * 4);

  for (const [ramp, row] of TABLE.entries()) {
    for (const [column, [r, g, b]] of row.entries()) {
      const o = (ramp * COLUMNS + column) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, COLUMNS, RAMP_COUNT, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;

  return texture;
};
