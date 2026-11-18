import {
  baseStats,
  BOT_BOMB_CHANCE,
  BOT_MOVE_MS,
  COLORS,
  DIR_VECT,
  DIRS,
  EXPLOSION_MS,
  FUSE_MS,
  MAX_BOMBS,
  MAX_BOTS,
  MAX_RANGE,
  MIN_MOVE_MS,
  POWERUP_DROP_CHANCE,
  SPAWN_POINTS,
  SPEED_STEP_MS,
  TARGET_FIGHTERS,
  tileKey,
} from "../shared/constants";
import { bombOn, burnWindows, computeBlastTiles, restable, search } from "./burn-map";
import type { Burn } from "./burn-map";
import type {
  Bomb,
  Bot,
  Cell,
  Dir,
  PlayerStats,
  PowerupKind,
  SharedState,
} from "../shared/constants";

/** A connected human. `pos` is null until the player has spawned. */
export interface Human {
  id: string;
  pos: { col: number; row: number } | null;
}

export interface HostTickResult {
  patch: Partial<SharedState> | null;
}

type Position = [id: string, col: number, row: number];

interface Tile {
  col: number;
  row: number;
}

interface Dirty {
  blasts: boolean;
  bombs: boolean;
  bots: boolean;
  deaths: boolean;
  grid: boolean;
  powerups: boolean;
  stats: boolean;
  winner: boolean;
}

const POWERUP_KINDS: PowerupKind[] = ["bomb", "fire", "speed"];

const keepKeys = <T>(record: Record<string, T>, keep: (key: string, value: T) => boolean) => {
  const entries = Object.entries(record).filter(([k, v]) => keep(k, v));

  return entries.length === Object.keys(record).length ? record : Object.fromEntries(entries);
};

const manhattan = (c1: number, r1: number, c2: number, r2: number) =>
  Math.abs(c1 - c2) + Math.abs(r1 - r2);

const cloneBots = (bots: Record<string, Bot>) => {
  const out: Record<string, Bot> = {};

  for (const [id, b] of Object.entries(bots)) {
    out[id] = { ...b };
  }

  return out;
};

const randomKind = (random: () => number) =>
  POWERUP_KINDS[Math.floor(random() * POWERUP_KINDS.length)] ?? "bomb";

/** A human's bomb is named by its owner's own press counter, so the guest that
 *  pressed can show it before the host answers and recognise the host's copy. */
export const bombId = (ownerId: string, localId: number) => `b-${ownerId}-${localId}`;

const makeBomb = (
  ownerId: string,
  col: number,
  row: number,
  range: number,
  now: number,
  localId?: number,
) => ({
  col,
  id: localId === undefined ? `b-${ownerId}-${now}-${col}-${row}` : bombId(ownerId, localId),
  ownerId,
  placedAt: now,
  range,
  row,
});

/** A fighter's stats with one more power-up of `kind`, capped. */
export const grantPowerup = (stats: PlayerStats, kind: PowerupKind) => {
  switch (kind) {
    case "bomb": {
      return { ...stats, bombs: Math.min(MAX_BOMBS, stats.bombs + 1) };
    }

    case "fire": {
      return { ...stats, range: Math.min(MAX_RANGE, stats.range + 1) };
    }

    case "speed": {
      return { ...stats, speed: Math.max(MIN_MOVE_MS, stats.speed - SPEED_STEP_MS) };
    }
  }
};

const fighterPositions = (next: SharedState, humans: readonly Human[]) => {
  const out: Position[] = [];

  for (const { id, pos } of humans) {
    if (next.deaths[id] || !pos) {
      continue;
    }

    out.push([id, pos.col, pos.row]);
  }

  for (const bot of Object.values(next.bots)) {
    if (next.deaths[bot.id]) {
      continue;
    }

    out.push([bot.id, bot.col, bot.row]);
  }

  return out;
};

const occupiedTiles = (next: SharedState, humans: readonly Human[], exceptId: string) => {
  const occ = new Set<string>();

  for (const [id, col, row] of fighterPositions(next, humans)) {
    if (id !== exceptId) {
      occ.add(tileKey(col, row));
    }
  }

  return occ;
};

