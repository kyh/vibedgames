// All tunables for the 3D first-person Pac-Man. One maze cell = 1 world unit;
// world x = grid column, world z = grid row; speeds are cells per second.
// Geometry, palette, camera math and gesture thresholds are recovered verbatim
// from the legacy React/r3f build (git: games/pacman/src/app/app.tsx +
// face-detection.tsx).

// ---- maze -------------------------------------------------------------------

/**
 * Maze layout, copied verbatim from the legacy build.
 * 0 = open corridor, 1 = wall, 2 = pellet, 3 = power pellet.
 * Rows 7/9/11 reach the map edge, but out-of-bounds counts as WALL —
 * there is NO tunnel wraparound, exactly like the legacy build.
 */
export const MAP: ReadonlyArray<ReadonlyArray<number>> = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 3, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 1, 3, 1],
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 2, 1, 1, 2, 1, 2, 1, 1, 1, 1, 1, 2, 1, 2, 1, 1, 2, 1],
  [1, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 2, 1],
  [1, 1, 1, 1, 2, 1, 1, 1, 0, 1, 0, 1, 1, 1, 2, 1, 1, 1, 1],
  [0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0],
  [1, 1, 1, 1, 2, 1, 0, 1, 1, 0, 1, 1, 0, 1, 2, 1, 1, 1, 1],
  [0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0],
  [1, 1, 1, 1, 2, 1, 0, 1, 1, 1, 1, 1, 0, 1, 2, 1, 1, 1, 1],
  [0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0],
  [1, 1, 1, 1, 2, 1, 0, 1, 1, 1, 1, 1, 0, 1, 2, 1, 1, 1, 1],
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 2, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 1, 2, 1],
  [1, 3, 2, 1, 2, 2, 2, 2, 2, 0, 2, 2, 2, 2, 2, 1, 2, 3, 1],
  [1, 1, 2, 1, 2, 1, 2, 1, 1, 1, 1, 1, 2, 1, 2, 1, 2, 1, 1],
  [1, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 2, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

export const GRID_ROWS = MAP.length;
export const GRID_COLS = MAP[0]!.length;

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
/** Odds a ghost greedily chases at a grid center (else pure random). */
export const CHASE_CHANCE = 0.7;
/** Rebuild addition kept: lives + game over (legacy had a soft reset only). */
export const START_LIVES = 3;
export const READY_MS = 900;
/** After a respawn, ghost contact can't kill for this long (anti spawn-camp). */
export const SPAWN_GRACE_MS = 1_000;

export const PACMAN_SPAWN = { col: 1, row: 1 } as const;
export const GHOST_SPAWNS: ReadonlyArray<{ col: number; row: number; dir: Dir }> = [
  { col: 9, row: 9, dir: "up" },
  { col: 8, row: 9, dir: "left" },
  { col: 10, row: 9, dir: "right" },
  { col: 9, row: 8, dir: "up" },
];
export const GHOST_RESPAWN = { col: 9, row: 9 } as const;

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

// ---- ghosts ---------------------------------------------------------------------

export const GHOST_RADIUS = 0.5;
/** Bob: y = sin(Date.now() * FREQ) * AMP + BASE — same phase for all ghosts. */
export const GHOST_BOB_FREQ = 0.003;
export const GHOST_BOB_AMP = 0.1;
export const GHOST_BOB_BASE = 0.5;

// ---- pellets ----------------------------------------------------------------------

export const PELLET_RADIUS = 0.1;
export const POWER_PELLET_RADIUS = 0.3;
/** Rotation per frame (legacy rotated 0.01 rad each useFrame tick). */
export const PELLET_SPIN = 0.01;

// ---- palette ------------------------------------------------------------------

export const COLORS = {
  pacman: 0xfacc15,
  mouth: 0x000000,
  scared: 0x6b7280,
  power: 0xec4899,
  pellet: 0xfacc15,
  wall: 0x1d4ed8,
  floor: 0x111111,
  eye: 0xffffff,
  pupil: 0x000000,
  /** Legacy page background hsl(240 10% 3.9%). */
  bg: 0x09090b,
} as const;
export const GHOST_COLORS: ReadonlyArray<number> = [0xef4444, 0xf97316, 0x22c55e, 0x3b82f6];
export const WALL_OPACITY = 0.7;
/** Legacy ran the same three 0.184 (physical lights + ACES) with ambient 1.0. */
export const AMBIENT_INTENSITY = 1.0;

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
  return MAP[row]![col]! !== 1;
}

export function cellKey(col: number, row: number): string {
  return `${col},${row}`;
}
