// Small numeric helpers for game loops. Zero dependencies.
// Approach inspired by GameBlocks (https://github.com/xt4d/GameBlocks).

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const clamp01 = (value: number): number => clamp(value, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/**
 * Framerate-independent smoothing factor. `lag` is roughly the time in seconds to
 * close ~63% of the remaining gap; the return value is the alpha to lerp by THIS
 * frame given `deltaSeconds`.
 *
 * Use this instead of a fixed `lerp(a, b, 0.1)` per frame — a constant alpha makes
 * the smoothing speed depend on framerate (twice the FPS = twice as fast), which is
 * the usual cause of "camera/movement feels different on my machine".
 */
export function smoothingAlpha(lag: number, deltaSeconds: number): number {
  if (lag <= 0) return 1;
  return 1 - Math.exp(-Math.max(0, deltaSeconds) / lag);
}

/** Move `current` toward `target` with framerate-independent smoothing. */
export const smoothToward = (
  current: number,
  target: number,
  lag: number,
  deltaSeconds: number,
): number => current + (target - current) * smoothingAlpha(lag, deltaSeconds);

/**
 * Deterministic, seedable PRNG (mulberry32). The same seed produces the same
 * sequence on every machine — use it for replays, procedural layout, and
 * host-authoritative multiplayer where every client must agree on the rolls.
 * Never use `Math.random()` for those; it is not seedable and diverges per client.
 */
export class Random {
  private state: number;

  constructor(seed = 42) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** Uniformly pick one element. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}
