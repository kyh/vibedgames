import { EXPLOSION_MS, tileKey } from "../shared/constants";
import type { Blast } from "../shared/constants";

export type FireCell = Readonly<{ col: number; row: number; placedAt: number }>;

const ageOf = (placedAt: number, now: number) => Math.max(0, now - placedAt);

/** How old a stamp may be when first seen and still cue: a whole trip from the host on a slow route. */
export const CUE_WINDOW_MS = 400;

/** The original 16-frame video is 32fps. A late snapshot seeks, never replays. */
export const blastFrame = (placedAt: number, now: number) => {
  const age = ageOf(placedAt, now);

  return age >= EXPLOSION_MS ? null : Math.min(15, Math.floor(age * 0.032));
};

/** Overlaps share one visual until the newest accepted blast expires. */
export const fireCells = (blasts: readonly Blast[], now: number) => {
  const cells = new Map<string, FireCell>();

  for (const blast of blasts) {
    if (blastFrame(blast.placedAt, now) === null) {
      continue;
    }

    for (const tile of blast.tiles) {
      const key = tileKey(tile.col, tile.row);
      const previous = cells.get(key);

      if (!previous || previous.placedAt < blast.placedAt) {
        cells.set(key, { ...tile, placedAt: blast.placedAt });
      }
    }
  }

  return cells;
};

/** Allow ordinary delivery latency; old snapshots do not replay impact cues. */
export const freshCue = (placedAt: number, now: number) => ageOf(placedAt, now) <= CUE_WINDOW_MS;
