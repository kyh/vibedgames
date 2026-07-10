// Central gameplay RNG. Unseeded it behaves like Math.random; `reseed(n)` swaps
// in a deterministic mulberry32 stream so a whole run (room layouts, room-type
// rolls, enemy picks, crits, relic offers, boss patterns) replays from one seed
// — which is what makes bot playtests and bug repros reproducible.
//
// Route every roll that affects GAMEPLAY through `rand()`. View-only jitter
// (fx particles, parallax, sfx pitch) can stay on Math.random.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let next: () => number = Math.random;

/** Uniform [0, 1) from the current gameplay stream. */
export const rand = (): number => next();

/** Seed the gameplay stream. All rand() calls after this are deterministic. */
export function reseed(seed: number): void {
  next = mulberry32(seed);
}
