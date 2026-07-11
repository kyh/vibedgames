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

// Game state as a discriminated union — illegal states are unrepresentable.
export type GameMode =
  | { readonly kind: "loading"; readonly progress: number }
  | { readonly kind: "title" }
  | { readonly kind: "countdown"; t: number } // 3-2-1-GO launch + camera swoop
  | { readonly kind: "playing" }
  | { readonly kind: "gameover"; readonly score: number; readonly fares: number };

// An axis-aligned (or yaw-rotated) collision box in the static city.
export type Solid = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  // World-space top of the obstacle, when it CAN be jumped over (traffic).
  // Absent = infinitely tall (buildings, walls).
  readonly maxY?: number;
  // Rotation about the box CENTRE (three.js rotation.y convention). min/max
  // describe the UNROTATED box; consumers (car collision, camera clip,
  // physics) transform into the box's local frame. Absent = axis-aligned.
  readonly yaw?: number;
  // Skip the Rapier static collider (car/camera still collide). Used for the
  // thousands of tree trunks — punted debris passing through a tree is
  // invisible; ten thousand extra broadphase boxes is not.
  readonly noBody?: boolean;
  // Deliberately has NO visual (map-edge walls). Anything else the player can
  // hit must be visible — the e2e census fails on untagged sightless solids.
  readonly unseen?: string;
};

// A drivable surface patch floating over the terrain (pier deck, bridge ramp).
export type SurfaceDeck = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly y: number; // height at minZ
  readonly y2?: number; // height at maxZ (sloped ramp when set)
};
