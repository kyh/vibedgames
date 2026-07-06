// Base render + world constants. Single-screen rooms (TowerFall-style): the
// whole arena fits the base resolution, no in-room camera scroll.

export const BASE_W = 480;
export const BASE_H = 270;
export const TILE = 16; // world grid unit (px)

// Native frame sizes of the Luneblade sheets (square frames).
export const HERO_FRAME = 144;
export const ENEMY_FRAME = 80;

// Feet baseline within a frame, measured from the art (design/asset-bounds.json).
// Origin is (centerX, feetY) so a sprite's (x, y) is where its feet stand.
export const HERO_ORIGIN_Y = 79.5 / HERO_FRAME; // ~0.552
export const ENEMY_ORIGIN_Y = 47 / ENEMY_FRAME; // ~0.588

// Character content is tiny inside the big frame; scale up to arena size.
export const HERO_SCALE = 1.2;
export const ENEMY_SCALE = 1.3;

// Neon-shrine palette pulled from the tileset (teal / magenta on near-black).
export const COLORS = {
  bg: 0x0b0e14,
  bgDeep: 0x05070b,
  stone: 0x141922,
  stoneEdge: 0x1e2733,
  teal: 0x34e5c8,
  magenta: 0xe83fa0,
  ink: 0x0a0c11,
  white: 0xf4f7fb,
} as const;
