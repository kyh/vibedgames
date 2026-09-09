import { EXPLOSION_MS, tileKey } from "../shared/constants";
import type { Blast } from "../shared/constants";

export type FireCell = Readonly<{ col: number; row: number; placedAt: number }>;

/** The original 16-frame video is 32fps. A late snapshot seeks, never replays. */
export function blastFrame(placedAt: number, now: number): number | null {
  const age = now - placedAt;
  return age < 0 || age >= EXPLOSION_MS ? null : Math.min(15, Math.floor(age * 0.032));
}

/** Overlaps share one visual until the newest accepted blast expires. */
export function fireCells(blasts: readonly Blast[], now: number): Map<string, FireCell> {
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
}

/** Allow ordinary delivery latency; old snapshots do not replay impact cues. */
export function freshCue(placedAt: number, now: number): boolean {
  return now >= placedAt && now - placedAt <= 140;
}
