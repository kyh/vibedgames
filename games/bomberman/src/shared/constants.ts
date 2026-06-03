// ---- board geometry ---------------------------------------------------------

export const TILE = 64;
export const GRID_COLS = 19;
export const GRID_ROWS = 15;

export const WORLD_W = GRID_COLS * TILE;
export const WORLD_H = GRID_ROWS * TILE;

// ---- timing -----------------------------------------------------------------

export const FUSE_MS = 2200;
export const EXPLOSION_MS = 480;

// ---- player stats (host-authoritative; powerups raise these) ----------------

export const BASE_BOMBS = 1;
export const BASE_RANGE = 2;
export const BASE_MOVE_MS = 175;

export const MAX_BOMBS = 8;
export const MAX_RANGE = 8;
export const MIN_MOVE_MS = 85;
export const SPEED_STEP_MS = 22;

/** Chance a destroyed crate drops a powerup. */
export const POWERUP_DROP_CHANCE = 0.34;

// ---- types ------------------------------------------------------------------

export type Cell = { kind: "empty" } | { kind: "wall" } | { kind: "crate" };

export type Dir = "up" | "down" | "left" | "right";

export type PowerupKind = "bomb" | "fire" | "speed";

export type Powerup = { col: number; row: number; kind: PowerupKind };

export type PlayerStats = { bombs: number; range: number; speed: number };

export type Bomb = {
  id: string;
  ownerId: string;
  col: number;
  row: number;
  placedAt: number;
  range: number;
};

export type Blast = {
  id: string;
  tiles: Array<{ col: number; row: number }>;
  placedAt: number;
};

/**
 * Per-player networked state. `dir`/`moving` let remote clients pick the
 * right walk animation; `col`/`row` are the authoritative grid position.
 */
export type PlayerState = {
  col: number;
  row: number;
  colorIdx: number;
  dir: Dir;
  moving: boolean;
};

/**
 * The single shared world. The multiplayer client shallow-merges patches
 * (`{...prev, ...patch}`), so the host always rewrites each nested object
 * wholesale — every field that can reset MUST be present in `emptyShared()`.
 */
export type SharedState = {
  grid: Cell[][];
  bombs: Record<string, Bomb>;
  blasts: Record<string, Blast>;
  powerups: Record<string, Powerup>;
  stats: Record<string, PlayerStats>;
  deaths: Record<string, number>;
  winner: string | null;
  startedAt: number;
};

// Player identity colors (ring + label tint), distinct and readable on dark.
export const COLORS = [0xff5d5d, 0x5d9bff, 0x5dff8b, 0xffd95d, 0xc15dff, 0x5dffe0];

export function baseStats(): PlayerStats {
  return { bombs: BASE_BOMBS, range: BASE_RANGE, speed: BASE_MOVE_MS };
}

export function tileKey(col: number, row: number): string {
  return `${col},${row}`;
}

export const SPAWN_POINTS: Array<{ col: number; row: number }> = [
  { col: 1, row: 1 },
  { col: GRID_COLS - 2, row: GRID_ROWS - 2 },
  { col: GRID_COLS - 2, row: 1 },
  { col: 1, row: GRID_ROWS - 2 },
];

/** True for the 2x2 corner pockets kept crate-free so players can break out. */
function isSafeCorner(c: number, r: number): boolean {
  return (
    (c <= 2 && r <= 2) ||
    (c >= GRID_COLS - 3 && r <= 2) ||
    (c <= 2 && r >= GRID_ROWS - 3) ||
    (c >= GRID_COLS - 3 && r >= GRID_ROWS - 3)
  );
}

export function newGrid(): Cell[][] {
  const grid: Cell[][] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < GRID_COLS; c++) {
      const edge = r === 0 || c === 0 || r === GRID_ROWS - 1 || c === GRID_COLS - 1;
      const pillar = r % 2 === 0 && c % 2 === 0;
      row.push(edge || pillar ? { kind: "wall" } : { kind: "empty" });
    }
    grid.push(row);
  }
  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      if (grid[r]![c]!.kind !== "empty") continue;
      if (isSafeCorner(c, r)) continue;
      if (Math.random() < 0.72) grid[r]![c] = { kind: "crate" };
    }
  }
  return grid;
}