const BOT_STEP_SLACK_MS = 100;
const BURN_MARGIN_MS = 100;
const BOT_FLEE_STEPS = 9;

interface Neighbor {
  dir: Dir;
  c: number;
  r: number;
  key: string;
}

const neighborOf = (col: number, row: number, dir: Dir) => {
  const [dc, dr] = DIR_VECT[dir];

  return { c: col + dc, dir, key: tileKey(col + dc, row + dr), r: row + dr };
};

const escapeDir = (s: SharedState, windows: Map<string, Burn>, from: Tile, now: number) => {
  const canCross = (key: string, steps: number) => {
    const burn = windows.get(key);

    if (!burn) {
      return true;
    }

    const enter = now + (steps - 1) * BOT_MOVE_MS;
    const leave = now + steps * (BOT_MOVE_MS + BOT_STEP_SLACK_MS);

    return leave + BURN_MARGIN_MS < burn.from || enter - BURN_MARGIN_MS > burn.to;
  };

  return search(s, from, canCross, restable(windows), BOT_FLEE_STEPS)?.first ?? null;
};

const botNeighbors = (s: SharedState, col: number, row: number) => {
  const out: Neighbor[] = [];

  for (const dir of DIRS) {
    const [dc, dr] = DIR_VECT[dir];
    const c = col + dc;
    const r = row + dr;

    if (s.grid[r]?.[c]?.kind !== "empty") {
      continue;
    }

    if (bombOn(s.bombs, c, r)) {
      continue;
    }

    out.push({ c, dir, key: tileKey(c, r), r });
  }

  return out;
};

const adjacentCrate = (grid: Cell[][], col: number, row: number) =>
  DIRS.some((dir) => {
    const [dc, dr] = DIR_VECT[dir];

    return grid[row + dr]?.[col + dc]?.kind === "crate";
  });

const enemyInLine = (grid: Cell[][], bot: Bot, range: number, fighters: Position[]) => {
  const enemyTiles = new Set(
    fighters.filter(([id]) => id !== bot.id).map(([, c, r]) => tileKey(c, r)),
  );

  for (const dir of DIRS) {
    const [dc, dr] = DIR_VECT[dir];

    for (let step = 1; step <= range; step += 1) {
      const c = bot.col + dc * step;
      const r = bot.row + dr * step;
      const cell = grid[r]?.[c];

      if (!cell || cell.kind === "wall" || cell.kind === "crate") {
        break;
      }

      if (enemyTiles.has(tileKey(c, r))) {
        return true;
      }
    }
  }

  return false;
};

const nearestEnemy = (bot: Bot, fighters: Position[]) => {
  let best: Tile | null = null;
  let bestD = Infinity;

  for (const [id, c, r] of fighters) {
    if (id === bot.id) {
      continue;
    }

    const dd = manhattan(bot.col, bot.row, c, r);

    if (dd < bestD) {
      bestD = dd;
      best = { col: c, row: r };
    }
  }

  return best;
};

const nearestCrate = (grid: Cell[][], col: number, row: number) => {
  let best: Tile | null = null;
  let bestD = Infinity;

  for (const [r, gr] of grid.entries()) {
    for (const [c, cell] of gr.entries()) {
      if (cell.kind !== "crate") {
        continue;
      }

      const dd = manhattan(col, row, c, r);

      if (dd < bestD) {
        bestD = dd;
        best = { col: c, row: r };
      }
    }
  }

  return best;
};

const closestTo = (options: readonly Neighbor[], target: Tile) => {
  let best: Neighbor | null = null;
  let bestD = Infinity;

  for (const o of options) {
    const d = manhattan(o.c, o.r, target.col, target.row);

    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }

  return best;
};

const moveBot = (bot: Bot, to: Neighbor | null, now: number) => {
  if (!to) {
    bot.moving = false;
    bot.nextMoveAt = now + BOT_MOVE_MS;

    return;
  }

  bot.col = to.c;
  bot.row = to.r;
  bot.dir = to.dir;
  bot.moving = true;
  bot.nextMoveAt = now + BOT_MOVE_MS;
};

