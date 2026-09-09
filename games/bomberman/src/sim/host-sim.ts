// Host-authoritative simulation: one pure step over the shared world. State
// and the humans' positions come in, a shallow patch (only the fields that
// changed — bot moves fire every tick, and the 285-cell grid must not ride
// along) and the pickup beats to announce come out. No Phaser, no clock, no
// network: the scene owns those, which keeps this runnable under Node.

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

/** The authoritative grant of a powerup — the only source of pickup feedback. */
export type Pickup = {
  col: number;
  row: number;
  kind: PowerupKind;
  collector: string;
  round: number;
};

export interface HostTickResult {
  patch: Partial<SharedState> | null;
  pickups: Pickup[];
}

type Position = [id: string, col: number, row: number];

interface Tile {
  col: number;
  row: number;
}

/** Which shared-state fields this tick changed — only those ride in the patch. */
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

// ---- rules helpers ----------------------------------------------------------

/** A copy of `record` without the entries `keep` rejects — the same object when
 *  nothing was dropped, so callers can flag a change by identity. */
const keepKeys = <T>(
  record: Record<string, T>,
  keep: (key: string, value: T) => boolean,
): Record<string, T> => {
  const entries = Object.entries(record).filter(([k, v]) => keep(k, v));
  return entries.length === Object.keys(record).length ? record : Object.fromEntries(entries);
};

const manhattan = (c1: number, r1: number, c2: number, r2: number): number =>
  Math.abs(c1 - c2) + Math.abs(r1 - r2);

const cloneBots = (bots: Record<string, Bot>) => {
  const out: Record<string, Bot> = {};
  for (const [id, b] of Object.entries(bots)) {
    out[id] = { ...b };
  }
  return out;
};

const randomKind = (random: () => number): PowerupKind =>
  POWERUP_KINDS[Math.floor(random() * POWERUP_KINDS.length)] ?? "bomb";

const makeBomb = (ownerId: string, col: number, row: number, range: number, now: number): Bomb => ({
  col,
  id: `b-${ownerId}-${now}-${col}-${row}`,
  ownerId,
  placedAt: now,
  range,
  row,
});

/** Is there a bomb on this tile? */
export const bombOn = (bombs: Record<string, Bomb>, col: number, row: number): boolean =>
  Object.values(bombs).some((b) => b.col === col && b.row === row);

const grantPowerup = (stats: PlayerStats, kind: PowerupKind): PlayerStats => {
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
    // no default
  }
};

