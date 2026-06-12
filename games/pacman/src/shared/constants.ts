// All tunables for the 3D first-person Pac-Man. One maze cell = 1 world unit;
// world x = grid column, world z = grid row; speeds are cells per second.
// Maze layout, movement rules, camera math and gesture thresholds are
// recovered verbatim from the legacy React/r3f build (git:
// games/pacman/src/app/app.tsx + face-detection.tsx). The look is a soft
// "plush clinic" restyle: cream fog, marshmallow walls, Baymax-faced ghosts.

// ---- maze -------------------------------------------------------------------

/**
 * Maze layout — 25×31 braided maze (every corridor loops, no dead ends),
 * left-right symmetric, generated + validated for full connectivity.
 * 0 = open corridor (den + doorway, no pellet), 1 = wall, 2 = pellet,
 * 3 = power pellet. Border is solid wall — NO tunnel wraparound.
 * Ghost den: rows 11–13 × cols 13–17, doorway up at col 15 and down at
 * (15, 14).
 */
export const MAP: ReadonlyArray<ReadonlyArray<number>> = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 3, 1, 2, 1, 1, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 1, 1, 2, 1, 3, 1],
  [1, 2, 1, 2, 2, 2, 2, 2, 1, 2, 1, 2, 2, 2, 1, 2, 1, 2, 2, 2, 1, 2, 1, 2, 2, 2, 2, 2, 1, 2, 1],
  [1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1],
  [1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1],
  [1, 1, 1, 2, 1, 2, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 2, 1, 2, 1, 1, 1],
  [1, 2, 2, 2, 1, 2, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2, 1, 2, 1, 2, 2, 2, 1],
  [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
  [1, 2, 2, 2, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2, 2, 0, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2, 1, 2, 2, 2, 1],
  [1, 2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 0, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 1, 1, 2, 1],
  [1, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 2, 1, 0, 0, 0, 0, 0, 1, 2, 2, 2, 1, 2, 2, 2, 2, 2, 1, 2, 1],
  [1, 3, 1, 2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 0, 0, 0, 0, 0, 1, 2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 3, 1],
  [1, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 1, 0, 0, 0, 0, 0, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 1],
  [1, 2, 1, 2, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 2, 1, 2, 1],
  [1, 2, 2, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 2, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1],
  [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
  [1, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 1],
  [1, 2, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 2, 1],
  [1, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 1],
  [1, 3, 1, 1, 1, 1, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1, 1, 3, 1],
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

export const GRID_ROWS = MAP.length;
export const GRID_COLS = MAP[0]?.length ?? 0;

/**
 * Floor plane height. The legacy build offset the floor half a cell below the
 * actor plane (actors stand at y=0 with the plane at -0.5) — kept verbatim,
 * and now shared so ground-hugging FX land on the visible floor.
 */
export const FLOOR_Y = -0.5;

// ---- speeds (cells per second) ------------------------------------------------

/** Step animation speed — legacy `animationSpeed` ref. */
export const PACMAN_STEP_SPEED = 5;
export const GHOST_SPEED = 1.5;
export const GHOST_SCARED_SPEED = 0.75;
/** Legacy clamped frame delta to 0.1s to prevent jumps on frame drops. */
export const MAX_DT = 0.1;

// ---- rules --------------------------------------------------------------------

export const SCORE_PELLET = 10;
export const SCORE_POWER = 50;
export const SCORE_GHOST = 200;
export const SCARED_MS = 10_000; // legacy POWER_PELLET_DURATION
/** Last stretch of power mode: ghosts blink + a soft warning note plays. */
export const SCARED_WARN_MS = 2_000;
export const SCARED_BLINK_INTERVAL_MS = 250;
/** Odds a ghost greedily chases at a grid center (else pure random). */
export const CHASE_CHANCE = 0.7;
/** Rebuild addition kept: lives + game over (legacy had a soft reset only). */
export const START_LIVES = 3;
export const READY_MS = 900;
/** After a respawn, ghost contact can't kill for this long (anti spawn-camp). */
export const SPAWN_GRACE_MS = 1_000;

export const PACMAN_SPAWN = { col: 1, row: 1 } as const;
/** Six ghosts for the bigger maze, spread across the center den. */
export const GHOST_SPAWNS: ReadonlyArray<{ col: number; row: number; dir: Dir }> = [
  { col: 13, row: 12, dir: "up" },
  { col: 14, row: 12, dir: "left" },
  { col: 15, row: 12, dir: "up" },
  { col: 16, row: 12, dir: "right" },
  { col: 17, row: 12, dir: "up" },
  { col: 15, row: 11, dir: "up" },
];
export const GHOST_RESPAWN = { col: 15, row: 12 } as const;

/**
 * Radial hitboxes (2D plane distance, world units). Contact runs every frame
 * — standing still is NOT safe. Catch is forgiving (smaller than the visual
 * overlap, in the player's favor); eating scared ghosts is generous.
 */
export const CATCH_DIST = 0.55;
export const EAT_DIST = 0.8;

// ---- chase camera (legacy PacmanCamera) -----------------------------------------

export const CAMERA_SMOOTHING = 0.1; // lerp factor per frame
export const CAM_BACK = 2.5; // camera sits at pos - facing*2.5 (selfie: +2.5)
export const CAM_HEIGHT = 2; // absolute camera y
export const CAM_LOOK_AHEAD = 2; // lookAt = pos + facing*2
export const CAM_SELFIE_LOOK_BACK = 1; // selfie lookAt = pos - facing*1

// ---- pacman model ---------------------------------------------------------------

export const PAC_RADIUS = 0.5;
export const MOUTH_RADIUS = 0.51;
export const MOUTH_PHI_START = (Math.PI * 7) / 4;
export const MOUTH_PHI_LENGTH = Math.PI / 2;
/** Mouth wedge target opening (rad) while moving; lerped at delta*10/frame. */
export const MOUTH_OPEN_ANGLE = Math.PI / 4;
export const MOUTH_LERP_RATE = 10;
/**
 * Mouth angles quantize to this bucket size (rad) so wedge geometries can be
 * built once and cached (~16 total) instead of rebuilt every frame while
 * chomping. ~2.9° steps — invisible at this size.
 */
export const MOUTH_ANGLE_QUANT = 0.05;

// ---- ghosts ---------------------------------------------------------------------

/**
 * Bob: y = sin(t * FREQ + phase) * AMP + BASE; phase staggered per ghost.
 * BASE keeps the marshmallows hovering just off the floor, eye-level with
 * Pacman — they used to float half a cell above him.
 */
export const GHOST_BOB_FREQ = 0.003;
export const GHOST_BOB_AMP = 0.08;
export const GHOST_BOB_BASE = 0.12;
/** Bob phase offset between neighboring ghosts (rad) so they don't move in lockstep. */
export const GHOST_BOB_STAGGER = 1.7;
/** Yaw lerp rate (per second factor) for the face turning toward travel dir. */
export const GHOST_YAW_RATE = 10;
/** Scared: shrink to this scale + tremble at this amplitude (world units). */
export const GHOST_SCARED_SCALE = 0.92;
export const GHOST_TREMBLE_AMP = 0.03;
export const GHOST_TREMBLE_FREQ = 34;

// ---- pellets ----------------------------------------------------------------------

export const PELLET_RADIUS = 0.11;
export const POWER_PELLET_RADIUS = 0.3;
/** Rest height of the floating power hearts (bob centers here). */
export const HEART_Y = 0.3;
/** Idle pellet bob: y = sin(t·FREQ + cellPhase)·AMP. */
export const PELLET_BOB_AMP = 0.035;
export const PELLET_BOB_FREQ = 2.2;
/** Power-heart breathing pulse: scale 1 ± AMP. */
export const HEART_PULSE_AMP = 0.12;
export const HEART_PULSE_FREQ = 3.4;

// ---- palette (plush clinic: cream, butter, blush, pastel mints) -------------------

export const COLORS = {
  pacman: 0xffd66b,
  /** Warm near-black — pure #000 is too harsh for the soft look. */
  mouth: 0x453941,
  /**
   * Deep dusk periwinkle — deliberately OUTSIDE the pastel ghost palette so
   * "scared" reads at chase-cam distance (a pale tint was indistinguishable
   * from the periwinkle ghost's base coat).
   */
  scared: 0x8c98d9,
  /** Scared blink partner color for the wearing-off warning. */
  scaredBlink: 0xf8f9ff,
  power: 0xff8fab,
  /** Butter pearls — cream-on-cream vanishes against the floor. */
  pellet: 0xffdf94,
  pelletGlow: 0xffb054,
  heartGlow: 0xff5c8a,
  wall: 0xf6cdd9,
  floor: 0xfdf4ea,
  floorDot: 0xf4e2d8,
  eye: 0x2e2a33,
  blush: 0xff9eb5,
  /** Page background + fog — everything melts into warm cream. */
  bg: 0xfdf1e6,
} as const;
export const GHOST_COLORS: ReadonlyArray<number> = [0xffb3c1, 0xffd6a5, 0xb8e8c8, 0xb5c7f7];
/** Deterministic per-wall lightness wobble so the candy blocks aren't flat. */
export const WALL_TINT_WOBBLE = 0.04;
/**
 * Gummy translucency — the chase camera sits low (CAM_HEIGHT 2), so fully
 * opaque walls hide the corridors; this is readability, not just style.
 */
export const WALL_OPACITY = 0.85;

// ---- lighting (hemisphere sky + warm key with soft shadows, ACES) ------------------

export const HEMI_SKY = 0xfff6ec;
export const HEMI_GROUND = 0xf3dce2;
export const HEMI_INTENSITY = 0.85;
export const KEY_COLOR = 0xfff2e0;
export const KEY_INTENSITY = 1.6;
export const TONE_EXPOSURE = 1.1;
/** Fog near/far in world units. */
export const FOG_NEAR = 10;
export const FOG_FAR = 36;

// ---- feel / vfx -----------------------------------------------------------------

/** Land squash: y scale dips to 1-SQUASH, x/z bulge, recovers at RATE/s ease-out. */
export const STEP_SQUASH = 0.16;
export const STEP_STRETCH = 0.12;
export const SQUASH_RECOVER_RATE = 9;
/** Trauma added per event (Eiserloh: shake = trauma²). */
export const TRAUMA_CAUGHT = 0.5;
export const TRAUMA_GHOST_EATEN = 0.25;
export const TRAUMA_POWER = 0.18;
/** FOV kick (deg) on power pickup, exponential decay per second. */
export const FOV_KICK_POWER = 6;
export const FOV_KICK_DECAY = 4;
export const BASE_FOV = 75;
/** Title screen: slow orbit around the maze center, scaled to the maze. */
export const TITLE_ORBIT_RADIUS = Math.max(GRID_COLS, GRID_ROWS) * 0.72;
export const TITLE_ORBIT_HEIGHT = Math.max(GRID_COLS, GRID_ROWS) * 0.42;
export const TITLE_ORBIT_SPEED = 0.12;

// ---- face gestures (legacy face-detection.tsx) -----------------------------------

/** |upperLip.y - lowerLip.y| / |nose.y - chin.y| above this = mouth open. */
export const MOUTH_OPEN_RATIO = 0.07;
/** Cheek asymmetry ratio beyond ±this = head turned left/right; else center. */
export const HEAD_TURN_THRESHOLD = 0.3;
export const HEAD_DEBOUNCE_MS = 1000;

// ---- persistence --------------------------------------------------------------

export const BEST_KEY = "pacman-best";

// ---- directions ---------------------------------------------------------------

export type Dir = "up" | "down" | "left" | "right";
export const DIRS: ReadonlyArray<Dir> = ["up", "down", "left", "right"];
/** [dCol, dRow] = [dWorldX, dWorldZ]; up = -z, matching legacy Vector3(0,0,-1). */
export const DIR_VECT: Record<Dir, readonly [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};
export const OPPOSITE: Record<Dir, Dir> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};
/** Relative 90° turns (legacy ArrowLeft/ArrowRight semantics). */
export const TURN_LEFT: Record<Dir, Dir> = {
  up: "left",
  left: "down",
  down: "right",
  right: "up",
};
export const TURN_RIGHT: Record<Dir, Dir> = {
  up: "right",
  right: "down",
  down: "left",
  left: "up",
};

// ---- grid helpers -------------------------------------------------------------

/** Walkable check. Out-of-bounds is a wall — no wraparound (legacy isValidMove). */
export function isOpen(col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= GRID_COLS || row >= GRID_ROWS) return false;
  return (MAP[row]?.[col] ?? 1) !== 1;
}

export function cellKey(col: number, row: number): string {
  return `${col},${row}`;
}
