// ---- board geometry ---------------------------------------------------------

export const COLS = 10;
export const ROWS = 20;
/** Logical block size in px; the whole playfield container scales to fit. */
export const BLOCK = 32;

export const BOARD_W = COLS * BLOCK;
export const BOARD_H = ROWS * BLOCK;

/** Side HUD panel (next-piece preview), in logical px right of the board. */
export const PANEL_W = BLOCK * 4.5;
export const PANEL_GAP = BLOCK * 0.75;
export const PANEL_H = BLOCK * 5.5;
export const PREVIEW_SCALE = 0.85;
export const GHOST_ALPHA = 0.16;

// ---- timing -----------------------------------------------------------------

/** Base gravity: one row per this many ms at level 0. */
export const GRAVITY_MS = 500;
/** Gravity multiplier per level (~10% faster every LINES_PER_LEVEL lines). */
export const LEVEL_SPEEDUP = 0.9;
export const LINES_PER_LEVEL = 10;
export const MIN_GRAVITY_MS = 50;

/** Held soft-drop cadence (one row per). */
export const SOFT_DROP_MS = 50;
/** Sideways auto-repeat: initial delay, then repeat rate (DAS/ARR). */
export const DAS_MS = 170;
export const ARR_MS = 50;

/** Line-clear flash + collapse animation; gravity pauses while it runs. */
export const CLEAR_MS = 180;

// ---- scoring ----------------------------------------------------------------

/** Index = rows cleared at once; multiplied by (level + 1). */
export const LINE_SCORES = [0, 100, 300, 500, 800] as const;
export const SOFT_DROP_POINTS = 1; // per cell
export const HARD_DROP_POINTS = 2; // per cell
export const BEST_KEY = "tetris-best";

// ---- pieces -----------------------------------------------------------------

export type Matrix = number[][];

export type PieceDef = { name: string; color: number; matrix: Matrix };

/**
 * Order matters: keys 1-7 select by index (1=I … 7=J). Matrices are the
 * legacy game's (L/J orientations differ from SRS — intentional carry-over).
 */
export const PIECES: PieceDef[] = [
  { name: "I", color: 0x00e5ff, matrix: [[1, 1, 1, 1]] },
  {
    name: "O",
    color: 0xffd500,
    matrix: [
      [1, 1],
      [1, 1],
    ],
  },
  {
    name: "T",
    color: 0xb15dff,
    matrix: [
      [0, 1, 0],
      [1, 1, 1],
    ],
  },
  {
    name: "S",
    color: 0x32d74b,
    matrix: [
      [1, 1, 0],
      [0, 1, 1],
    ],
  },
  {
    name: "Z",
    color: 0xff453a,
    matrix: [
      [0, 1, 1],
      [1, 1, 0],
    ],
  },
  {
    name: "L",
    color: 0xff9f0a,
    matrix: [
      [1, 1, 1],
      [1, 0, 0],
    ],
  },
  {
    name: "J",
    color: 0x4d7cff,
    matrix: [
      [1, 1, 1],
      [0, 0, 1],
    ],
  },
];

export const SPAWN_X = Math.floor(COLS / 2) - 1;

// ---- pure board helpers -----------------------------------------------------

/** Cell values: 0 = empty, 1-7 = locked piece (PIECES index + 1, keeps color). */
export type Grid = number[][];

export function newGrid(): Grid {
  return Array.from({ length: ROWS }, () => new Array<number>(COLS).fill(0));
}

/** Clockwise rotation = transpose + reverse rows (legacy-faithful). */
export function rotateCW(m: Matrix): Matrix {
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  const out: Matrix = [];
  for (let c = 0; c < cols; c++) {
    const row: number[] = [];
    for (let r = rows - 1; r >= 0; r--) row.push(m[r]![c]!);
    out.push(row);
  }
  return out;
}

export function collides(grid: Grid, m: Matrix, x: number, y: number): boolean {
  for (let r = 0; r < m.length; r++) {
    const mrow = m[r]!;
    for (let c = 0; c < mrow.length; c++) {
      if (!mrow[c]) continue;
      const gx = x + c;
      const gy = y + r;
      if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
      if (gy >= 0 && grid[gy]![gx]! !== 0) return true;
    }
  }
  return false;
}

/** Fisher-Yates-shuffled 7-bag; pop() until empty, then deal a new bag. */
export function newBag(): number[] {
  const bag = [0, 1, 2, 3, 4, 5, 6];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = bag[i]!;
    bag[i] = bag[j]!;
    bag[j] = a;
  }
  return bag;
}
