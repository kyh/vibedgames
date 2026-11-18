export interface Standing {
  key: string;
  /** Lap progress in samples. */
  prog: number;
  /** Room clock at the finish line, 0 while still racing. */
  finishMs: number;
}

/** Finishers by time, then everyone else by distance covered. */
export const rank = <T extends Standing>(entries: readonly T[]) =>
  entries.toSorted((p, q) => {
    if (p.finishMs > 0 && q.finishMs > 0) {
      return p.finishMs - q.finishMs;
    }

    if (p.finishMs > 0 || q.finishMs > 0) {
      return p.finishMs > 0 ? -1 : 1;
    }

    return q.prog - p.prog;
  });

const SUFFIXES = ["th", "st", "nd", "rd"] as const;

export const ordinal = (place: number) => {
  const tens = place % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (SUFFIXES[place % 10] ?? "th");

  return `${place}${suffix}`;
};

/** `m:ss.t` from milliseconds, truncated to the tenth so a clock never shows 0:60.0. */
export const formatTime = (ms: number) => {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);

  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
};
