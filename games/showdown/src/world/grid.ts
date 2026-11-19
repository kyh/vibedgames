import * as THREE from "three";

export const GRID = 44;
export const GRID_HALF = GRID / 2;
export const TILE_COUNT = GRID * GRID;

/** A tile coordinate pair `[x, y]`. */
export type TileCoord = [number, number];

export const gridIndex = (x: number, y: number) => y * GRID + x;

export const inGrid = (x: number, y: number) => x >= 0 && y >= 0 && x < GRID && y < GRID;

/** The four edge-sharing neighbour offsets, in the order cluster growth samples them. */
export const CARDINALS: readonly TileCoord[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Texels per tile in the painted ground colour map. */
export const BASE_TEXELS_PER_TILE = 32;

/** Texels per tile in the baked ground occlusion map. */
export const AO_TEXELS_PER_TILE = 16;

/** World-space coordinate → the tile that contains it. */
export const toTile = (world: number) => Math.floor(world + GRID_HALF);

/** Tile coordinate → the world-space coordinate of its centre. */
export const tileCenter = (tile: number) => tile + 0.5 - GRID_HALF;

export const SCRATCH_MATRIX = new THREE.Matrix4();
export const SCRATCH_POSITION = new THREE.Vector3();
export const SCRATCH_QUATERNION = new THREE.Quaternion();
export const SCRATCH_SCALE = new THREE.Vector3();
export const SCRATCH_EULER = new THREE.Euler();
export const SCRATCH_COLOR = new THREE.Color();

/** Collapses an instance to nothing; used to "remove" a destroyed prop. */
export const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/** Mixes a per-pass salt into the map seed so each builder gets its own stream. */
export const saltedSeed = (seed: number, salt: number) =>
  // oxlint-disable-next-line no-bitwise -- xor keeps the salted value an int32 like the seed itself
  seed ^ salt;
