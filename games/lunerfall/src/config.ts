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
// world grid unit (px)
export const TILE = 16;
// fixed sim step (s) and the per-frame catch-up cap
export const STEP = 1 / 60;
export const MAX_STEPS = 5;

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
// ~0.552
export const HERO_ORIGIN_Y = 79.5 / HERO_FRAME;
// ~0.588
export const ENEMY_ORIGIN_Y = 47 / ENEMY_FRAME;

// Character content is tiny inside the big frame; scale up to arena size.
export const HERO_SCALE = 1.2;
export const ENEMY_SCALE = 1.3;

// Neon-shrine palette pulled from the tileset (teal / magenta on near-black).
export const COLORS = {
  bg: 0x0b_0e_14,
  bgDeep: 0x05_07_0b,
  ink: 0x0a_0c_11,
  magenta: 0xe8_3f_a0,
  stone: 0x14_19_22,
  stoneEdge: 0x1e_27_33,
  teal: 0x34_e5_c8,
  white: 0xf4_f7_fb,
} as const;
