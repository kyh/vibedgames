// Central gameplay RNG. Offline unseeded play retains Math.random; online
// authority can capture the exact seeded stream for a checkpoint handoff.
function stream(seed: number) {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    state: () => a >>> 0,
  };
}

export function mulberry32(seed: number): () => number {
  return stream(seed).next;
}

let current: ReturnType<typeof stream> | null = null;

/** Uniform [0, 1) from the current gameplay stream. */
export const rand = (): number => (current ? current.next() : Math.random());

/** Seed the gameplay stream. Existing deterministic sequences stay exact. */
export function reseed(seed: number): void {
  current = stream(seed);
}

/** Only a fresh online expedition needs to adopt a capturable stream. */
export function checkpointRng(): number {
  current ??= stream(Math.floor(Math.random() * 0x100000000));
  return current.state();
}

/** The captured word is the state BEFORE the next draw; no draw on restore. */
export function restoreRng(state: number): void {
  current = stream(state);
}
