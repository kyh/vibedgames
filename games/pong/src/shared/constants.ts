// All tunables for Pong. Units are world units; speeds are per second.
// Court is a 10x20 table in the XY plane (x = width, y = depth, z = up);
// the player defends the near edge (-y), the AI the far edge (+y).

// ---- court geometry ----------------------------------------------------------
export const COURT_W = 10;
export const COURT_D = 20;
export const TABLE_THICK = 0.5;
export const WALL_X = 4.9; // ball |x| at which it bounces off the side
export const GOAL_Y = COURT_D / 2; // past ±this = point scored
export const CENTER_STRIPE = { w: COURT_W, h: 0.1 } as const;

// ---- paddles -----------------------------------------------------------------
export const PADDLE_Y = 8; // player at -8, AI at +8
export const PADDLE_X_MAX = 4.5;
export const PADDLE_RING_R = 0.5;
export const PADDLE_TUBE_R = 0.1;
export const PADDLE_Z = 0.5; // ring center height — ball flies through the hoop
// Hitbox is deliberately larger than the visible ring (outer radius 0.6).
export const HIT_HALF_Y = 0.5;
export const HIT_HALF_X = 0.7;

// ---- ball physics ------------------------------------------------------------
export const BALL_R = 0.2;
export const BALL_SPEED = 6; // constant magnitude, always
// Floor on the toward-opponent velocity fraction after a paddle hit, so
// near-edge grazes can't degenerate into slow horizontal crawls.
export const MIN_VY_FRAC = 0.25;
export const SERVE_SPREAD = 0.1; // serve angle jitter (rad), always toward player

// ---- cosmetic arc (visual z only — collisions/score use x/y) ------------------
export const ARC_PEAK = 2;
export const ARC_LAND_MIN = 4; // arc lands 4-7 units into the opponent half
export const ARC_LAND_MAX = 7;

// ---- AI ----------------------------------------------------------------------
// Chases ball x, clamped to never overshoot. Near-perfect by design: ball
// |vx| <= 6, so only sharp edge-angled returns beat it.
export const AI_SPEED = 4.8;

// ---- input -------------------------------------------------------------------
export const KEY_SPEED = 12; // ArrowLeft/Right or A/D paddle speed (units/s)

// ---- hand tracking (webcam) ----------------------------------------------------
// Legacy mapping: targetX = (1 - wristX) * 9 - 4.5, clamped ±4.5 (mirrored).
export const HAND_RANGE = 9;
// Legacy adaptive smoothing, per 60fps frame: lerp = clamp(0.2 + |Δwrist|·10, 0, 1)
// — base 0.2, snappier when the hand moves fast. Converted to dt via frameLerp.
export const HAND_LERP_BASE = 0.2;
export const HAND_LERP_ACCEL = 10;
// No recognizer result for this long → hand is "lost" and pointer control
// resumes. (Fixes the legacy bug where the first detection killed pointer
// control for the whole session — handPosition never returned to null.)
export const HAND_TIMEOUT_MS = 500;

// ---- drag-pan camera ------------------------------------------------------------
// Legacy gimmick: dragging pans the camera (camX -= dx·scale, camY += dy·scale);
// on release it lerps back to rest at 0.1 per 60fps frame. The camera also
// starts 1 unit above rest — (0,-12,12) easing to (0,-13,12) — and its
// orientation is fixed at startup (panning translates without re-aiming).
export const DRAG_PAN_SCALE = 0.02;
/** Mouse-up within this distance of mouse-down counts as a click (serve), not a pan. */
export const CLICK_DRAG_TOLERANCE_PX = 5;
export const CAM_RETURN_LERP = 0.1;
export const CAM_START_OFFSET_Y = 1;
// Reference frame rate for converting legacy per-frame lerp factors to dt.
export const LEGACY_FPS = 60;

// ---- rules -------------------------------------------------------------------
export const WIN_SCORE = 7;

// ---- camera ------------------------------------------------------------------
export const CAM_FOV = 50;
export const CAM_POS = { x: 0, y: -13, z: 12 } as const;

// ---- look --------------------------------------------------------------------
export const INK = 0x000000;
export const BG = 0xd4d4d4;
export const SHADOW_MAX_OPACITY = 0.3;

// ---- feel (craft pass) ---------------------------------------------------------
export const MAX_DT = 0.05; // clamp delta after tab-switch so the ball can't tunnel
export const PULSE_SCALE = 0.35; // paddle ring pop amplitude on hit
export const PULSE_DECAY = 9; // exp decay rate (1/s) for the pop
export const SQUASH = 0.3; // ball squash amplitude on bounce
export const SQUASH_RECOVER = 10; // exp recovery rate (1/s) toward round
export const NUDGE_SCALE = 0.035; // camera kick = departing ball velocity × this
export const NUDGE_DECAY = 7; // exp decay rate (1/s) for the camera kick
export const GOAL_FLASH_DECAY = 4; // exp decay rate (1/s) for the conceded-line flash
