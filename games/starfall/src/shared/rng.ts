/* oxlint-disable no-bitwise -- mulberry32 is int32 hash arithmetic */
export const mulberry32 = (seed: number) => {
  let a = seed >>> 0;

  return () => {
    // oxlint-disable-next-line unicorn/prefer-math-trunc -- int32 wrap, not truncation
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};
/* oxlint-enable no-bitwise */

let next: () => number = Math.random;

/** Uniform [0, 1) from the current gameplay stream. */
export const rand = () => next();

/** Seed the gameplay stream. All rand() calls after this are deterministic. */
export const reseed = (seed: number) => {
  next = mulberry32(seed);
};
