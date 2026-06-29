// Grid directions. North is -Z, East is +X, South is +Z, West is -X.
export type Dir = 0 | 1 | 2 | 3;
export const N: Dir = 0;
export const E: Dir = 1;
export const S: Dir = 2;
export const W: Dir = 3;

// Grid delta (dx, dz) for each direction.
export const DIR_DELTA: Record<Dir, readonly [number, number]> = {
  0: [0, -1],
  1: [1, 0],
  2: [0, 1],
  3: [-1, 0],
};

// A connection mask is a 4-bit set: bit d (1<<d) means "connected toward Dir d".
export type Mask = number;

export function maskHas(mask: Mask, d: Dir): boolean {
  return (mask & (1 << d)) !== 0;
}

export function maskCount(mask: Mask): number {
  return (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
}

// Rotate a connection mask by `q` clockwise quarter-turns (N->E->S->W).
export function rotateMask(mask: Mask, q: number): Mask {
  const t = ((q % 4) + 4) % 4;
  let out = 0;
  for (let d = 0; d < 4; d++) {
    if ((mask & (1 << d)) !== 0) out |= 1 << ((d + t) % 4);
  }
  return out;
}

// Game state as a discriminated union — illegal states are unrepresentable.
export type GameMode =
  | { readonly kind: "loading"; readonly progress: number }
  | { readonly kind: "title" }
  | { readonly kind: "playing" }
  | { readonly kind: "gameover"; readonly score: number; readonly fares: number };
