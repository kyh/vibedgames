/** Versioned, opt-in sequence. The ordinary seven-bag never uses this stream. */
export const FIXED_RUN_NAME = "Fixed sequence";
export const FIXED_RUN_SEED = 0x54455431;
export const FIXED_RUN_BEST_KEY = "tetris:fixed-sequence:v1:best";
export type RunMode = { kind: "normal" } | { kind: "fixed" };

/** A fresh generator per start/retry isolates bags from all cosmetic randomness. */
export function createFixedRandom(): () => number {
  let word = FIXED_RUN_SEED;
  return () => {
    word = (word + 0x6d2b79f5) | 0;
    let value = Math.imul(word ^ (word >>> 15), 1 | word);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseFixedBest(raw: string | null): number {
  if (raw === null || !/^(0|[1-9]\d*)$/.test(raw)) return 0;
  const score = Number(raw);
  return Number.isSafeInteger(score) ? score : 0;
}

export function readFixedBest(): number {
  try {
    return parseFixedBest(localStorage.getItem(FIXED_RUN_BEST_KEY));
  } catch {
    return 0;
  }
}

/** Call only at the existing finished-run edge; the caller retains the visit best. */
export function storeFixedBest(score: number): void {
  if (!Number.isSafeInteger(score) || score < 0) return;
  try {
    localStorage.setItem(FIXED_RUN_BEST_KEY, String(score));
  } catch {
    // Storage denial must not interrupt results or retry.
  }
}
