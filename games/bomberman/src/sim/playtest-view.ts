import { baseStats, DIRS, DIR_VECT, EXPLOSION_MS, FUSE_MS, tileKey } from "../shared/constants";
import type { Bomb, Cell, Dir, PowerupKind, SharedState } from "../shared/constants";
import { bombOn, computeBlastTiles } from "./host-sim";

// What a playtester decides from. A decision model has no eyes, so this is the
// board the way a player reads it — the four cells around them, where the
// fire will be, what is worth walking to — plus, per intent, the next grid
// step towards it. The steps are what the manifest's reflexes hold: a bomb and
// the retreat out of its blast line are 175 ms apart, far inside one decision.

/** The next input towards an intent. `wait` = hold still, `none` = no reachable target. */
export type PlanStep = Dir | "bomb" | "wait" | "none";

export type CellView = "open" | "wall" | "crate" | "bomb" | "danger" | "fire";

interface Offset {
  dx: number;
  dy: number;
}

export interface PlaytestView {
  cell: { col: number; row: number };
  inDanger: boolean;
  bombReady: boolean;
  blastRange: number;
  around: Record<Dir, CellView>;
  nearestCrate: Offset | null;
  nearestBot: (Offset & { inBlastLine: boolean }) | null;
  nearestPowerup: (Offset & { kind: PowerupKind }) | null;
  nearestBomb: (Offset & { msLeft: number }) | null;
  plan: {
    cover: PlanStep;
    crate: PlanStep;
    bot: PlanStep;
    powerup: PlanStep;
    bombHere: PlanStep;
  };
}

export interface PlaytestViewInput {
  state: SharedState;
  myId: string;
  col: number;
  row: number;
  now: number;
  /** One grid step takes this long; the next may start after `cooldownMs`. */
  stepMs: number;
  cooldownMs: number;
}

/** When a tile is on fire: `from` is -Infinity for a blast already burning. */
interface Burn {
  from: number;
  to: number;
}

type FuseBomb = Pick<Bomb, "col" | "row" | "range" | "placedAt">;

interface Reach {
  steps: number;
  first: Dir | null;
}

interface SearchNode {
  col: number;
  row: number;
  first: Dir;
}

/** A blast line is at most this many steps from cover, well inside one fuse. */
const ESCAPE_STEPS = 4;
const FLEE_STEPS = 8;
const TRAVEL_STEPS = 48;
/** Slack around a burn window: the host resolves deaths on a 70 ms tick and
 *  the step that leaves a tile lands a frame or two after it is decided. */
const BURN_MARGIN_MS = 160;

/**
 * Every tile that is burning or will burn, and when. A bomb caught in an
 * earlier blast goes off with it, so fuses are relaxed until they settle.
 */
