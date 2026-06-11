// ---- physics (per-second; converted from the legacy 60fps per-tick values) ---

/** 0.5 px/tick² × 60² — downward acceleration. */
export const GRAVITY = 1800;
/** -12 px/tick × 60 — velocity set (not added) on a full-strength flap. */
export const FLAP_VELOCITY = -720;
/** -8 px/tick × 60 — flap velocity at pose-jump strength 0 (legacy JUMP_VELOCITY). */
export const FLAP_VELOCITY_MIN = -480;
/** 2.5 px/tick × 60 — leftward pipe scroll. */
export const PIPE_SPEED = 150;

// ---- geometry -----------------------------------------------------------------

/** Left edge of the bird's AABB (fixed; the world scrolls past it). */
export const BIRD_X = 50;
/** Top edge of the AABB at spawn. */
export const BIRD_SPAWN_Y = 200;
export const BIRD_W = 34;
export const BIRD_H = 24;

export const PIPE_WIDTH = 50;
/** Vertical gap between pipe segments — generous on purpose (legacy fidelity). */
export const PIPE_GAP = 350;
/** Spawn a new pipe once the last one is this far from the right edge. */
export const PIPE_SPAWN_DISTANCE = 350;
/** Drawn segment length; long enough to cover any reasonable viewport. */
export const PIPE_DRAW_HEIGHT = 640;

// ---- presentation ---------------------------------------------------------------

/** Every digit renders at 24×36 (1.png is natively 16 wide — legacy stretched it). */
export const DIGIT_W = 24;
export const DIGIT_H = 36;
export const SCORE_Y = 20;

/** Wing-cycle frame rate (legacy stepped a frame per tick = comic 20Hz; ~10fps reads right). */
export const BIRD_FLAP_FPS = 10;

/** Legacy tilt was clamp(vyPerTick × 0.1) rad; vy is now px/s, so divide by 60. */
export const TILT_FACTOR = 0.1 / 60;
export const MAX_TILT = Math.PI / 4;

// ---- persistence ----------------------------------------------------------------

export const BEST_KEY = "flappy-best";

// ---- types ----------------------------------------------------------------------

export type Phase = "ready" | "playing" | "gameover";

// ---- pure helpers ----------------------------------------------------------------

/**
 * Height of the top pipe segment (= top edge of the gap). Legacy formula:
 * random × (viewH − gap − 100) + 50 → range [50, viewH − gap − 50].
 */
export function rollTopHeight(viewHeight: number): number {
  return Math.random() * Math.max(0, viewHeight - PIPE_GAP - 100) + 50;
}

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
