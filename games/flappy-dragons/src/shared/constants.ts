// ---- physics (per-second; converted from the legacy 60fps per-tick values) ---

/** 0.5 px/tick² × 60² — downward acceleration. */
export const GRAVITY = 1800;
/** -12 px/tick × 60 — velocity set (not added) on a full-strength flap. */
export const FLAP_VELOCITY = -720;
/** -8 px/tick × 60 — flap velocity at pose-jump strength 0 (legacy JUMP_VELOCITY). */
export const FLAP_VELOCITY_MIN = -480;
/** 2.5 px/tick × 60 — leftward pipe scroll. */
export const PIPE_SPEED = 150;

// ---- art scale --------------------------------------------------------------

/** All art is 16px-grid pixel art; everything renders at 2×. */
export const ART_SCALE = 2;

// ---- geometry -----------------------------------------------------------------

/** Left edge of the dragon's AABB (fixed; the world scrolls past it). */
export const BIRD_X = 50;
/** Top edge of the AABB at spawn. */
export const BIRD_SPAWN_Y = 200;
/** Dragon body AABB (wings above it don't collide — forgiving on purpose). */
export const BIRD_W = 76;
export const BIRD_H = 48;
/**
 * Dragon frames are 48×80 with the body in a sub-rect (native x 6..44, y 32..56).
 * Sprite center = AABB top-left + these offsets, at ART_SCALE.
 */
export const DRAGON_SPRITE_OFFSET_X = 36;
export const DRAGON_SPRITE_OFFSET_Y = 16;
/** Skin variants shipped from the pack (dragon-1 … dragon-14, 4 frames each). */
export const DRAGON_SKINS = 14;

/** Collision width = trunk body width (50 native × 2). */
export const PIPE_WIDTH = 100;
/** Vertical gap between trunk segments — generous on purpose (legacy fidelity). */
export const PIPE_GAP = 350;
/** Spawn a new trunk once the last one is this far from the right edge (350 + 50 widening, keeps the legacy 300px corridor). */
export const PIPE_SPAWN_DISTANCE = 400;

/** tube-cap.png is 74×48 native — the rounded log end with side branches. */
export const TUBE_CAP_H = 96;

// ---- coins -------------------------------------------------------------------

/** Fraction of trunks that carry a coin somewhere in their gap. */
export const COIN_CHANCE = 0.6;
/** Coin keeps this distance from the gap edges. */
export const COIN_MARGIN = 70;

// ---- presentation ---------------------------------------------------------------

/** digits.png is a 10-frame 16×16 strip, rendered 2×. */
export const DIGIT_W = 32;
export const DIGIT_H = 32;
export const SCORE_Y = 20;

/** Wing-cycle frame rate (legacy stepped a frame per tick = comic 20Hz; ~10fps reads right). */
export const BIRD_FLAP_FPS = 10;

/** Background parallax factors per layer (clouds → bushes), × world scroll. */
export const BG_FACTORS = [0.08, 0.2, 0.45, 1] as const;
/** Source height of every bg-N.png layer. */
export const BG_NATIVE_H = 256;
/** Idle cloud drift on the ready screen, px/s of world scroll. */
export const READY_DRIFT = 12;

/** Legacy tilt was clamp(vyPerTick × 0.1) rad; vy is now px/s, so divide by 60. */
export const TILT_FACTOR = 0.1 / 60;
export const MAX_TILT = Math.PI / 4;

// ---- persistence ----------------------------------------------------------------

export const BEST_KEY = "flappy-best";
/** "1" = sound ON; anything else (or absent) = muted. Muted is the default. */
export const SOUND_KEY = "flappy-dragons:sound";

// ---- multiplayer -------------------------------------------------------------
// Survival race: everyone flies through the SAME endless course (one shared
// seed → identical pipe layout) on a single global scroll clock the host owns.
// Each player runs their own dragon and dies independently; you see the others
// as live ghosts weaving the same pipes. Crash → brief respawn, keep racing.
// Alone (or with the party server unreachable) it degrades to the classic solo
// game: the world freezes on a crash and you tap to restart.
export const MP_ROOM = "flappy-dragons-default";
export const MP_MAX_PLAYERS = 8;
export const OFFLINE_FALLBACK_MS = 4000;
/** Per-player state (bird height / score / liveness) broadcast rate. */
export const NET_TICK_HZ = 20;
/** Host's global world-scroll broadcast rate (guests dead-reckon between). */
export const WORLD_TICK_HZ = 15;
/** Empty runway (course units) before the first pipe of the course. */
export const RUNWAY = 700;
/** How long a crashed dragon waits before respawning in a multiplayer race. */
export const RESPAWN_MS = 1300;

// ---- deterministic course (seeded, identical on every client) ----------------

/** A stable 0..1 hash for course slot `i` under `seed` (mulberry32-style). */
export function hash01(seed: number, i: number): number {
  let t = (seed ^ (i * 0x9e3779b9)) >>> 0;
  t = (t + 0x6d2b79f5) >>> 0;
  let x = Math.imul(t ^ (t >>> 15), 1 | t);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

/** Course x of pipe `i` (absolute, viewport-independent). */
export function pipeCourseX(i: number): number {
  return RUNWAY + i * PIPE_SPAWN_DISTANCE;
}

/**
 * Top-segment height for pipe `i`, as the SAME relative placement on every
 * client: a seeded fraction of the local play area, so differently-sized
 * viewports still put the gap at the same relative height (fair enough for a
 * drop-in demo without a virtual-resolution rewrite).
 */
export function topHeightFor(seed: number, i: number, viewHeight: number): number {
  return Math.round(hash01(seed, i) * Math.max(0, viewHeight - PIPE_GAP - 100) + 50);
}

/** Whether pipe `i` carries a coin (deterministic). */
export function coinPresentFor(seed: number, i: number): boolean {
  return hash01(seed, i * 2 + 1) < COIN_CHANCE;
}

/** Coin Y within pipe `i`'s gap (deterministic). */
export function coinYFor(seed: number, i: number, topHeight: number): number {
  return topHeight + COIN_MARGIN + hash01(seed, i * 2 + 7) * (PIPE_GAP - 2 * COIN_MARGIN);
}

// ---- types ----------------------------------------------------------------------

export type Phase = "ready" | "playing" | "gameover";

// ---- pure helpers ----------------------------------------------------------------

/**
 * Flap velocity for a given strength ∈ [0,1]. Legacy mapping (per tick):
 * JUMP_VELOCITY + (MAX_JUMP_VELOCITY − JUMP_VELOCITY) × strength = -8..-12,
 * converted to px/s: -480..-720. Key/tap inputs always pass strength 1;
 * webcam pose jumps produce variable strengths.
 */
export function flapVelocityFor(strength: number): number {
  const s = Math.min(Math.max(strength, 0), 1);
  return FLAP_VELOCITY_MIN + (FLAP_VELOCITY - FLAP_VELOCITY_MIN) * s;
}

/** Random skin index 1..DRAGON_SKINS. */
export function rollSkin(): number {
  return 1 + Math.floor(Math.random() * DRAGON_SKINS);
}