const computeBlastTiles = (grid: Cell[][], bomb: Bomb) => {
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

/** [id, col, row] for every living fighter (humans + bots). */
const fighterPositions = (next: SharedState, humans: readonly Human[]): Position[] => {
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

/** Tiles currently held by living fighters other than `exceptId` (bot tiles
 *  are read live, so bots already moved this tick are reflected). */
const occupiedTiles = (
  next: SharedState,
  humans: readonly Human[],
  exceptId: string,
): Set<string> => {
  const occ = new Set<string>();
  for (const [id, col, row] of fighterPositions(next, humans)) {
    if (id !== exceptId) {
      occ.add(tileKey(col, row));
    }
  }
  return occ;
};

// ---- bot AI helpers ---------------------------------------------------------

/** Tiles that are unsafe right now: every bomb's eventual blast + live blasts. */
const dangerSet = (s: SharedState): Set<string> => {
  const danger = new Set<string>();
  for (const bomb of Object.values(s.bombs)) {
    for (const t of computeBlastTiles(s.grid, bomb).tiles) {
      danger.add(tileKey(t.col, t.row));
    }
  }
  for (const blast of Object.values(s.blasts)) {
    for (const t of blast.tiles) {
      danger.add(tileKey(t.col, t.row));
    }
  }
  return danger;
};

interface Neighbor {
  dir: Dir;
  c: number;
  r: number;
  key: string;
}

const neighborOf = (col: number, row: number, dir: Dir): Neighbor => {
  const [dc, dr] = DIR_VECT[dir];
  return { c: col + dc, dir, key: tileKey(col + dc, row + dr), r: row + dr };
};

interface FleeNode {
  c: number;
  r: number;
  firstDir: Dir;
}

/**
 * Breadth-first search for the nearest tile not in `unsafe`, returning the
 * direction of the first step toward it (or null if no safe tile is reachable).
 * Walks only empty, bomb-free tiles. Used both to flee live danger and to
 * vet a prospective bomb's escape route.
 */
const fleeDir = (
  grid: Cell[][],
  bombs: Bomb[],
  col: number,
  row: number,
  unsafe: Set<string>,
): Dir | null => {
  const blocked = (c: number, r: number): boolean =>
    grid[r]?.[c]?.kind !== "empty" || bombs.some((b) => b.col === c && b.row === r);
  const visited = new Set<string>([tileKey(col, row)]);
  let frontier: FleeNode[] = [];
  for (const dir of DIRS) {
    const [dc, dr] = DIR_VECT[dir];
    const c = col + dc;
    const r = row + dr;
    const k = tileKey(c, r);
    if (blocked(c, r)) {
      continue;
    }
    visited.add(k);
    if (!unsafe.has(k)) {
      return dir;
    }
    frontier.push({ c, firstDir: dir, r });
  }
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const nextF: FleeNode[] = [];
    for (const node of frontier) {
      for (const dir of DIRS) {
        const [dc, dr] = DIR_VECT[dir];
        const c = node.c + dc;
        const r = node.r + dr;
        const k = tileKey(c, r);
        if (visited.has(k) || blocked(c, r)) {
          continue;
        }
        visited.add(k);
        if (!unsafe.has(k)) {
          return node.firstDir;
        }
        nextF.push({ c, firstDir: node.firstDir, r });
      }
    }
    frontier = nextF;
  }
  return null;
};

const botNeighbors = (s: SharedState, col: number, row: number): Neighbor[] => {
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

const adjacentCrate = (grid: Cell[][], col: number, row: number): boolean =>
  DIRS.some((dir) => {
    const [dc, dr] = DIR_VECT[dir];
    return grid[row + dr]?.[col + dc]?.kind === "crate";
  });

const enemyInLine = (grid: Cell[][], bot: Bot, range: number, fighters: Position[]): boolean => {
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

const nearestEnemy = (bot: Bot, fighters: Position[]): Tile | null => {
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

const nearestCrate = (grid: Cell[][], col: number, row: number): Tile | null => {
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

/** The candidate step that lands nearest `target` (first wins on a tie). */
const closestTo = (options: readonly Neighbor[], target: Tile): Neighbor | null => {
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

const moveBot = (bot: Bot, to: Neighbor | null, now: number): void => {
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
): void => {
  if (bombOn(next.bombs, col, row)) {
    return;
  }
  const bomb = makeBomb(ownerId, col, row, stats.range, now);
  next.bombs[bomb.id] = bomb;
};

/** Everything one bot's turn reads; built once per tick, shared by all bots. */
interface BotContext {
  next: SharedState;
  humans: readonly Human[];
  now: number;
  random: () => number;
  danger: Set<string>;
  enemies: Position[];
}

/** Offense: bomb a crate or a fighter in line, but only if a flee path out of
 *  the resulting blast exists (don't bomb yourself into a dead end). Returns
 *  true when the bot dropped a bomb and stepped away this turn. */
const botAttack = (ctx: BotContext, bot: Bot, stats: PlayerStats, bombs: Bomb[]): boolean => {
  const { next, now, random, danger, enemies } = ctx;
  const activeBombs = bombs.filter((b) => b.ownerId === bot.id).length;
  if (
    activeBombs >= stats.bombs ||
    !(
      adjacentCrate(next.grid, bot.col, bot.row) ||
      enemyInLine(next.grid, bot, stats.range, enemies)
    )
  ) {
    return false;
  }
  const prospective: Bomb = {
    col: bot.col,
    id: "_",
    ownerId: bot.id,
    placedAt: now,
    range: stats.range,
    row: bot.row,
  };
  const blastKeys = new Set(
    computeBlastTiles(next.grid, prospective).tiles.map((t) => tileKey(t.col, t.row)),
  );
  const unsafe = new Set([...danger, ...blastKeys]);
  const escape = fleeDir(next.grid, [...bombs, prospective], bot.col, bot.row, unsafe);
  if (!escape || random() >= BOT_BOMB_CHANCE) {
    return false;
  }
  // Drop the bomb AND immediately step onto the escape route in the same
  // tick — sitting on the bomb tile even one step is how bots blow
  // themselves up.
  addBomb(next, bot.id, bot.col, bot.row, stats, now);
  moveBot(bot, neighborOf(bot.col, bot.row, escape), now);
  return true;
};

/** Wander toward the nearest enemy (fallback: nearest crate to dig through).
 *  Only ever step onto a safe tile — if the sole neighbour is a tile that's
 *  about to explode (e.g. waiting out our own bomb), hold. Prefer tiles no
 *  other fighter is on so bots don't stack/clip; fall back to any safe tile
 *  rather than freezing. */
const botWander = (ctx: BotContext, bot: Bot): void => {
  const { next, humans, now, random, danger, enemies } = ctx;
  const opts = botNeighbors(next, bot.col, bot.row);
  const safeOpts = opts.filter((o) => !danger.has(o.key));
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

/** One bot's turn. Returns true if the bot record changed. */
const tickBot = (ctx: BotContext, bot: Bot): boolean => {
  const { next, now, danger } = ctx;
  if (next.deaths[bot.id]) {
    if (bot.moving) {
      bot.moving = false;
      return true;
    }
    return false;
  }
  if (now < bot.nextMoveAt) {
    return false;
  }
  const stats = next.stats[bot.id] ?? baseStats();
  const bombs = Object.values(next.bombs);
  if (danger.has(tileKey(bot.col, bot.row))) {
    // Step toward the nearest safe tile (BFS) — a single safe neighbour
    // often doesn't exist next to one's own bomb, but a 2-3 step path does.
    const dir = fleeDir(next.grid, bombs, bot.col, bot.row, danger);
    moveBot(bot, dir ? neighborOf(bot.col, bot.row, dir) : null, now);
    return true;
  }
  if (botAttack(ctx, bot, stats, bombs)) {
    return true;
  }
  botWander(ctx, bot);
  return true;
};

/** Returns true if any bot moved or placed a bomb. */
const tickBots = (
  next: SharedState,
  humans: readonly Human[],
  now: number,
  random: () => number,
): boolean => {
  const bots = Object.values(next.bots);
  if (bots.length === 0) {
    return false;
  }
  const ctx: BotContext = {
    danger: dangerSet(next),
    enemies: fighterPositions(next, humans),
    humans,
    next,
    now,
    random,
  };
  let changed = false;
  for (const bot of bots) {
    if (tickBot(ctx, bot)) {
      changed = true;
    }
  }
  return changed;
};

// ---- tick phases ------------------------------------------------------------

/**
 * Keep bots filling the spawn corners humans don't occupy, up to
 * TARGET_FIGHTERS total. Humans take corners 0..n-1 (by join order), bots
 * take the rest. Bots are keyed by corner so join/leave stays stable.
 */
const reconcileBots = (next: SharedState, humanCount: number, now: number, d: Dirty): void => {
  const want = new Set<number>();
  for (
    let c = humanCount;
    c <= 3 && c - humanCount < MAX_BOTS && want.size < TARGET_FIGHTERS - humanCount;
    c += 1
  ) {
    want.add(c);
  }
  // A dropped bot's stats/deaths get swept by the catch-all prune in hostTick.
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

/** Prune stats/deaths for fighters that no longer exist (departed humans or
 *  removed bots) so the shared object can't grow unbounded over a session. */
const pruneDeparted = (next: SharedState, activeIds: Set<string>, d: Dirty): void => {
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

/** Chain every expired bomb through the bombs its blast reaches. */
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

/** Detonate expired bombs: clear the crates they hit, burn the powerups they
 *  cover, and roll drops for the cleared crates. */
const detonateExpired = (
  s: SharedState,
  next: SharedState,
  now: number,
  random: () => number,
  d: Dirty,
): void => {
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

const expireBlasts = (next: SharedState, now: number, d: Dirty): void => {
  const live = keepKeys(next.blasts, (_id, blast) => now - blast.placedAt < EXPLOSION_MS);
  if (live !== next.blasts) {
    next.blasts = live;
    d.blasts = true;
  }
};

/** Grant the powerup under each living fighter. Only the authoritative grant
 *  emits a pickup beat — a blast deleting a pickup produces no collection
 *  feedback, even at capped stats. */
const collectPowerups = (next: SharedState, livePos: Position[], d: Dirty): Pickup[] => {
  const pickups: Pickup[] = [];
  for (const [fid, col, row] of livePos) {
    const key = tileKey(col, row);
    const pu = next.powerups[key];
    if (!pu) {
      continue;
    }
    next.stats[fid] = grantPowerup(next.stats[fid] ?? baseStats(), pu.kind);
    next.powerups = keepKeys(next.powerups, (k) => k !== key);
    pickups.push({ col, collector: fid, kind: pu.kind, round: next.startedAt, row });
    d.powerups = true;
    d.stats = true;
  }
  return pickups;
};

/** Deaths from live blasts. */
const applyBlastDeaths = (next: SharedState, livePos: Position[], now: number, d: Dirty): void => {
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

/** Last fighter standing wins (bots count — solo + bots still resolves). */
const resolveWinner = (next: SharedState, fighterIds: string[], d: Dirty): void => {
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

const buildPatch = (next: SharedState, d: Dirty): Partial<SharedState> | null => {
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

// ---- public API -------------------------------------------------------------

export const hostTick = (
  s: SharedState,
  humans: readonly Human[],
  now: number,
  random: () => number = Math.random,
): HostTickResult => {
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

  // Bot AI moves bots and may place bot bombs (into next.bombs).
  if (tickBots(next, humans, now, random)) {
    d.bots = true;
    d.bombs = true;
  }

  // Positions of every living fighter (humans from connections, bots from
  // the freshly-moved bot records), for pickups + death.
  const livePos = fighterPositions(next, humans);
  const pickups = collectPowerups(next, livePos, d);
  applyBlastDeaths(next, livePos, now, d);
  resolveWinner(next, [...humanIds, ...Object.keys(next.bots)], d);

  return { patch: buildPatch(next, d), pickups };
};

/** A human's bomb request: the new bombs record, or null when the rules refuse it. */
export const placeBomb = (
  s: SharedState,
  ownerId: string,
  col: number,
  row: number,
  now: number,
): Record<string, Bomb> | null => {
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
  const bomb = makeBomb(ownerId, col, row, stats.range, now);
  return { ...s.bombs, [bomb.id]: bomb };
};
