/** Screen-relative directions the player expresses (via keys or pose). */
export type ScreenDir = "left" | "right" | "away" | "near";

/** World-plane delta (dx, dz) the slab actually moves. */
export interface Move {
  dx: number;
  dz: number;
}

const TABLE: Record<ScreenDir, Move>[] = [
  {
    away: { dx: 0, dz: -1 },
    left: { dx: -1, dz: 0 },
    near: { dx: 0, dz: 1 },
    right: { dx: 1, dz: 0 },
  },
  {
    away: { dx: -1, dz: 0 },
    left: { dx: 0, dz: 1 },
    near: { dx: 1, dz: 0 },
    right: { dx: 0, dz: -1 },
  },
  {
    away: { dx: 0, dz: 1 },
    left: { dx: 1, dz: 0 },
    near: { dx: 0, dz: -1 },
    right: { dx: -1, dz: 0 },
  },
  {
    away: { dx: 1, dz: 0 },
    left: { dx: 0, dz: -1 },
    near: { dx: -1, dz: 0 },
    right: { dx: 0, dz: 1 },
  },
];

/** Resolve a screen-relative direction to a world move for the active corner. */
export const screenToWorld = (corner: number, dir: ScreenDir) => {
  const c = ((corner % 4) + 4) % 4;
  const row = TABLE[c];

  return row ? row[dir] : { dx: 0, dz: 0 };
};
