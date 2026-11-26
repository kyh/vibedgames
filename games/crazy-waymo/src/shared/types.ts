export type Dir = 0 | 1 | 2 | 3;

export const N = 0 satisfies Dir;
export const E = 1 satisfies Dir;
export const S = 2 satisfies Dir;
export const W = 3 satisfies Dir;

export const DIR_DELTA = {
  0: [0, -1],
  1: [1, 0],
  2: [0, 1],
  3: [-1, 0],
} satisfies Record<Dir, readonly [number, number]>;

export type Mask = number;

/* oxlint-disable no-bitwise -- connection masks are bit sets */
export const maskHas = (mask: Mask, d: Dir) => (mask & (1 << d)) !== 0;

export const maskCount = (mask: Mask) =>
  (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
/* oxlint-enable no-bitwise */

export type GameMode =
  | { readonly kind: "loading"; readonly progress: number }
  | { readonly kind: "title" }
  | { readonly kind: "countdown"; t: number }
  | { readonly kind: "playing" }
  | { readonly kind: "gameover"; readonly score: number; readonly fares: number };

export type Solid = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly yaw?: number;
  readonly noBody?: boolean;
  readonly unseen?: string;
} & (
  | { readonly minY: number; readonly maxY: number }
  | { readonly minY?: never; readonly maxY?: number }
);

export type SurfaceDeck = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly y: number;
  readonly y2?: number;
};
