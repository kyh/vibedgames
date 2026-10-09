import type { PlayerLimit } from "@vibedgames/multiplayer";
import type { Arena } from "./arena";
import type { ClockStamp } from "../util/clock";

// ---- board geometry ---------------------------------------------------------

export const TILE = 64;
export const GRID_COLS = 19;
export const GRID_ROWS = 15;

export const WORLD_W = GRID_COLS * TILE;
export const WORLD_H = GRID_ROWS * TILE;

// ---- timing -----------------------------------------------------------------

export const FUSE_MS = 2200;
export const EXPLOSION_MS = 480;
/** The host simulation's fixed step, on the sim clock. */
export const HOST_STEP_MS = 50;

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

// ---- bots -------------------------------------------------------------------

/** Fill empty spawn corners with bots up to this many total fighters. */
export const TARGET_FIGHTERS = 4;
/** Hard cap on bots regardless of human count (there are only 4 corners). */
export const MAX_BOTS = 3;
/** Bot step cadence (ms). A touch slower than a fresh human for fairness. */
export const BOT_MOVE_MS = 200;
/** When a bot is safe and next to a crate or has an enemy in line, odds it bombs. */
export const BOT_BOMB_CHANCE = 0.3;

// ---- types ------------------------------------------------------------------

export type Cell = { kind: "empty" } | { kind: "wall" } | { kind: "crate" };

export type Dir = "up" | "down" | "left" | "right";

export const DIRS: readonly Dir[] = ["up", "down", "left", "right"];

export const DIR_VECT = {
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
} satisfies Record<Dir, [number, number]>;

export type PowerupKind = "bomb" | "fire" | "speed";

export type Powerup = {
  col: number;
  row: number;
  kind: PowerupKind;
};

export type PlayerStats = {
  bombs: number;
  range: number;
  speed: number;
};

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
  tiles: { col: number; row: number }[];
  placedAt: number;
};

/**
 * Per-player networked state, written once per grid step. `col`/`row` are the
 * authoritative grid position. `t` is when the step onto it began on the
 * room's server clock and `s` how long it takes (0 for a spawn, which
 * receivers place without walking); receivers derive the walk cycle and
 * facing from the steps themselves. `h` is the server time, stamped
 * PLAYER_BEAT_HZ times a second while the body is on the board: receivers
 * learn this player's route from it, and that a body at rest still stands.
 */
export interface PlayerState {
  col: number;
  row: number;
  colorIdx: number;
  t: number;
  s: number;
  h: number;
}

/** The heartbeat's rate: the SDK's 100 ms least delay covers a 20 Hz sender. */
export const PLAYER_BEAT_HZ = 20;

/**
 * A host-controlled CPU fighter. Lives in shared state (not a real
 * connection), so every client renders it identically and a promoted host
 * keeps driving it. `nextMoveAt` is a sim-clock timestamp gating its cadence.
 */
export type Bot = {
  id: string;
  col: number;
  row: number;
  dir: Dir;
  colorIdx: number;
  moving: boolean;
  nextMoveAt: number;
};

/**
 * The single shared world. A write replaces each top-level field it names,
 * and only the leaves that changed travel (an opened crate is one cell of
 * `grid`), so every field that can reset MUST be present in `emptyShared()`.
 */
export type SharedState = {
  /** Missing only in legacy rooms; read through readArena at the boundary. */
  arena?: Arena;
  /** The sim clock (see util/clock): on every host write, on the wire only when it changed. */
  clock?: ClockStamp;
  grid: Cell[][];
  bombs: Record<string, Bomb>;
  blasts: Record<string, Blast>;
  powerups: Record<string, Powerup>;
  bots: Record<string, Bot>;
  stats: Record<string, PlayerStats>;
  deaths: Record<string, number>;
  winner: string | null;
  startedAt: number;
};

// Player identity colors (ring + label tint), distinct and readable on dark.
export const COLORS = [0xff_5d_5d, 0x5d_9b_ff, 0x5d_ff_8b, 0xff_d9_5d, 0xc1_5d_ff, 0x5d_ff_e0];

/**
 * Bounds the party server holds every player-state patch to: a tile on the
 * board, a colour in the palette, a stride no slower than the base (0 is a
 * spawn). A patch outside them is dropped before anyone sees it. Room rules
 * come from the first client in, so every client ships these same ones.
 */
export const PLAYER_LIMITS = {
  col: { max: GRID_COLS - 1, min: 0 },
  colorIdx: { max: COLORS.length - 1, min: 0 },
  row: { max: GRID_ROWS - 1, min: 0 },
  s: { max: BASE_MOVE_MS, min: 0 },
} satisfies Partial<Record<keyof PlayerState, PlayerLimit>>;

export const baseStats = (): PlayerStats => ({
  bombs: BASE_BOMBS,
  range: BASE_RANGE,
  speed: BASE_MOVE_MS,
});

export const tileKey = (col: number, row: number): string => `${col},${row}`;

interface Spawn {
  col: number;
  row: number;
}

export const SPAWN_POINTS: readonly [Spawn, Spawn, Spawn, Spawn] = [
  { col: 1, row: 1 },
  { col: GRID_COLS - 2, row: GRID_ROWS - 2 },
  { col: GRID_COLS - 2, row: 1 },
  { col: 1, row: GRID_ROWS - 2 },
];

/** True for the 2x2 corner pockets kept crate-free so players can break out. */
const isSafeCorner = (c: number, r: number): boolean =>
  (c <= 2 && r <= 2) ||
  (c >= GRID_COLS - 3 && r <= 2) ||
  (c <= 2 && r >= GRID_ROWS - 3) ||
  (c >= GRID_COLS - 3 && r >= GRID_ROWS - 3);

export const newGrid = (random: () => number = Math.random): Cell[][] => {
  const grid: Cell[][] = [];
  for (let r = 0; r < GRID_ROWS; r += 1) {
    const row: Cell[] = [];
    for (let c = 0; c < GRID_COLS; c += 1) {
      const edge = r === 0 || c === 0 || r === GRID_ROWS - 1 || c === GRID_COLS - 1;
      const pillar = r % 2 === 0 && c % 2 === 0;
      row.push(edge || pillar ? { kind: "wall" } : { kind: "empty" });
    }
    grid.push(row);
  }
  for (const [r, row] of grid.entries()) {
    for (const [c, cell] of row.entries()) {
      if (cell.kind !== "empty") {
        continue;
      }
      if (isSafeCorner(c, r)) {
        continue;
      }
      if (random() < 0.72) {
        row[c] = { kind: "crate" };
      }
    }
  }
  return grid;
};

/** How long to wait for the party server before starting a solo match. */
export const OFFLINE_FALLBACK_MS = 4000;