const addBomb = (
  next: SharedState,
  ownerId: string,
  col: number,
  row: number,
  stats: PlayerStats,
  now: number,
) => {
  if (bombOn(next.bombs, col, row)) {
    return;
  }

  const bomb = makeBomb(ownerId, col, row, stats.range, now);
  next.bombs[bomb.id] = bomb;
};

interface BotContext {
  next: SharedState;
  humans: readonly Human[];
  now: number;
  random: () => number;
  enemies: Position[];
}

const botAttack = (ctx: BotContext, bot: Bot, stats: PlayerStats) => {
  const { next, now, random, enemies } = ctx;
  const bombs = Object.values(next.bombs);
  const activeBombs = bombs.filter((b) => b.ownerId === bot.id).length;

  if (
    activeBombs >= stats.bombs ||
    bombOn(next.bombs, bot.col, bot.row) ||
    !(
      adjacentCrate(next.grid, bot.col, bot.row) ||
      enemyInLine(next.grid, bot, stats.range, enemies)
    )
  ) {
    return false;
  }

  const prospective = { col: bot.col, placedAt: now, range: stats.range, row: bot.row };
  const escape = escapeDir(next, burnWindows(next, [...bombs, prospective]), bot, now);

  if (!escape || random() >= BOT_BOMB_CHANCE) {
    return false;
  }

  addBomb(next, bot.id, bot.col, bot.row, stats, now);
  moveBot(bot, neighborOf(bot.col, bot.row, escape), now);

  return true;
};

const botWander = (ctx: BotContext, bot: Bot, windows: Map<string, Burn>) => {
  const { next, humans, now, random, enemies } = ctx;
  const opts = botNeighbors(next, bot.col, bot.row);
  const safeOpts = opts.filter((o) => !windows.has(o.key));
  const occupied = occupiedTiles(next, humans, bot.id);
  const freeOpts = safeOpts.filter((o) => !occupied.has(o.key));
  const wanderOpts = freeOpts.length > 0 ? freeOpts : safeOpts;
  const target = nearestEnemy(bot, enemies) ?? nearestCrate(next.grid, bot.col, bot.row);
  let pick = wanderOpts[Math.floor(random() * wanderOpts.length)] ?? null;

  if (target && wanderOpts.length > 0 && random() > 0.25) {
    pick = closestTo(wanderOpts, target);
  }

  moveBot(bot, pick, now);
};

interface Turn {
  bot: boolean;
  bomb: boolean;
}

const NO_TURN: Turn = { bomb: false, bot: false };
const MOVED: Turn = { bomb: false, bot: true };

const tickBot = (ctx: BotContext, bot: Bot) => {
  const { next, now } = ctx;

  if (next.deaths[bot.id]) {
    if (bot.moving) {
      bot.moving = false;

      return MOVED;
    }

    return NO_TURN;
  }

  if (now < bot.nextMoveAt) {
    return NO_TURN;
  }

  const windows = burnWindows(next, Object.values(next.bombs));

  if (windows.has(tileKey(bot.col, bot.row))) {
    const dir = escapeDir(next, windows, bot, now);
    moveBot(bot, dir ? neighborOf(bot.col, bot.row, dir) : null, now);

    return MOVED;
  }

  if (botAttack(ctx, bot, next.stats[bot.id] ?? baseStats())) {
    return { bomb: true, bot: true };
  }

  botWander(ctx, bot, windows);

  return MOVED;
};

const tickBots = (
  next: SharedState,
  humans: readonly Human[],
  now: number,
  random: () => number,
) => {
  const bots = Object.values(next.bots);

  if (bots.length === 0) {
    return NO_TURN;
  }

  const ctx: BotContext = {
    enemies: fighterPositions(next, humans),
    humans,
    next,
    now,
    random,
  };

  const changed = { ...NO_TURN };

  for (const bot of bots) {
    const turn = tickBot(ctx, bot);
    changed.bot ||= turn.bot;
    changed.bomb ||= turn.bomb;
  }

  return changed;
};

