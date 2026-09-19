// When each tile burns, and grid searches that respect it. Shared by the bots
// (host-sim) and the playtest view so both read fire the way the rules apply it.

import { DIRS, DIR_VECT, EXPLOSION_MS, FUSE_MS, tileKey } from "../shared/constants";
import type { Bomb, Cell, Dir, SharedState } from "../shared/constants";

interface Tile {
  col: number;
  row: number;
}

/** Is there a bomb on this tile? */
export const bombOn = (bombs: Record<string, Bomb>, col: number, row: number): boolean =>
  Object.values(bombs).some((b) => b.col === col && b.row === row);

export const computeBlastTiles = (grid: Cell[][], bomb: Pick<Bomb, "col" | "row" | "range">) => {
  const tiles: Tile[] = [{ col: bomb.col, row: bomb.row }];
  const crates: Tile[] = [];
  for (const [dc, dr] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    for (let step = 1; step <= bomb.range; step += 1) {
      const c = bomb.col + dc * step;
      const r = bomb.row + dr * step;
      const cell = grid[r]?.[c];
      if (!cell || cell.kind === "wall") {
        break;
      }
      tiles.push({ col: c, row: r });
      if (cell.kind === "crate") {
        crates.push({ col: c, row: r });
        break;
      }
    }
  }
  return { crates, tiles };
};

/** When a tile is on fire: `from` is -Infinity for a blast already burning. */
export interface Burn {
  from: number;
  to: number;
}

export type FuseBomb = Pick<Bomb, "col" | "row" | "range" | "placedAt">;

export interface Reach {
  steps: number;
  first: Dir | null;
}

interface SearchNode {
  col: number;
  row: number;
  first: Dir;
}

/**
 * Every tile that is burning or will burn, and when. A bomb caught in an
 * earlier blast goes off with it, so fuses are relaxed until they settle.
 */
export const burnWindows = (state: SharedState, bombs: readonly FuseBomb[]): Map<string, Burn> => {
  const fused = bombs.map((bomb) => ({
    at: bomb.placedAt + FUSE_MS,
    bomb,
    tiles: computeBlastTiles(state.grid, bomb).tiles,
  }));
  let settled = false;
  while (!settled) {
    settled = true;
    for (const source of fused) {
      for (const other of fused) {
        const caught = source.tiles.some(
          (tile) => tile.col === other.bomb.col && tile.row === other.bomb.row,
        );
        if (caught && other.at > source.at) {
          other.at = source.at;
          settled = false;
        }
      }
    }
  }
  const burns = new Map<string, Burn>();
  const mark = (key: string, from: number, to: number): void => {
    const known = burns.get(key);
    burns.set(
      key,
      known ? { from: Math.min(known.from, from), to: Math.max(known.to, to) } : { from, to },
    );
  };
  for (const blast of Object.values(state.blasts)) {
    for (const tile of blast.tiles) {
      mark(tileKey(tile.col, tile.row), -Infinity, blast.placedAt + EXPLOSION_MS);
    }
  }
  for (const { at, tiles } of fused) {
    for (const tile of tiles) {
      mark(tileKey(tile.col, tile.row), at, at + EXPLOSION_MS);
    }
  }
  return burns;
};

/** Breadth-first walk over empty, bomb-free tiles. `steps` is how many moves
 *  in a tile is, so `canEnter` can weigh it against a burn window. */
export const search = (
  state: SharedState,
  from: { col: number; row: number },
  canEnter: (key: string, steps: number) => boolean,
  isGoal: (col: number, row: number, key: string, steps: number) => boolean,
  maxSteps: number,
): Reach | null => {
  const startKey = tileKey(from.col, from.row);
  if (isGoal(from.col, from.row, startKey, 0)) {
    return { first: null, steps: 0 };
  }
  const visited = new Set<string>([startKey]);
  let frontier: SearchNode[] = [];
  const expand = (
    node: { col: number; row: number; first: Dir | null },
    steps: number,
    out: SearchNode[],
  ): Dir | null => {
    const { col, row, first } = node;
    for (const dir of DIRS) {
      const [dc, dr] = DIR_VECT[dir];
      const c = col + dc;
      const r = row + dr;
      const key = tileKey(c, r);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      if (
        state.grid[r]?.[c]?.kind !== "empty" ||
        bombOn(state.bombs, c, r) ||
        !canEnter(key, steps)
      ) {
        continue;
      }
      if (isGoal(c, r, key, steps)) {
        return first ?? dir;
      }
      out.push({ col: c, first: first ?? dir, row: r });
    }
    return null;
  };
  const opening = expand({ ...from, first: null }, 1, frontier);
  if (opening) {
    return { first: opening, steps: 1 };
  }
  for (let steps = 2; steps <= maxSteps && frontier.length > 0; steps += 1) {
    const next: SearchNode[] = [];
    for (const node of frontier) {
      const found = expand(node, steps, next);
      if (found) {
        return { first: found, steps };
      }
    }
    frontier = next;
  }
  return null;
};

/** A tile to stop on: nothing burning, nothing lit that will reach it. */
export const restable =
  (windows: Map<string, Burn>) =>
  (_c: number, _r: number, key: string): boolean =>
    !windows.has(key);
