/** A stream of uniform draws in [0, 1). */
export type Rng = () => number;

export const seededRandom = (seed: number) => {
  // oxlint-disable-next-line no-bitwise, unicorn/prefer-math-trunc -- `| 0` wraps the seed to a 32-bit integer, which Math.trunc would not
  let state = seed | 0;

  return () => {
    // oxlint-disable-next-line no-bitwise, unicorn/prefer-math-trunc -- `| 0` wraps the sum to a 32-bit integer, which Math.trunc would not
    state = (state + 1_831_565_813) | 0;
    // oxlint-disable-next-line no-bitwise -- xorshift mixing step
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    // oxlint-disable-next-line no-bitwise -- xorshift mixing step
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);

    // oxlint-disable-next-line no-bitwise -- unsigned shift folds the result into [0, 2^32)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);

  return t * t * (3 - 2 * t);
};

export const damp = (from: number, to: number, lambda: number, dt: number) =>
  lerp(from, to, 1 - Math.exp(-lambda * dt));

/** Cosmetic draws only: anything the sim reads comes from the match's seeded stream via `randIn`. */
export const rand = (min = 0, max = 1) => min + Math.random() * (max - min);

export const randIn = (rng: Rng, min: number, max: number) => min + rng() * (max - min);

const angleDelta = (from: number, to: number) => {
  let delta = (to - from) % (Math.PI * 2);

  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  }

  if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }

  return delta;
};

export const dampAngle = (from: number, to: number, lambda: number, dt: number) =>
  from + angleDelta(from, to) * (1 - Math.exp(-lambda * dt));

export const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  return canvas;
};

const dist2 = (x0: number, z0: number, x1: number, z1: number) =>
  (x0 - x1) * (x0 - x1) + (z0 - z1) * (z0 - z1);

export const dist = (x0: number, z0: number, x1: number, z1: number) =>
  Math.sqrt(dist2(x0, z0, x1, z1));
