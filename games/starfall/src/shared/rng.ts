// Central gameplay RNG (mirrors games/lunerfall/src/sys/rng.ts). Unseeded it
// behaves like Math.random; `reseed(n)` swaps in a deterministic mulberry32
// stream so a solo run's local rolls (enemy/asteroid spawns, loot classes,
// weapon drops, shot jitter) replay from one seed — which is what makes bot
// playtests and bug repros reproducible.
//
// Determinism boundary: only LOCALLY rolled gameplay randomness routes through
// `rand()`. Online, world rolls happen on whichever peer is host and travel
// over the wire — seeding cannot (and must not) reach across the network.
// View-only jitter (fx particles, fizzle bolts, debris, tint lerps) stays on
// Math.random so cosmetic rolls never perturb the gameplay stream.

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
