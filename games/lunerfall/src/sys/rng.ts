// Central gameplay RNG. Unseeded it behaves like Math.random; `reseed(n)` swaps
// in a deterministic mulberry32 stream so a whole run (room layouts, room-type
// rolls, enemy picks, crits, relic offers, boss patterns) replays from one seed
// — which is what makes bot playtests and bug repros reproducible, and lets an
// online host hand its exact stream to a successor (checkpointRng/restoreRng).
//
// Route every roll that affects GAMEPLAY through `rand()`. View-only jitter
// (fx particles, parallax, sfx pitch) can stay on Math.random.
function stream(seed: number) {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d_2b_79_f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
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

/** Seed the gameplay stream. All rand() calls after this are deterministic. */
export function reseed(seed: number): void {
  current = stream(seed);
}

/** Back to Math.random: a stream adopted for one run (online checkpoints, a
 * test seed) must not replay into the next. */
export function unseed(): void {
  current = null;
}

/** Current stream word for a checkpoint; an unseeded stream adopts a random seed first. */
export function checkpointRng(): number {
  current ??= stream(Math.floor(Math.random() * 0x1_00_00_00_00));
  return current.state();
}

/** The captured word is the state BEFORE the next draw; no draw on restore. */
export function restoreRng(state: number): void {
  current = stream(state);
}
