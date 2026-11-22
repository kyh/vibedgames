const BITS = { E: 4, N: 8, S: 2, W: 1 } as const;

/** Neighbour-OUTSIDE mask (0..15) for the cell at (cx,cy). `out(cx,cy)` returns
 *  true when that cell is OUTSIDE the set being autotiled. Centralised so the
 *  N/E/S/W bit order can't silently diverge between the two consumers. */
/* oxlint-disable no-bitwise -- the mask is a real 4-bit neighbour bitfield */
export const autotileMask = (out: (cx: number, cy: number) => boolean, cx: number, cy: number) =>
  (out(cx, cy - 1) ? BITS.N : 0) |
  (out(cx + 1, cy) ? BITS.E : 0) |
  (out(cx, cy + 1) ? BITS.S : 0) |
  (out(cx - 1, cy) ? BITS.W : 0);
/* oxlint-enable no-bitwise */

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

export const ELEV_AUTOTILE = new Map<number, number>(
  [...FLAT_AUTOTILE].map(([k, v]) => [k, v + 5]),
);

/** Grass frame for a neighbour mask on the flat or elevated layer (falls back to
 *  the interior tile, which is what an absent key would have rendered anyway). */
export const autotileFrame = (elevated: boolean, mask: number) =>
  (elevated ? ELEV_AUTOTILE : FLAT_AUTOTILE).get(mask) ?? (elevated ? 15 : 10);

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

export const SLOPE_FRAMES = { leftBot: 45, leftTop: 36, rightBot: 48, rightTop: 39 };
