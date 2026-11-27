import * as THREE from "three";

export const STEPS = 5;

const TABLE = [
  ["orange", "#7a2a12", "#bf4416", "#f26a1b", "#ff9a3c", "#ffd08a"],
  ["board", "#39406b", "#4b558a", "#5f6ba6", "#7a86bf", "#a3aedb"],
  ["felt", "#1f4a44", "#2b6a5c", "#3a8a72", "#58aa88", "#8fd0aa"],
  ["cream", "#8a6a4a", "#c9a877", "#f0d9a8", "#fff0c8", "#fffbe8"],
  ["hazard", "#6b4a00", "#b88400", "#f2c200", "#ffe14a", "#fff6b0"],
  ["wood", "#3d2416", "#6b4226", "#96623a", "#b98454", "#d9ab7c"],
  ["carpet", "#1c2040", "#2a3360", "#3d4a80", "#5a6aa6", "#8c9acc"],
  ["tile", "#5f6078", "#9a98a8", "#cfc8c4", "#efe6d6", "#ffffff"],
  ["white", "#4a4e69", "#8d93ab", "#c9cede", "#f1f3f9", "#ffffff"],
  ["black", "#0d0b14", "#1c1a26", "#2e2b3d", "#4a4660", "#6f6a8a"],
  ["red", "#5a0f1e", "#a31825", "#e02a2f", "#ff6a55", "#ffb39a"],
  ["yellow", "#7a4a08", "#c88a10", "#f7c820", "#ffe76a", "#fff8c0"],
  ["blue", "#123a6e", "#1c62b8", "#3a9cf0", "#7cc8ff", "#c4ecff"],
  ["cyan", "#073f4a", "#0c7a80", "#18bfb4", "#6cecd8", "#c6fff0"],
  ["green", "#0c3b2a", "#14703a", "#2fb04a", "#7ddc5a", "#cdf58e"],
  ["lime", "#2f4a08", "#5f8a10", "#a4d81c", "#d4f75a", "#f2ffb0"],
  ["purple", "#2a0f52", "#5a1f9e", "#8f3fe0", "#c07aff", "#e6c4ff"],
  ["pink", "#5c0f48", "#a81a78", "#ee3fa8", "#ff84cc", "#ffc8ea"],
  ["navy", "#05060f", "#0e1230", "#1b2358", "#303c88", "#5562b8"],
  ["room", "#0b0a16", "#141228", "#1f1c3c", "#2c2852", "#3d3870"],
  ["peach", "#5a3a34", "#8a5a4c", "#c98a6a", "#e8b48c", "#f8dcb4"],
  ["mint", "#2c4a48", "#4a7a70", "#7ab09a", "#a8d4b8", "#d4f0d8"],
  ["lilac", "#3a3260", "#5c4f94", "#8a78c4", "#b4a4e4", "#dcd0f8"],
] as const;

export type RampName = (typeof TABLE)[number][0];

const indexOf = (name: RampName) => TABLE.findIndex((row) => row[0] === name);

/** Ramp ids by name. */
export const RAMP = {
  black: indexOf("black"),
  blue: indexOf("blue"),
  board: indexOf("board"),
  carpet: indexOf("carpet"),
  cream: indexOf("cream"),
  cyan: indexOf("cyan"),
  green: indexOf("green"),
  lilac: indexOf("lilac"),
  lime: indexOf("lime"),
  mint: indexOf("mint"),
  felt: indexOf("felt"),
  hazard: indexOf("hazard"),
  navy: indexOf("navy"),
  orange: indexOf("orange"),
  peach: indexOf("peach"),
  pink: indexOf("pink"),
  purple: indexOf("purple"),
  red: indexOf("red"),
  room: indexOf("room"),
  tile: indexOf("tile"),
  white: indexOf("white"),
  wood: indexOf("wood"),
  yellow: indexOf("yellow"),
} as const;

export const RAMP_COUNT = TABLE.length;

/** A template's stand-in for "this kart's colour", swapped for a real ramp when drawn. */
export const TEAM_RAMP = 31;

/** The ramps a car can wear: eight that stay apart on a dark board under warm light. */
export const CAR_RAMPS = [
  RAMP.cyan,
  RAMP.pink,
  RAMP.lime,
  RAMP.purple,
  RAMP.orange,
  RAMP.white,
  RAMP.yellow,
  RAMP.red,
] as const;

/** How lit a surface is, from the dark of the room to full lamp light. */
export const LEVELS = 4;

export const rampCss = (ramp: number, step: number) => {
  const row = TABLE[ramp] ?? TABLE[0];
  const at = Math.min(STEPS - 1, Math.max(0, Math.round(step)));

  return row[at + 1] ?? row[1];
};

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
      const have = hueOf(rampCss(ramp, 2));
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

const NIGHT = new THREE.Color("#070a24");
const WARM = new THREE.Color(0.2, 0.16, 0.05);
const LIT = new THREE.Color();

const DIM = [
  { cool: new THREE.Color(0.3, 0.33, 0.6), sink: 0.34 },
  { cool: new THREE.Color(0.6, 0.64, 0.9), sink: 0.14 },
] as const;

const shade = (hex: string, level: number) => {
  LIT.set(hex);
  const dim = DIM[level];

  if (dim) {
    return SCRATCH.copy(LIT).multiply(dim.cool).lerp(NIGHT, dim.sink);
  }

  if (level >= LEVELS - 1) {
    return SCRATCH.copy(LIT).add(WARM);
  }

  return SCRATCH.copy(LIT);
};

/** A tone as the page sees it: `level` 0 is the dark of the room, the top level full light. */
export const litCss = (ramp: number, step: number, level: number) =>
  `#${shade(rampCss(ramp, step), level).getHexString(THREE.SRGBColorSpace)}`;

/**
 * Every tone at every light level as a texture: x is `level * STEPS + step`, y
 * the ramp. Bytes go to the screen untouched.
 */
export const rampTexture = () => {
  const wide = STEPS * LEVELS;
  const data = new Uint8Array(wide * RAMP_COUNT * 4);

  for (const [ramp, row] of TABLE.entries()) {
    for (let level = 0; level < LEVELS; level += 1) {
      for (let step = 0; step < STEPS; step += 1) {
        const hex = shade(row[step + 1] ?? "#000000", level).getHex(THREE.SRGBColorSpace);
        const o = (ramp * wide + level * STEPS + step) * 4;
        data[o] = Math.floor(hex / 65_536) % 256;
        data[o + 1] = Math.floor(hex / 256) % 256;
        data[o + 2] = hex % 256;
        data[o + 3] = 255;
      }
    }
  }

  const texture = new THREE.DataTexture(data, wide, RAMP_COUNT, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;

  return texture;
};
