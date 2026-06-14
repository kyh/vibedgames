// Camera-relative movement: the well is viewed from one of 4 fixed corners,
// so "screen-left" must resolve to a different world axis per corner. This is
// the load-bearing remap that makes orbiting a real tactical act — ported
// from the reference controls.cameraCorrection(), as a pure typed function.

/** Screen-relative directions the player expresses (via keys or pose). */
export type ScreenDir = "left" | "right" | "away" | "near";

/** World-plane delta (dx, dz) the slab actually moves. */
export type Move = { dx: number; dz: number };

// Per-corner remap. corner 0 is the home framing; each step rotates the
// mapping a quarter turn so the slab always tracks the player's screen.
const TABLE: Record<ScreenDir, Move>[] = [
  // corner 0
  { left: { dx: -1, dz: 0 }, right: { dx: 1, dz: 0 }, away: { dx: 0, dz: -1 }, near: { dx: 0, dz: 1 } },
  // corner 1
  { left: { dx: 0, dz: 1 }, right: { dx: 0, dz: -1 }, away: { dx: -1, dz: 0 }, near: { dx: 1, dz: 0 } },
  // corner 2
  { left: { dx: 1, dz: 0 }, right: { dx: -1, dz: 0 }, away: { dx: 0, dz: 1 }, near: { dx: 0, dz: -1 } },
  // corner 3
  { left: { dx: 0, dz: -1 }, right: { dx: 0, dz: 1 }, away: { dx: 1, dz: 0 }, near: { dx: -1, dz: 0 } },
];

/** Resolve a screen-relative direction to a world move for the active corner. */
export function screenToWorld(corner: number, dir: ScreenDir): Move {
  const c = ((corner % 4) + 4) % 4;
  const row = TABLE[c];
  return row ? row[dir] : { dx: 0, dz: 0 };
}