const reconcileBots = (next: SharedState, humanCount: number, now: number, d: Dirty) => {
  const want = new Set<number>();

  for (
    let c = humanCount;
    c <= 3 && c - humanCount < MAX_BOTS && want.size < TARGET_FIGHTERS - humanCount;
    c += 1
  ) {
    want.add(c);
  }

  const kept = keepKeys(next.bots, (id) => want.has(Number(id.slice(4))));

  if (kept !== next.bots) {
    next.bots = kept;
    d.bots = true;
  }

  for (const corner of want) {
    const id = `bot-${corner}`;

    if (!next.bots[id]) {
      const spawn = SPAWN_POINTS[corner] ?? SPAWN_POINTS[0];
      next.bots[id] = {
        col: spawn.col,
        colorIdx: corner % COLORS.length,
        dir: "down",
        id,
        moving: false,
        nextMoveAt: now + 700,
        row: spawn.row,
      };
      next.stats[id] = baseStats();
      d.bots = true;
      d.stats = true;
    }
  }
};

const pruneDeparted = (next: SharedState, activeIds: Set<string>, d: Dirty) => {
  const stats = keepKeys(next.stats, (id) => activeIds.has(id));

  if (stats !== next.stats) {
    next.stats = stats;
    d.stats = true;
  }

  const deaths = keepKeys(next.deaths, (id) => activeIds.has(id));

  if (deaths !== next.deaths) {
    next.deaths = deaths;
    d.deaths = true;
  }
};

const cascadeDetonations = (s: SharedState, next: SharedState, expired: Bomb[], now: number) => {
  const detonated = new Set<string>();
  const queue: Bomb[] = [...expired];
  const cratesToClear = new Map<string, Tile>();
  const newBlastTiles = new Set<string>();
  let bomb: Bomb | undefined;

  while ((bomb = queue.shift()) !== undefined) {
    if (detonated.has(bomb.id)) {
      continue;
    }

    detonated.add(bomb.id);
    const { tiles, crates } = computeBlastTiles(s.grid, bomb);

    for (const t of tiles) {
      newBlastTiles.add(tileKey(t.col, t.row));

      for (const other of Object.values(next.bombs)) {
        if (!detonated.has(other.id) && other.col === t.col && other.row === t.row) {
          queue.push(other);
        }
      }
    }

    for (const cr of crates) {
      cratesToClear.set(tileKey(cr.col, cr.row), cr);
    }

    next.blasts[`x-${bomb.id}`] = { id: `x-${bomb.id}`, placedAt: now, tiles };
  }

  return { cratesToClear, detonated, newBlastTiles };
};

const detonateExpired = (
  s: SharedState,
  next: SharedState,
  now: number,
  random: () => number,
  d: Dirty,
) => {
  const expired = Object.values(next.bombs).filter((b) => now - b.placedAt >= FUSE_MS);

  if (expired.length === 0) {
    return;
  }

  const { detonated, cratesToClear, newBlastTiles } = cascadeDetonations(s, next, expired, now);
  next.bombs = keepKeys(next.bombs, (id) => !detonated.has(id));

  if (cratesToClear.size > 0) {
    const grid = s.grid.map((row) => [...row]);

    for (const cr of cratesToClear.values()) {
      const row = grid[cr.row];

      if (row) {
        row[cr.col] = { kind: "empty" };
      }
    }

    next.grid = grid;
    d.grid = true;
  }

  const survived = keepKeys(next.powerups, (key) => !newBlastTiles.has(key));

  if (survived !== next.powerups) {
    next.powerups = survived;
    d.powerups = true;
  }

  for (const cr of cratesToClear.values()) {
    const key = tileKey(cr.col, cr.row);

    if (!next.powerups[key] && random() < POWERUP_DROP_CHANCE) {
      next.powerups[key] = { col: cr.col, kind: randomKind(random), row: cr.row };
      d.powerups = true;
    }
  }

  d.bombs = true;
  d.blasts = true;
};

const expireBlasts = (next: SharedState, now: number, d: Dirty) => {
  const live = keepKeys(next.blasts, (_id, blast) => now - blast.placedAt < EXPLOSION_MS);

  if (live !== next.blasts) {
    next.blasts = live;
    d.blasts = true;
  }
};

