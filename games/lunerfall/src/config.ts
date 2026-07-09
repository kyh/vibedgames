// Base render + world constants. The camera scrolls over rooms larger than the
// screen, so the render WIDTH is free to match the browser window: we fix the
// height at 270 and derive the width from the window's aspect ratio, so
// Scale.FIT scales the game edge-to-edge with no letterbox bars (a wide window
// just sees more of the room horizontally). Clamped so the viewport never gets
// wider than the narrowest room (which would show void past the walls) nor
// absurdly wide on ultrawides. Node/headless (no `window`) falls back to 16:9 →
// 480, keeping the sim harness deterministic.
export const BASE_H = 270;
// The render-width aspect band (shared with main.ts's rotation check, which
// must apply the same clamp to know whether a resize would change BASE_W).
export const clampAspect = (a: number): number => Math.min(2.5, Math.max(1.4, a));
const winAspect =
  typeof window !== "undefined" && window.innerHeight > 0
    ? window.innerWidth / window.innerHeight
    : 16 / 9;
export const BASE_W = Math.round((BASE_H * clampAspect(winAspect)) / 2) * 2;
export const TILE = 16; // world grid unit (px)

// Render interpolation: the sim runs at a fixed 60Hz but the screen may refresh
// faster (120Hz on ProMotion), so rendering the raw sim position judders. Blend
// the previous → current sim position by `alpha` (the leftover fraction of a
// step) to get smooth motion at any refresh rate. Teleport-sized jumps (blinks)
// snap instead of sliding across the screen.
export const interp = (prev: number, curr: number, alpha: number): number =>
  Math.abs(curr - prev) > 30 ? curr : prev + (curr - prev) * alpha;

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
