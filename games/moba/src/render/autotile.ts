// Single source of truth for the terrain tileset's autotile layout (the 9-wide
// sheet shared by tiles.webp in the live game and sc-tiles in the ?gallery=map gallery).
// The renderer (render/view.ts) and the gallery (scenes/gallery-scene.ts) both
// paint from these tables, so they MUST agree tile-for-tile — keeping them here
// removes the hand-sync ("verified tile-by-tile") drift between the two files.
// Frame INDICES live here, not in data/map.ts: map.ts is the geometry source of
// truth (consumed by the nav grid too) and must stay free of art/tileset coupling.

// Autotile neighbour-OUTSIDE bit weights: a bit is set when the orthogonal
// neighbour in that direction is OUTSIDE the set being tiled (an exposed edge
// faces that way). Only the 4 orthogonal neighbours participate → masks 0..15.
const BITS = { E: 4, N: 8, S: 2, W: 1 } as const;

/** Neighbour-OUTSIDE mask (0..15) for the cell at (cx,cy). `out(cx,cy)` returns
 *  true when that cell is OUTSIDE the set being autotiled. Centralised so the
 *  N/E/S/W bit order can't silently diverge between the two consumers. */
/* oxlint-disable no-bitwise -- the mask is a real 4-bit neighbour bitfield */
export const autotileMask = (
  out: (cx: number, cy: number) => boolean,
  cx: number,
  cy: number,
): number =>
  (out(cx, cy - 1) ? BITS.N : 0) |
  (out(cx + 1, cy) ? BITS.E : 0) |
  (out(cx, cy + 1) ? BITS.S : 0) |
  (out(cx - 1, cy) ? BITS.W : 0);
/* oxlint-enable no-bitwise */

// Flat-grass autotile: neighbour mask → tileset frame index (centre/interior = 10).
export const FLAT_AUTOTILE = new Map<number, number>([
  [0, 10],
  [8, 1],
  [4, 11],
  [2, 19],
  [1, 9],
  [9, 0],
  [12, 2],
  [3, 18],
  [6, 20],
  [5, 12],
  [10, 28],
  [13, 3],
  [7, 21],
  [11, 27],
  [14, 29],
  [15, 30],
]);

// Elevated grass is the identical autotile shifted 5 columns right (+5 per frame),
// so it can never disagree with the flat table — derived, not a second literal.
export const ELEV_AUTOTILE = new Map<number, number>(
  [...FLAT_AUTOTILE].map(([k, v]) => [k, v + 5]),
);

/** Grass frame for a neighbour mask on the flat or elevated layer (falls back to
 *  the interior tile, which is what an absent key would have rendered anyway). */
export const autotileFrame = (elevated: boolean, mask: number): number =>
  (elevated ? ELEV_AUTOTILE : FLAT_AUTOTILE).get(mask) ?? (elevated ? 15 : 10);

// Stone cliff-face frames under a plateau's south edge. The gallery draws the full
// 2-row wall (top* + bot*); the live renderer's 1-row wall uses only the top* four.
export const CLIFF_FRAMES = {
  botL: 50,
  botM: 51,
  botNarrow: 53,
  botR: 52,
  topL: 41,
  topM: 42,
  topNarrow: 44,
  topR: 43,
};

// Diagonal grass slope frames for SIDE ramps: left/right facing × top/bottom row.
export const SLOPE_FRAMES = { leftBot: 45, leftTop: 36, rightBot: 48, rightTop: 39 };
