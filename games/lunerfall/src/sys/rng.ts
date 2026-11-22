/* oxlint-disable no-bitwise -- mulberry32 is defined on int32 wraparound; the shifts and masks below are the algorithm. */

interface Stream {
  next: () => number;
  state: () => number;
}

const stream = (seed: number) => {
  let a = seed >>> 0;

  return {
    next: () => {
      // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps to int32; Math.trunc does not.
      a = (a + 0x6d_2b_79_f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    },
    state: () => a >>> 0,
  };
};

export const mulberry32 = (seed: number) => stream(seed).next;

let current: Stream | null = null;

/** Uniform [0, 1) from the current gameplay stream. */
export const rand = () => (current ? current.next() : Math.random());

/** Seed the gameplay stream. All rand() calls after this are deterministic. */
export const reseed = (seed: number) => {
  current = stream(seed);
};

/** Back to Math.random: a stream adopted for one run (online checkpoints, a
 * test seed) must not replay into the next. */
export const unseed = () => {
  current = null;
};

/** Current stream word for a checkpoint; an unseeded stream adopts a random seed first. */
export const checkpointRng = () => {
  current ??= stream(Math.floor(Math.random() * 0x1_00_00_00_00));

  return current.state();
};

/** The captured word is the state BEFORE the next draw; no draw on restore. */
export const restoreRng = (state: number) => {
  current = stream(state);
};
