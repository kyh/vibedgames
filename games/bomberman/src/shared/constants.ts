export const TILE = 40;
export const GRID_COLS = 15;
export const GRID_ROWS = 13;

export const FUSE_MS = 2500;
export const EXPLOSION_MS = 500;
export const BOMB_RANGE = 2;
export const MOVE_MS = 180;

export type Cell =
  | { kind: "empty" }
  | { kind: "wall" }
  | { kind: "crate" };

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

export type PlayerState = {
  col: number;
  row: number;
  alive: boolean;
  color: number;
};

export type SharedState = {
  grid: Cell[][];
  bombs: Record<string, Bomb>;
  blasts: Record<string, Blast>;
  deaths?: Record<string, number>;
  winner: string | null;
  startedAt: number;
};

export const COLORS = [0xff5d5d, 0x5d9bff, 0x5dff8b, 0xffd95d, 0xc15dff, 0x5dffe0];

export function newGrid(): Cell[][] {
  const grid: Cell[][] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < GRID_COLS; c++) {
      const edge = r === 0 || c === 0 || r === GRID_ROWS - 1 || c === GRID_COLS - 1;
      const pillar = r % 2 === 0 && c % 2 === 0;
      if (edge || pillar) row.push({ kind: "wall" });
      else row.push({ kind: "empty" });
    }
    grid.push(row);
  }
  // Sprinkle crates, avoiding the four corner safe zones (2x2 each).
  const safe = (c: number, r: number) =>
    (c <= 2 && r <= 2) ||
    (c >= GRID_COLS - 3 && r <= 2) ||
    (c <= 2 && r >= GRID_ROWS - 3) ||
    (c >= GRID_COLS - 3 && r >= GRID_ROWS - 3);

  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      if (grid[r]![c]!.kind !== "empty") continue;
      if (safe(c, r)) continue;
      if (Math.random() < 0.7) grid[r]![c] = { kind: "crate" };
    }
  }
  return grid;
}

export const SPAWN_POINTS: Array<{ col: number; row: number }> = [
  { col: 1, row: 1 },
  { col: GRID_COLS - 2, row: GRID_ROWS - 2 },
  { col: GRID_COLS - 2, row: 1 },
  { col: 1, row: GRID_ROWS - 2 },
];
