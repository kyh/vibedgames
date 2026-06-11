// All tunables for Pong. Units are world units; speeds are per second.
// Court is a 10x20 table in the XY plane (x = width, y = depth, z = up);
// the player defends the near edge (-y), the AI the far edge (+y).

// ---- court geometry ----------------------------------------------------------
export const COURT_W = 10;
export const COURT_D = 20;
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
// Rally ramp: every paddle hit adds RALLY_SPEED_STEP, resetting each point.
// Cap stays under 2·HIT_HALF_Y / MAX_DT (= 20) so the ball can't step over a
// paddle's hit band in a single clamped frame.
export const RALLY_SPEED_BASE = 7; // serve speed (constant magnitude during flight)
export const RALLY_SPEED_STEP = 0.45;
export const RALLY_SPEED_MAX = 13;
// Floor on the toward-opponent velocity fraction after a paddle hit, so
// near-edge grazes can't degenerate into slow horizontal crawls.
export const MIN_VY_FRAC = 0.25;
export const SERVE_SPREAD = 0.1; // serve angle jitter (rad), always toward player
export const AUTO_SERVE_S = 1.1; // dead air between points before auto-serve

// ---- cosmetic arc (visual z only — collisions/score use x/y) ------------------
export const ARC_PEAK = 2;
export const ARC_LAND_MIN = 4; // arc lands 4-7 units into the opponent half
export const ARC_LAND_MAX = 7;

// ---- AI ----------------------------------------------------------------------
// Chases ball x, clamped to never overshoot, at a fixed fraction of the
// current ball speed (legacy 4.8/6) — so it tracks the rally ramp but sharp
// edge-angled returns still beat it at every speed.
export const AI_SPEED_FRAC = 0.8;

// ---- input -------------------------------------------------------------------
// Must stay above RALLY_SPEED_MAX·sqrt(1 − MIN_VY_FRAC²) ≈ 12.6 — the ball's
// max lateral speed — or keyboard players can't track an edge return at cap.
export const KEY_SPEED = 14; // ArrowLeft/Right or A/D paddle speed (units/s)

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
export const SERVE_PULSE_SCALE = 0.05; // idle ball breathing amplitude while waiting
export const SERVE_PULSE_FREQ = 5; // breathing frequency (rad/s)

// ---- hit stop -------------------------------------------------------------------
// Whole-sim freeze on impact (rendering continues); ~3 frames on paddle
// contact, ~7 when a point lands, a longer beat on match end.
export const HIT_STOP_PADDLE = 0.045;
export const HIT_STOP_GOAL = 0.12;
export const HIT_STOP_WIN = 0.22;

// ---- trauma screen shake ----------------------------------------------------------
// Events add trauma (clamped to 1); shake amplitude = trauma², sampled from
// layered sines per axis, plus a roll around the view axis. Composes on top
// of the directional camera kick (NUDGE_*) and the drag-pan offset.
// Scale reference: the view is ~16.5 world units tall at the table, so a
// goal (0.85² × 1.0 ≈ 0.72 units) lands near the craft floor of ~5% of view.
export const TRAUMA_PADDLE = 0.3;
export const TRAUMA_WALL = 0.22;
export const TRAUMA_GOAL = 0.85;
export const TRAUMA_DECAY = 1.1; // linear decay, 1/s
export const SHAKE_MAX_OFFSET = 1.0; // world units at trauma 1
export const SHAKE_MAX_ROLL = 0.035; // rad at trauma 1
export const SHAKE_FREQ = 60; // base noise frequency (rad/s)

// ---- vfx ---------------------------------------------------------------------
export const TRAIL_RATE = 70; // trail ghosts per second during a rally
export const TRAIL_LIFE = 0.22; // ghost lifetime (s)
export const TRAIL_SIZE = BALL_R * 0.85; // ghost radius
export const INVERT_FLASH_S = 0.07; // full-screen ink/paper swap on a goal
export const SHADOW_ARC_GROW = 0.8; // shadow scale gain at full arc height

// Ink burst recipes (BurstOptions in fx/particles.ts minus position/direction,
// which are per-event at the call site).
export const BURST_WALL = {
  count: 5,
  spread: 1.2,
  speedMin: 1.5,
  speedMax: 4,
  zKick: 1.5,
  gravity: 9,
  life: 0.3,
  size: 0.05,
} as const;
export const BURST_PADDLE = {
  count: 9,
  spread: 1.3,
  speedMin: 2,
  speedMax: 6,
  zKick: 2.5,
  gravity: 9,
  life: 0.35,
  size: 0.06,
} as const;
export const BURST_GOAL = {
  count: 26,
  spread: Math.PI * 0.9,
  speedMin: 2,
  speedMax: 8,
  zKick: 3,
  gravity: 9,
  life: 0.5,
  size: 0.07,
} as const;

// Shockwave rings (RingOptions in fx/shock-rings.ts minus position).
export const RING_PADDLE = { from: 0.3, to: 1.3, life: 0.28, opacity: 0.5 } as const;
export const RING_GOAL = { from: 0.5, to: 3.2, life: 0.4, opacity: 0.85 } as const;

// ---- dither post pass -----------------------------------------------------------
export const DITHER_PIXEL = 2; // css px per rendered game pixel
