// The whole game in one palette. A material never names a colour: it names a
// ramp (five tones of one hue, dark to light) and a step on it. Shade is a step
// down, a highlight a step up, an outline a step down again, so every pixel on
// screen is one of these tones.

import * as THREE from "three";

export const STEPS = 5;

const TABLE = [
  ["track", "#7a2a12", "#bf4416", "#f26a1b", "#ff9a3c", "#ffd08a"],
  ["wood", "#3d2416", "#6b4226", "#96623a", "#b98454", "#d9ab7c"],
  ["carpet", "#1a2150", "#27367c", "#3852a6", "#5574c8", "#86a6e6"],
  ["tile", "#5f6078", "#9a98a8", "#cfc8c4", "#efe6d6", "#ffffff"],
  ["white", "#4a4e69", "#8d93ab", "#c9cede", "#f1f3f9", "#ffffff"],
  ["black", "#0d0b14", "#1c1a26", "#2e2b3d", "#4a4660", "#6f6a8a"],
  ["red", "#5a0f1e", "#a31825", "#e02a2f", "#ff6a55", "#ffb39a"],
  ["yellow", "#7a4a08", "#c88a10", "#f7c820", "#ffe76a", "#fff8c0"],
  ["blue", "#0f1f5c", "#1840a8", "#2a74e8", "#5fb0ff", "#b4e0ff"],
  ["cyan", "#073f4a", "#0c7a80", "#18bfb4", "#6cecd8", "#c6fff0"],
  ["green", "#0c3b2a", "#14703a", "#2fb04a", "#7ddc5a", "#cdf58e"],
  ["lime", "#2f4a08", "#5f8a10", "#a4d81c", "#d4f75a", "#f2ffb0"],
  ["purple", "#2a0f52", "#5a1f9e", "#8f3fe0", "#c07aff", "#e6c4ff"],
  ["pink", "#5c0f48", "#a81a78", "#ee3fa8", "#ff84cc", "#ffc8ea"],
  ["navy", "#05060f", "#0e1230", "#1b2358", "#303c88", "#5562b8"],
  ["room", "#0b0a16", "#141228", "#1f1c3c", "#2c2852", "#3d3870"],
] as const;

export type RampName = (typeof TABLE)[number][0];

const indexOf = (name: RampName): number => TABLE.findIndex((row) => row[0] === name);

/** Ramp ids by name. */
export const RAMP = {
  black: indexOf("black"),
  blue: indexOf("blue"),
  carpet: indexOf("carpet"),
  cyan: indexOf("cyan"),
  green: indexOf("green"),
  lime: indexOf("lime"),
  navy: indexOf("navy"),
  pink: indexOf("pink"),
  purple: indexOf("purple"),
  red: indexOf("red"),
  room: indexOf("room"),
  tile: indexOf("tile"),
  track: indexOf("track"),
  white: indexOf("white"),
  wood: indexOf("wood"),
  yellow: indexOf("yellow"),
} as const;

export const RAMP_COUNT = TABLE.length;

/** A template's stand-in for "this kart's colour", swapped for a real ramp when drawn. */
export const TEAM_RAMP = 31;

/** The ramps a kart can wear: none close to the orange of the track it paints on. */
export const KART_RAMPS = [
  RAMP.cyan,
  RAMP.pink,
  RAMP.lime,
  RAMP.purple,
  RAMP.blue,
  RAMP.white,
  RAMP.green,
  RAMP.navy,
] as const;

export const rampCss = (ramp: number, step: number): string => {
  const row = TABLE[ramp] ?? TABLE[0];
  const at = Math.min(STEPS - 1, Math.max(0, Math.round(step)));
  return row[at + 1] ?? row[1];
};

const SCRATCH = new THREE.Color();
const HSL = { h: 0, l: 0, s: 0 };

const hueOf = (css: string) => {
  SCRATCH.set(css).getHSL(HSL);
  return { h: HSL.h, s: HSL.s };
};

/** The kart ramp closest in hue to any colour, skipping ramps already `taken`. */
export const kartRampFor = (css: string, taken: ReadonlySet<number>): number => {
  const want = hueOf(css);
  let best: number = KART_RAMPS[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const ramp of KART_RAMPS) {
    if (!taken.has(ramp)) {
      const have = hueOf(rampCss(ramp, 2));
      const turn = Math.abs(want.h - have.h);
      // A grey asks for a grey: hue means nothing without saturation.
      const gap = Math.min(turn, 1 - turn) + Math.abs(want.s - have.s) * 0.4;
      if (gap < bestGap) {
        bestGap = gap;
        best = ramp;
      }
    }
  }
  return best;
};

/** Every tone as a texture: x is the step, y the ramp. Bytes go to the screen untouched. */
export const rampTexture = (): THREE.DataTexture => {
  const data = new Uint8Array(STEPS * RAMP_COUNT * 4);
  for (const [ramp, row] of TABLE.entries()) {
    for (let step = 0; step < STEPS; step += 1) {
      SCRATCH.set(row[step + 1] ?? "#000000");
      const hex = SCRATCH.getHex(THREE.SRGBColorSpace);
      const o = (ramp * STEPS + step) * 4;
      data[o] = Math.floor(hex / 65_536) % 256;
      data[o + 1] = Math.floor(hex / 256) % 256;
      data[o + 2] = hex % 256;
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, STEPS, RAMP_COUNT, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
};