const burnWindows = (state: SharedState, bombs: readonly FuseBomb[]): Map<string, Burn> => {
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

const search = (
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

const nearest = <T extends { col: number; row: number }>(
  items: readonly T[],
  col: number,
  row: number,
): T | null => {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const item of items) {
    const distance = Math.abs(item.col - col) + Math.abs(item.row - row);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
};

const crateTiles = (grid: Cell[][]): { col: number; row: number }[] => {
  const out: { col: number; row: number }[] = [];
  for (const [row, cells] of grid.entries()) {
    for (const [col, cell] of cells.entries()) {
      if (cell.kind === "crate") {
        out.push({ col, row });
      }
    }
  }
  return out;
};

const stepOf = (reach: Reach | null, atTarget: PlanStep): PlanStep => {
  if (!reach) {
    return "none";
  }
  return reach.first ?? atTarget;
};

/** A tile to stop on: nothing burning, nothing lit that will reach it. */
const restable =
  (windows: Map<string, Burn>) =>
  (_c: number, _r: number, key: string): boolean =>
    !windows.has(key);

export const playtestView = (input: PlaytestViewInput): PlaytestView => {
  const { state, myId, col, row, now, stepMs, cooldownMs } = input;
  const stats = state.stats[myId] ?? baseStats();
  const liveBombs = Object.values(state.bombs);
  const burns = burnWindows(state, liveBombs);
  const here = tileKey(col, row);
  const inDanger = burns.has(here);
  const bots = Object.values(state.bots).filter((bot) => !state.deaths[bot.id]);
  const botTiles = new Set(bots.map((bot) => tileKey(bot.col, bot.row)));
  const activeBombs = liveBombs.filter((bomb) => bomb.ownerId === myId).length;
  const bombReady = activeBombs < stats.bombs && !bombOn(state.bombs, col, row);

  /** When the player would stand on a tile `steps` away, walking flat out. */
  const arrival = (steps: number): number => now + cooldownMs + Math.max(0, steps - 1) * stepMs;
  /** Crossing is fine while the fire is still a step away, or already out. */
  const crossable =
    (windows: Map<string, Burn>, start: number) =>
    (key: string, steps: number): boolean => {
      const burn = windows.get(key);
      if (!burn) {
        return true;
      }
      const enter = start + arrival(steps) - now;
      return enter + stepMs + BURN_MARGIN_MS < burn.from || enter - BURN_MARGIN_MS > burn.to;
    };
  const clear = (key: string): boolean => !burns.has(key);

  /** What a bomb dropped on this tile would hit — only if its owner can still reach cover. */
  const bombFrom = (
    c: number,
    r: number,
    steps: number,
  ): { crates: number; hitsBot: boolean } | null => {
    const placedAt = arrival(steps);
    const mine = { col: c, placedAt, range: stats.range, row: r };
    const after = burnWindows(state, [...liveBombs, mine]);
    const escape = search(
      state,
      { col: c, row: r },
      crossable(after, placedAt),
      restable(after),
      ESCAPE_STEPS,
    );
    if (!escape) {
      return null;
    }
    const { crates, tiles } = computeBlastTiles(state.grid, mine);
    return {
      crates: crates.filter((crate) => !burns.has(tileKey(crate.col, crate.row))).length,
      hitsBot: tiles.some((tile) => botTiles.has(tileKey(tile.col, tile.row))),
    };
  };

  const atTarget: PlanStep = bombReady ? "bomb" : "wait";
  const from = { col, row };
  const flee = search(state, from, crossable(burns, now), restable(burns), FLEE_STEPS);
  const toCrate = search(
    state,
    from,
    clear,
    (c, r, _key, steps) => (bombFrom(c, r, steps)?.crates ?? 0) > 0,
    TRAVEL_STEPS,
  );
  const toBot = search(
    state,
    from,
    clear,
    (c, r, _key, steps) => bombFrom(c, r, steps)?.hitsBot === true,
    TRAVEL_STEPS,
  );
  const toPowerup = search(
    state,
    from,
    clear,
    (_c, _r, key) => state.powerups[key] !== undefined,
    TRAVEL_STEPS,
  );
  const bombHere = bombFrom(col, row, 0);

  const cellView = (dir: Dir): CellView => {
    const [dc, dr] = DIR_VECT[dir];
    const c = col + dc;
    const r = row + dr;
    const kind = state.grid[r]?.[c]?.kind ?? "wall";
    if (kind !== "empty") {
      return kind;
    }
    if (bombOn(state.bombs, c, r)) {
      return "bomb";
    }
    const key = tileKey(c, r);
    const burn = burns.get(key);
    if (!burn) {
      return "open";
    }
    return burn.from <= now ? "fire" : "danger";
  };

  const offset = (tile: { col: number; row: number }): Offset => ({
    dx: tile.col - col,
    dy: tile.row - row,
  });
  const crate = nearest(crateTiles(state.grid), col, row);
  const bot = nearest(bots, col, row);
  const powerup = nearest(Object.values(state.powerups), col, row);
  const bomb = nearest(Object.values(state.bombs), col, row);

  return {
    around: {
      down: cellView("down"),
      left: cellView("left"),
      right: cellView("right"),
      up: cellView("up"),
    },
    blastRange: stats.range,
    bombReady,
    cell: { col, row },
    inDanger,
    nearestBomb: bomb
      ? { ...offset(bomb), msLeft: Math.max(0, Math.round(bomb.placedAt + FUSE_MS - now)) }
      : null,
    nearestBot: bot ? { ...offset(bot), inBlastLine: bombHere?.hitsBot === true } : null,
    nearestCrate: crate ? offset(crate) : null,
    nearestPowerup: powerup ? { ...offset(powerup), kind: powerup.kind } : null,
    plan: {
      bombHere: bombReady && bombHere ? "bomb" : "wait",
      bot: stepOf(toBot, atTarget),
      cover: inDanger ? stepOf(flee, "wait") : "wait",
      crate: stepOf(toCrate, atTarget),
      powerup: stepOf(toPowerup, "wait"),
    },
  };
};

/**
 * Points the local player earned: a crate opened by their bomb is 1, a rival
 * caught in it is 10. Rivals that blow themselves up score nothing, so the
 * number only moves when the player's own bombs land.
 */
export class PlaytestScore {
  crates = 0;
  kills = 0;
  private grid: Cell[][] | null = null;
  private blasts = new Set<string>();
  private deaths = new Set<string>();

  get points(): number {
    return this.crates + this.kills * 10;
  }

  reset(): void {
    this.crates = 0;
    this.kills = 0;
    this.grid = null;
    this.blasts.clear();
    this.deaths.clear();
  }

  observe(state: SharedState, myId: string): void {
    const mine = Object.values(state.blasts).filter((blast) => blast.id.startsWith(`x-b-${myId}-`));
    for (const blast of mine) {
      if (this.blasts.has(blast.id)) {
        continue;
      }
      for (const tile of blast.tiles) {
        const before = this.grid?.[tile.row]?.[tile.col]?.kind;
        if (before === "crate" && state.grid[tile.row]?.[tile.col]?.kind === "empty") {
          this.crates += 1;
        }
      }
    }
    for (const id of Object.keys(state.deaths)) {
      const rival = state.bots[id];
      if (this.deaths.has(id) || !rival) {
        continue;
      }
      const caught = mine.some((blast) =>
        blast.tiles.some((tile) => tile.col === rival.col && tile.row === rival.row),
      );
      if (caught) {
        this.kills += 1;
      }
    }
    this.grid = state.grid;
    this.blasts = new Set(Object.keys(state.blasts));
    this.deaths = new Set(Object.keys(state.deaths));
  }
}
