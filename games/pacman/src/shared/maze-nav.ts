// Path-aware maze reading for the playtest diagnostics. A decision model has
// no eyes: straight-line dx/dy points through walls, so targets are reported
// with the first step of a real shortest path and its length in cells.

import { DIRS, DIR_VECT, GRID_COLS, GRID_ROWS, isOpen } from "./constants";
import type { Dir } from "./constants";

export interface Cell {
  col: number;
  row: number;
}

export interface Flood {
  /** Steps from the nearest source, -1 where unreachable. */
  dist: Int16Array;
  /** Index into DIRS of the first step out of the source, -1 at the source. */
  first: Int8Array;
}

const CELLS = GRID_COLS * GRID_ROWS;

export const cellIndex = (col: number, row: number): number => row * GRID_COLS + col;

/** Breadth-first flood from one or more source cells over the walkable grid. */
export const flood = (sources: readonly Cell[]): Flood => {
  const dist = new Int16Array(CELLS).fill(-1);
  const first = new Int8Array(CELLS).fill(-1);
  const queue: number[] = [];
  for (const { col, row } of sources) {
    const i = cellIndex(col, row);
    if (isOpen(col, row) && dist[i] === -1) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (const cur of queue) {
    const col = cur % GRID_COLS;
    const row = (cur - col) / GRID_COLS;
    const here = dist[cur] ?? 0;
    for (const [d, dir] of DIRS.entries()) {
      const [dx, dz] = DIR_VECT[dir];
      const next = cellIndex(col + dx, row + dz);
      if (isOpen(col + dx, row + dz) && dist[next] === -1) {
        dist[next] = here + 1;
        first[next] = here === 0 ? d : (first[cur] ?? -1);
        queue.push(next);
      }
    }
  }
  return { dist, first };
};

export interface NavTarget {
  /** Straight-line offset from the player in cells; +dx is right, +dy is down. */
  dx: number;
  dy: number;
  /** Path length in cells — what actually separates the two in a maze. */
  steps: number;
  /** First step of the shortest path from the player; null when already there. */
  step: Dir | null;
}

/** Describe `to` as seen from `from`, using a flood that started at `from`. */
export const navTo = (from: Cell, to: Cell, fromFlood: Flood): NavTarget | null => {
  const i = cellIndex(to.col, to.row);
  const steps = fromFlood.dist[i] ?? -1;
  if (steps < 0) {
    return null;
  }
  return {
    dx: to.col - from.col,
    dy: to.row - from.row,
    step: DIRS[fromFlood.first[i] ?? -1] ?? null,
    steps,
  };
};

/**
 * The reachable cell of `cells` with the shortest path from the flood's source.
 * The source's own cell never counts: pickups are collected on arrival, so one
 * underfoot (the spawn cell's) is only eaten by leaving and coming back.
 */
export const nearestCell = (cells: Iterable<Cell>, fromFlood: Flood): Cell | null => {
  let best: Cell | null = null;
  let bestSteps = Infinity;
  for (const cell of cells) {
    const steps = fromFlood.dist[cellIndex(cell.col, cell.row)] ?? -1;
    if (steps > 0 && steps < bestSteps) {
      best = cell;
      bestSteps = steps;
    }
  }
  return best;
};

export const openDirs = (from: Cell): Record<Dir, boolean> => ({
  down: isOpen(from.col, from.row + 1),
  left: isOpen(from.col - 1, from.row),
  right: isOpen(from.col + 1, from.row),
  up: isOpen(from.col, from.row - 1),
});

/** Ghost-to-player speed ratio, and the head start (cells) a route must keep. */
const THREAT_PACE = 0.3;
const SAFE_MARGIN = 2;

/**
 * First step of an escape that still makes progress: flood outward from the
 * player through cells it reaches comfortably before any threat does, and head
 * for the nearest pickup in that region — or, with none, its cell farthest
 * from the threats. Null only with no threats.
 */
export const fleeStep = (
  from: Cell,
  threats: readonly Cell[],
  pickups: Iterable<Cell>,
): Dir | null => {
  if (threats.length === 0) {
    return null;
  }
  const threat = flood(threats).dist;
  const wanted = new Set<number>();
  for (const { col, row } of pickups) {
    wanted.add(cellIndex(col, row));
  }
  const seen = new Set([cellIndex(from.col, from.row)]);
  const queue = [{ cell: from, first: -1, steps: 0 }];
  let farthest = -1;
  let farthestFirst = -1;
  for (const { cell, first, steps } of queue) {
    for (const [d, dir] of DIRS.entries()) {
      const [dx, dz] = DIR_VECT[dir];
      const next = { col: cell.col + dx, row: cell.row + dz };
      const i = cellIndex(next.col, next.row);
      const away = threat[i] ?? -1;
      const safe = away < 0 || away > (steps + 1) * THREAT_PACE + SAFE_MARGIN;
      if (isOpen(next.col, next.row) && !seen.has(i) && safe) {
        seen.add(i);
        const out = first === -1 ? d : first;
        if (wanted.has(i)) {
          return DIRS[out] ?? null;
        }
        if (away > farthest) {
          farthest = away;
          farthestFirst = out;
        }
        queue.push({ cell: next, first: out, steps: steps + 1 });
      }
    }
  }
  if (farthestFirst !== -1) {
    return DIRS[farthestFirst] ?? null;
  }
  // Cornered: no neighbour keeps the margin, so take the least bad one.
  let best: Dir | null = null;
  for (const dir of DIRS) {
    const [dx, dz] = DIR_VECT[dir];
    const away = threat[cellIndex(from.col + dx, from.row + dz)] ?? -1;
    if (isOpen(from.col + dx, from.row + dz) && away > farthest) {
      best = dir;
      farthest = away;
    }
  }
  return best;
};