const applyBlastDeaths = (next: SharedState, livePos: Position[], now: number, d: Dirty) => {
  const liveBlasts = Object.values(next.blasts);

  if (liveBlasts.length === 0) {
    return;
  }

  for (const [fid, col, row] of livePos) {
    if (next.deaths[fid]) {
      continue;
    }

    if (liveBlasts.some((b) => b.tiles.some((t) => t.col === col && t.row === row))) {
      next.deaths[fid] = now;
      d.deaths = true;
    }
  }
};

const resolveWinner = (next: SharedState, fighterIds: string[], d: Dirty) => {
  if (fighterIds.length < 2 || next.winner) {
    return;
  }

  const alive = fighterIds.filter((id) => !next.deaths[id]);
  const [sole] = alive;

  if (alive.length === 1 && sole) {
    next.winner = sole;
    d.winner = true;
  } else if (alive.length === 0) {
    next.winner = "draw";
    d.winner = true;
  }
};

const buildPatch = (next: SharedState, d: Dirty) => {
  const patch: Partial<SharedState> = {};

  if (d.grid) {
    patch.grid = next.grid;
  }

  if (d.bombs) {
    patch.bombs = next.bombs;
  }

  if (d.blasts) {
    patch.blasts = next.blasts;
  }

  if (d.powerups) {
    patch.powerups = next.powerups;
  }

  if (d.bots) {
    patch.bots = next.bots;
  }

  if (d.stats) {
    patch.stats = next.stats;
  }

  if (d.deaths) {
    patch.deaths = next.deaths;
  }

  if (d.winner) {
    patch.winner = next.winner;
  }

  return Object.keys(patch).length > 0 ? patch : null;
};

export const hostTick = (
  s: SharedState,
  humans: readonly Human[],
  now: number,
  random: () => number = Math.random,
) => {
  const next: SharedState = {
    blasts: { ...s.blasts },
    bombs: { ...s.bombs },
    bots: cloneBots(s.bots ?? {}),
    deaths: { ...s.deaths },
    grid: s.grid,
    powerups: { ...s.powerups },
    startedAt: s.startedAt,
    stats: { ...s.stats },
    winner: s.winner,
  };

  const d: Dirty = {
    blasts: false,
    bombs: false,
    bots: false,
    deaths: false,
    grid: false,
    powerups: false,
    stats: false,
    winner: false,
  };

  const humanIds = humans.map((human) => human.id);

  reconcileBots(next, humanIds.length, now, d);
  pruneDeparted(next, new Set([...humanIds, ...Object.keys(next.bots)]), d);
  detonateExpired(s, next, now, random, d);
  expireBlasts(next, now, d);

  const turns = tickBots(next, humans, now, random);
  d.bots ||= turns.bot;
  d.bombs ||= turns.bomb;

  const livePos = fighterPositions(next, humans);
  applyBlastDeaths(next, livePos, now, d);
  resolveWinner(next, [...humanIds, ...Object.keys(next.bots)], d);

  return { patch: buildPatch(next, d) };
};

/**
 * A human's bomb request: the new bombs record, or null when the rules refuse
 * it. `localId` is the owner's press counter (see `bombId`); a guest runs the
 * same rule on its own view to predict the answer.
 */
export const placeBomb = (
  s: SharedState,
  ownerId: string,
  col: number,
  row: number,
  now: number,
  localId?: number,
) => {
  if (s.deaths[ownerId]) {
    return null;
  }

  if (s.grid[row]?.[col]?.kind !== "empty" || bombOn(s.bombs, col, row)) {
    return null;
  }

  const stats = s.stats[ownerId] ?? baseStats();
  const active = Object.values(s.bombs).filter((b) => b.ownerId === ownerId).length;

  if (active >= stats.bombs) {
    return null;
  }

  const bomb = makeBomb(ownerId, col, row, stats.range, now, localId);

  if (s.bombs[bomb.id]) {
    return null;
  }

  return { ...s.bombs, [bomb.id]: bomb };
};
