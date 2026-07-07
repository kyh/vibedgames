// Single source of every tunable for 3D Tetris, grouped by concern. World
// units throughout (1 cell = 1 unit); time in seconds unless the name says
// _MS. Mirrors pong's constants-by-concern discipline so the feel pass has
// one place to turn knobs. Kept free of three.js imports so the game/ core
// stays renderer-agnostic and headless-testable — colours are plain hex.

// ---- well geometry ----------------------------------------------------------

/** The playfield is a square column you look down into: WIDTH×DEPTH floor,
 *  HEIGHT tall. Pieces are flat slabs that translate in X and Z. */
export const WELL_WIDTH = 8;
export const WELL_DEPTH = 8;
export const WELL_HEIGHT = 12;
/** Game over when a piece locks with its layer at/above this height. */
export const DEATH_HEIGHT = 9;

/** Floor-plane center in world space (cells are placed at integer coords). */
export const WELL_CENTER_X = WELL_WIDTH / 2 - 0.5;
export const WELL_CENTER_Z = WELL_DEPTH / 2 - 0.5;

// ---- timing -----------------------------------------------------------------

/** Gravity: the active slab steps down one layer per this interval. */
export const CYCLE_TIME_MS = 620;
/** Soft drop multiplies the clock rate by this (1/0.1 = 10× faster fall). */
export const SOFT_DROP_FACTOR = 0.1;
/** Each scoring event shaves the cycle time by this much (speed ramp)… */
export const ACCEL_MS = 12;
/** …clamped here so the clock can never reach 0 (reference NaN bug). */
export const MIN_CYCLE_TIME_MS = 95;
/** Frame dt is clamped so a tab-switch spike can't teleport the sim. */
export const MAX_DT = 0.05;

// ---- scoring ----------------------------------------------------------------

/** A cleared X-line is WELL_WIDTH cubes; a Z-line is WELL_DEPTH. Score adds
 *  the line length, then a combo bonus when both axes clear at once. */
export const DOUBLE_CLEAR_BONUS = 50;
export const HARD_DROP_POINTS = 2; // per cell fallen
export const SOFT_DROP_POINTS = 1; // per cell fallen

// ---- charge / power-sweep ---------------------------------------------------

/** The charge meter [0..1] fills by this per line cleared; full = one sweep. */
export const CHARGE_PER_LINE = 0.2;
/** Score per cube removed by a power-sweep. */
export const POWER_SCORE_PER_CUBE = 5;

// ---- pieces -----------------------------------------------------------------

export type Footprint = number[][];
export type PieceDef = { name: string; color: number; shape: Footprint };

/**
 * The 7 tetrominoes as flat XZ footprints (rows = Z, cols = X). Order is the
 * keyboard 1–7 / pose-selection order (I, O, T, S, Z, L, J), so a pose maps
 * straight to an index. Rotation is rotateCW in the XZ plane (see board.ts).
 */
export const PIECES: PieceDef[] = [
  { name: "I", color: 0x00e5ff, shape: [[1, 1, 1, 1]] },
  {
    name: "O",
    color: 0xffd500,
    shape: [
      [1, 1],
      [1, 1],
    ],
  },
  {
    name: "T",
    color: 0xb15dff,
    shape: [
      [0, 1, 0],
      [1, 1, 1],
    ],
  },
  {
    name: "S",
    color: 0x32d74b,
    shape: [
      [1, 1, 0],
      [0, 1, 1],
    ],
  },
  {
    name: "Z",
    color: 0xff453a,
    shape: [
      [0, 1, 1],
      [1, 1, 0],
    ],
  },
  {
    name: "L",
    color: 0xff9f0a,
    shape: [
      [1, 1, 1],
      [1, 0, 0],
    ],
  },
  {
    name: "J",
    color: 0x4d7cff,
    shape: [
      [1, 1, 1],
      [0, 0, 1],
    ],
  },
];

// ---- camera rig -------------------------------------------------------------

/** Perspective FOV — NOT the reference's 120 (that warps varied aspect ratios
 *  and worsens motion sickness); 58 frames the well cleanly. */
