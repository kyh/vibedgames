export const COURT_W = 10;
export const COURT_D = 20;
export const WALL_X = 4.9;
export const GOAL_Y = COURT_D / 2;
export const NET_DASH = { count: 11, h: 0.16, w: 0.34 } as const;

export const PADDLE_Y = 8;
export const PADDLE_X_MAX = 4.5;
export const PADDLE_RING_R = 0.5;
export const PADDLE_TUBE_R = 0.1;
export const PADDLE_Z = 0.5;
export const HIT_HALF_Y = 0.5;
export const HIT_HALF_X = 0.7;

export const BALL_R = 0.2;
export const RALLY_SPEED_BASE = 7;
export const RALLY_SPEED_STEP = 0.45;
export const RALLY_SPEED_MAX = 13;
export const MIN_VY_FRAC = 0.25;
export const SERVE_SPREAD = 0.1;
export const AUTO_SERVE_S = 1.1;

export const ARC_PEAK = 2;
export const ARC_LAND_MIN = 4;
export const ARC_LAND_MAX = 7;

export const AI_SPEED_FRAC = 0.8;

export const HAND_RANGE = 9;
export const HAND_LERP_BASE = 0.2;
export const HAND_LERP_ACCEL = 10;
export const HAND_TIMEOUT_MS = 500;

export const PAD_DEAD_ZONE = 0.15;
export const PAD_LERP = 0.5;

export const DRAG_PAN_SCALE = 0.02;

/** Mouse-up within this distance of mouse-down counts as a click (serve), not a pan. */
export const CLICK_DRAG_TOLERANCE_PX = 5;
export const CAM_RETURN_LERP = 0.1;
export const CAM_START_OFFSET_Y = 1;
export const LEGACY_FPS = 60;

export const WIN_SCORE = 7;

export type Phase = "serving" | "rally" | "won";

export const TICK_RATE = 60;
export const TICK_S = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

export const MP_ROOM = "pong-v3";
export const MP_MAX_PLAYERS = 2;
export const OFFLINE_FALLBACK_MS = 4000;
export const BALL_SNAP = 3;
export const BALL_EASE_S = 0.08;

export const COMBO_MIN = 2;
export const COMBO_PEAK_HITS = 14;

export const CAM_FOV = 44;
export const CAM_MIN_LANDSCAPE_ASPECT = 1.3;
export const CAM_POS = { x: 0, y: -15, z: 9 } as const;
export const CAM_STRAFE_X = 2;
export const CAM_AIM_Y = -3;
export const CAM_DIP_MAX = 2;
export const CAM_DIP_RATE = 10;
export const CAM_PARALLAX_OMEGA = 8;
export const CAM_BREATH_X = 0.06;
export const CAM_BREATH_Y = 0.05;
export const CAM_BREATH_Z = 0.04;
export const CAM_BREATH_FREQ_X = 0.31;
export const CAM_BREATH_FREQ_Y = 0.23;
export const CAM_BREATH_FREQ_Z = 0.17;
export const CAM_BREATH_ROLL = 0.004;

export const INK = 0x00_00_00;
export const BG = 0xd4_d4_d4;
export const SHADOW_MAX_OPACITY = 0.3;

export const BACKDROP_WALL = {
  bottom: 0xbc_bc_bc,
  pos: { x: 0, y: 26, z: 9 },
  size: { h: 34, w: 60 },
  tilt: -Math.PI * 0.32,
  top: 0xd4_d4_d4,
} as const;

export const VIGNETTE_STRENGTH = 0.1;
export const VIGNETTE_INNER = 0.6;

export const MAX_FRAME_DT = 0.25;
export const PULSE_SCALE = 0.35;
export const PULSE_DECAY = 9;
export const SQUASH = 0.3;
export const SQUASH_RECOVER = 10;
export const NUDGE_SCALE = 0.035;
export const NUDGE_DECAY = 7;
export const GOAL_FLASH_DECAY = 4;
export const SERVE_PULSE_SCALE = 0.05;
export const SERVE_PULSE_FREQ = 5;

export const HIT_STOP_PADDLE = 0.045;
export const HIT_STOP_GOAL = 0.12;
export const HIT_STOP_WIN = 0.22;

export const TRAUMA_PADDLE = 0.3;
export const TRAUMA_WALL = 0.22;
export const TRAUMA_GOAL = 0.85;
export const TRAUMA_DECAY = 1.1;
export const SHAKE_MAX_OFFSET = 1;
export const SHAKE_MAX_ROLL = 0.035;
export const SHAKE_FREQ = 60;

export const TRAIL_RATE = 70;
export const TRAIL_LIFE = 0.22;
export const TRAIL_SIZE = BALL_R * 0.85;
export const INVERT_FLASH_S = 0.07;
export const SHADOW_ARC_GROW = 0.8;
export const STREAK_SIZE_GAIN = 0.7;
export const STREAK_LIFE_GAIN = 0.6;

export const BURST_WALL = {
  count: 5,
  gravity: 9,
  life: 0.3,
  size: 0.05,
  speedMax: 4,
  speedMin: 1.5,
  spread: 1.2,
  zKick: 1.5,
} as const;

export const BURST_PADDLE = {
  count: 9,
  gravity: 9,
  life: 0.35,
  size: 0.06,
  speedMax: 6,
  speedMin: 2,
  spread: 1.3,
  zKick: 2.5,
} as const;

export const BURST_GOAL = {
  count: 26,
  gravity: 9,
  life: 0.5,
  size: 0.07,
  speedMax: 8,
  speedMin: 2,
  spread: Math.PI * 0.9,
  zKick: 3,
} as const;

export const CONFETTI_Z = 6;

export const BURST_CONFETTI = {
  count: 44,
  gravity: 9,
  life: 0.9,
  size: 0.07,
  speedMax: 5,
  speedMin: 1,
  zKick: 2,
} as const;

export const RING_PADDLE = { from: 0.3, life: 0.28, opacity: 0.5, to: 1.3 } as const;
export const RING_GOAL = { from: 0.5, life: 0.4, opacity: 0.85, to: 3.2 } as const;

export const DITHER_PIXEL = 2;
