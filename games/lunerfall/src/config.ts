export const BASE_H = 270;
export const clampAspect = (a: number) => Math.min(2.5, Math.max(1.4, a));

const winAspect =
  typeof window !== "undefined" && window.innerHeight > 0
    ? window.innerWidth / window.innerHeight
    : 16 / 9;

export const BASE_W = Math.round((BASE_H * clampAspect(winAspect)) / 2) * 2;
export const TILE = 16;
export const STEP = 1 / 60;
export const MAX_STEPS = 5;
export const MAX_LAG = 0.25;

export const interp = (prev: number, curr: number, alpha: number) =>
  Math.abs(curr - prev) > 30 ? curr : prev + (curr - prev) * alpha;

export const HERO_FRAME = 144;
export const ENEMY_FRAME = 80;

export const HERO_ORIGIN_Y = 79.5 / HERO_FRAME;
export const ENEMY_ORIGIN_Y = 47 / ENEMY_FRAME;

export const HERO_SCALE = 1.2;
export const ENEMY_SCALE = 1.3;

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