export const CAMERA_FOV = 58;
/** Horizontal distance of each corner eye from the well center. */
export const CAMERA_RADIUS = WELL_WIDTH * 2.05;
/** Eye height above the floor — a touch top-down so the back-bottom is visible. */
export const CAMERA_HEIGHT = WELL_HEIGHT * 1.25;
/** Per-frame lerp toward the active corner — a swing, never a cut. */
export const CAMERA_LERP_PER_FRAME = 0.085;
/** Gravity pauses while the camera swings to a new corner (a planning beat). */
export const ORBIT_PAUSE_MS = 420;
/** Idle "breathing" drift amplitude (world units), applied after lookAt. */
export const CAMERA_WOBBLE = 0.14;
/** Automatic peek-sway: the camera continuously orbit-drifts this far (radians)
 *  around the active corner so the back of the stack is always glimpsed —
 *  WITHOUT changing the logical corner or the camera-relative controls. */
export const PEEK_YAW_MAX = 0.32;
export const PEEK_PITCH_MAX = 0.06;
export const PEEK_OMEGA = 9; // spring stiffness easing toward the swaying target
/** Full back-and-forth period of the auto peek-sway. */
export const AUTO_PEEK_PERIOD_MS = 7000;

// ---- pose / webcam input ----------------------------------------------------

/** Camera orbit is triggered by circling one RAISED hand. The wrist must orbit
 *  its own recent centre by at least this many radians (≈ most of a loop) to
 *  step one corner; spin direction picks left/right. */
export const CIRCLE_TRIGGER_RAD = Math.PI * 1.7;
/** Min orbit radius (fraction of frame) so a near-still hand can't accumulate. */
export const CIRCLE_MIN_RADIUS = 0.04;
/** Per-frame lerp of the circle-centre estimate toward the wrist (an EMA that
 *  settles on the centre of the circling motion). */
export const CIRCLE_CENTER_LERP = 0.08;
export const ORBIT_COOLDOWN_MS = 900;
export const ROTATE_COOLDOWN_MS = 600;
/** Nose-x steer dead zone (fraction of width) so idle wobble can't drift. */
export const NOSE_DEAD_ZONE = 0.08;
/** Catch-the-collapse / start: both wrists thrust UP this fast (normalized/s). */
export const CATCH_WRIST_VELOCITY = 1.6;
export const CATCH_WINDOW_MS = 1300;
/** Keyboard reclaims steering if no pose frame arrives within this. */
export const POSE_TIMEOUT_MS = 600;
/** Cross your wrists past the opposite shoulders → HOLD/swap (edge-triggered). */
export const HOLD_COOLDOWN_MS = 700;
/** T-pose (both wrists out past the shoulders, at shoulder height) → power-sweep
 *  when the charge meter is full (edge-triggered). */
export const TPOSE_WRIST_OUT = 0.18; // wrist must be this far (frac of width) outside the shoulder
export const POWER_COOLDOWN_MS = 800;

// ---- keyboard (DAS/ARR for held steering) -----------------------------------

export const DAS_MS = 170; // delay before auto-repeat
export const ARR_MS = 60; // auto-repeat interval

// ---- look / palette ---------------------------------------------------------

/** Background + enclosure: dark, slightly desaturated navy (Tokyo-Night-ish). */
export const BG = 0x12131f;
export const ENCLOSURE = 0x1c2030;
/** Faint grid line on the floor/walls. */
export const GRID_LINE = 0x2c3350;
/** Landing-ghost wireframe tint. */
export const GHOST_COLOR = 0xaab4e8;

// ---- trauma shake (per event) ----------------------------------------------

export const TRAUMA_LOCK = 0.18;
export const TRAUMA_HARD_DROP = 0.32;
export const TRAUMA_CLEAR = 0.4;
export const TRAUMA_GAME_OVER = 0.7;

// ---- fx ---------------------------------------------------------------------

/** Lock dust + line-clear burst recipes (counts/speeds in world units/s). */
export const LOCK_DUST_COUNT = 10;
export const CLEAR_BURST_COUNT = 26;
