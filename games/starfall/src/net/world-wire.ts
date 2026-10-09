import { BOOSTER_KINDS, SHIELD_MOD_KINDS, UFO_SPEED, WEAPONS_SPECIAL } from "../shared/constants";
import type {
  AsteroidState,
  BeaconState,
  EnemyKind,
  EnemyShotState,
  EnemyState,
  ItemDrop,
  ItemState,
  PullState,
  ShardState,
  SharedState,
  UfoState,
  Vec,
} from "../shared/constants";
import { q1, q2 } from "../shared/wire";
import { asWireRecord, wireNum, wireStr } from "./wire-read";
import type { WireRecord, WireValue } from "./wire-read";

/**
 * The host's world on the wire.
 *
 * Shared state travels as path ops — the leaves that changed — so the world
 * is shaped for that: an entity's row is only rewritten when something a
 * guest cannot extrapolate changed, and the SDK sends just that row, or just
 * the one field.
 *
 * - `arenaEpoch`: server time at the arena's start. Every other time in the
 *   world rides as arena time, ms since that epoch, so a row never changes by
 *   itself. The host keeps the epoch where its server clock puts it
 *   (EPOCH_TRACK_MS), and each client maps arena time onto its own sim clock
 *   through the epoch as its server clock reads it now: a clock estimate
 *   revised after the arena began moves the epoch, never the rows.
 * - Movers keyed by id — asteroids `as`, enemy shots `es`, shards `sh`, items
 *   `it` — as `[t, x, y, vx, vy, …]`: the position at arena time `t`, then the
 *   velocity and what else the row carries. A guest ages each row to its own
 *   now. The host rewrites a row when the entity turns, changes, or drifts
 *   from the line the row describes (DRIFT_PX); a spawn adds a key and a
 *   removal deletes one.
 * - The UFO `uf` (one row, cruising to its destination), the beacon `bc` (one
 *   row) and pulls `pl` (keyed) hold their deadlines in arena time.
 * - `ec`: every enemy's details (kind, hp, telegraphs, lances), keyed, with
 *   arena-time deadlines: a hit or a telegraph is one leaf.
 * - `en`: every enemy's motion, `[t, rows]` — steering changes it every tick,
 *   so the whole set goes each share, as an array (the smallest whole).
 * - `playW`, `playH`, `sectorBossIdx`: primitives.
 * - `sb`: every present player's sector score, `[id, pts, id, pts, …]`,
 *   relayed a couple of times a second (HostDirector) — only the host sees
 *   every player, and guests rank the ones out of their interest range by
 *   it (render/hud.ts).
 *
 * The encoder keeps nothing: what guests hold is the room's state, so each
 * share compares the host's world with it and reuses every row that still
 * holds. A promoted host carries on from the rows the old one wrote, and the
 * server's copy is what a late joiner receives.
 */

export const EPOCH_KEY = "arenaEpoch";
export const ASTEROIDS_KEY = "as";
export const SHOTS_KEY = "es";
export const SHARDS_KEY = "sh";
export const ITEMS_KEY = "it";
export const PULLS_KEY = "pl";
export const UFO_KEY = "uf";
export const BEACON_KEY = "bc";
export const DETAILS_KEY = "ec";
export const HOT_KEY = "en";
export const STANDINGS_KEY = "sb";

/** A mover whose position strays this far from the line its row describes
 *  (px) is rewritten: a long frame on the host, or the row's rounding. */
export const DRIFT_PX = 6;
/** The room's epoch follows the host's server clock to within this (ms): it
 *  moves when the clock's estimate is revised, never for rounding. Arena
 *  times never move with it, so the rows stand and every client re-maps
 *  them through the epoch it now reads. */
export const EPOCH_TRACK_MS = 3;

/** Enemy kinds by wire index. */
const ENEMY_KIND_CODES: readonly EnemyKind[] = [
  "drone",
  "wasp",
  "lancer",
  "splitter",
  "warden",
  "sniper",
  "spawner",
  "dreadnought",
];
const ITEM_KIND_CODES: readonly ItemState["kind"][] = ["weapon", "shield", "booster"];

const itemDropIdx = (it: ItemDrop): number => {
  if (it.kind === "weapon") {
    return it.weaponIdx;
  }
  return it.kind === "shield" ? it.shieldIdx : it.boosterIdx;
};

/** Advance a UFO up to `step` px toward its destination; it parks there
 *  (only the host picks the next one). */
export const stepUfo = (u: Vec & { destX: number; destY: number }, step: number): void => {
  const dx = u.destX - u.x;
  const dy = u.destY - u.y;
  const dist = Math.hypot(dx, dy);
  if (dist > step) {
    u.x += (dx / dist) * step;
    u.y += (dy / dist) * step;
  } else {
    u.x = u.destX;
    u.y = u.destY;
  }
};

// ---- host side: encode ---------------------------------------------------------------

/** A mover family: its key, its entities, and the row fields after the motion. */
interface MoverFamily<T extends { id: string; x: number; y: number; vx: number; vy: number }> {
  key: string;
  list: readonly T[];
  /** Velocity as the row carries it. */
  qv: (v: number) => number;
  /** Everything after the motion (radius, expiry, kind): a change rewrites the row. */
  tail: (e: T) => WireValue[];
}

/** The row in `prev` if it still describes `fresh`: same velocity and tail,
 *  and its line still passes within DRIFT_PX of where the entity is. */
const holds = (prev: WireValue | undefined, fresh: WireValue[]): boolean => {
  if (!Array.isArray(prev) || prev.length !== fresh.length) {
    return false;
  }
  for (let i = 3; i < fresh.length; i += 1) {
    if (!sameValue(prev[i], fresh[i])) {
      return false;
    }
  }
  const [t, x, y, vx, vy] = nums(prev, 0, 5) ?? [];
  const [now, fx, fy] = fresh;
  if (
    t === undefined ||
    x === undefined ||
    y === undefined ||
    vx === undefined ||
    vy === undefined
  ) {
    return false;
  }
  const dt = (Number(now) - t) / 1000;
  return (
    Math.abs(x + vx * dt - Number(fx)) <= DRIFT_PX && Math.abs(y + vy * dt - Number(fy)) <= DRIFT_PX
  );
};

/** Equal as JSON leaves: numbers, strings, booleans, null, and flat arrays of them. */
const sameValue = (a: WireValue | undefined, b: WireValue | undefined): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
};

/** The family's rows: each entity's row from the room when it still holds,
 *  else a fresh one positioned at `at`. */
const encodeMovers = <T extends { id: string; x: number; y: number; vx: number; vy: number }>(
  room: WireRecord,
  at: number,
  family: MoverFamily<T>,
): WireRecord => {
  const held = asWireRecord(room[family.key]);
  const out: WireRecord = {};
  for (const e of family.list) {
    const fresh = [
      at,
      Math.round(e.x),
      Math.round(e.y),
      family.qv(e.vx),
      family.qv(e.vy),
      ...family.tail(e),
    ];
    const prev = held?.[e.id];
    out[e.id] = prev !== undefined && holds(prev, fresh) ? prev : fresh;
  }
  return out;
};

const flatLances = (lances: readonly Vec[]): number[] =>
  lances.flatMap((p) => [Math.round(p.x), Math.round(p.y)]);

/**
 * This share's world patch. `now` is the host's sim clock, `stamp` the
 * server time at that instant, and `room` the room's state as this client
 * holds it — what every guest holds once this patch lands.
 */
export const encodeWorld = (
  w: SharedState,
  now: number,
  stamp: number,
  room: WireRecord,
): WireRecord => {
  // Arena time 0 as server time, by this host's clock as it reads it now;
  // the room's value stays while it agrees. Every arena time below counts
  // from it.
  const fresh = stamp + Math.round(w.arenaEpoch - now);
  const roomEpoch = wireNum(room[EPOCH_KEY]);
  const epoch =
    roomEpoch !== null && Math.abs(roomEpoch - fresh) <= EPOCH_TRACK_MS ? roomEpoch : fresh;
  /** A sim-clock moment in arena time. */
  const arena = (simT: number): number => Math.round(simT - w.arenaEpoch);
  /** An optional deadline: 0 is none. */
  const arenaOpt = (simT: number): number => (simT <= 0 ? 0 : Math.max(1, arena(simT)));
  const at = arena(now);
  const patch: WireRecord = {
    [EPOCH_KEY]: epoch,
    playH: w.playH,
    playW: w.playW,
    sectorBossIdx: w.sectorBossIdx,
  };
  patch[ASTEROIDS_KEY] = encodeMovers(room, at, {
    key: ASTEROIDS_KEY,
    list: w.asteroids,
    qv: q1,
    tail: (a) => [q1(a.radius)],
  });
  patch[SHOTS_KEY] = encodeMovers(room, at, {
    key: SHOTS_KEY,
    list: w.enemyShots,
    qv: Math.round,
    tail: (s) => [arena(s.diesAt)],
  });
  patch[SHARDS_KEY] = encodeMovers(room, at, {
    key: SHARDS_KEY,
    list: w.shards,
    qv: q1,
    tail: (s) => [arena(s.diesAt)],
  });
  patch[ITEMS_KEY] = encodeMovers(room, at, {
    key: ITEMS_KEY,
    list: w.items,
    qv: q1,
    tail: (it) => [arena(it.diesAt), ITEM_KIND_CODES.indexOf(it.kind), itemDropIdx(it)],
  });
  const pulls: WireRecord = {};
  for (const p of w.pulls) {
    pulls[p.id] = [Math.round(p.x), Math.round(p.y), arena(p.until)];
  }
  patch[PULLS_KEY] = pulls;
  patch[UFO_KEY] = w.ufo ? encodeUfo(w.ufo, at, arenaOpt(w.ufo.blinkUntil), room[UFO_KEY]) : null;
  const b = w.beacon;
  patch[BEACON_KEY] = b
    ? [
        Math.round(b.x),
        Math.round(b.y),
        arena(b.activeAt),
        arena(b.diesAt),
        b.controllerId ?? "",
        b.contested ? 1 : 0,
      ]
    : null;
  const details: WireRecord = {};
  for (const e of w.enemies) {
    details[e.id] = [
      ENEMY_KIND_CODES.indexOf(e.kind),
      q1(e.hp),
      Math.round(e.maxHp),
      e.shielded ? 1 : 0,
      arenaOpt(e.telegraphUntil),
      arenaOpt(e.chargeUntil),
      arenaOpt(e.attackAt),
      arenaOpt(e.blinkUntil),
      arenaOpt(e.graceUntil),
      flatLances(e.lances),
    ];
  }
  patch[DETAILS_KEY] = details;
  // An empty set goes once; after that, no enemies costs nothing.
  const hot = readHot(room[HOT_KEY]);
  if (w.enemies.length > 0 || hot === null || hot.rows.length > 0) {
    patch[HOT_KEY] = [at, w.enemies.map(enemyHotRow)];
  }
  return patch;
};

/** The UFO's row: the room's while it still describes the cruise. */
const encodeUfo = (
  u: UfoState,
  at: number,
  blink: number,
  prev: WireValue | undefined,
): WireValue => {
  const fresh = [
    u.id,
    at,
    Math.round(u.x),
    Math.round(u.y),
    Math.round(u.destX),
    Math.round(u.destY),
    q1(u.hp),
    blink,
  ];
  const was = readUfoRow(prev, 0);
  if (!was || !Array.isArray(prev) || was.e.id !== u.id) {
    return fresh;
  }
  for (const i of [4, 5, 6, 7]) {
    if (prev[i] !== fresh[i]) {
      return fresh;
    }
  }
  stepUfo(was.e, (UFO_SPEED * (at - was.at)) / 1000);
  return Math.abs(was.e.x - u.x) <= DRIFT_PX && Math.abs(was.e.y - u.y) <= DRIFT_PX ? prev : fresh;
};

const enemyHotRow = (e: EnemyState): WireValue[] => [
  e.id,
  Math.round(e.x),
  Math.round(e.y),
  Math.round(e.vx),
  Math.round(e.vy),
  q2(e.angle),
];

// ---- guest side: decode ------------------------------------------------------------

/** A decoded row: the entity, positioned at sim time `at`, with its
 *  deadlines on the same clock. */
export interface Aged<T> {
  at: number;
  e: T;
}

/** The relayed standings (`sb`): player id → sector score. */
export const readStandings = (v: WireValue | undefined): Map<string, number> => {
  const out = new Map<string, number>();
  if (Array.isArray(v)) {
    for (let i = 0; i + 1 < v.length; i += 2) {
      const id = wireStr(v[i]);
      const pts = wireNum(v[i + 1]);
      if (id !== null && pts !== null) {
        out.set(id, pts);
      }
    }
  }
  return out;
};

/** A room that holds a Starfall world (an arena epoch). */
export const isWorld = (s: WireRecord): boolean => wireNum(s[EPOCH_KEY]) !== null;

/** One decode's instant on both clocks: the sim clock the world is kept in
 *  (shared/clock.ts) and server time, which the arena epoch is in. */
export interface WireClock {
  now: number;
  serverNow: number;
}

/** A server-time moment on this client's sim clock. */
export const toSim = (serverT: number, clock: WireClock): number =>
  clock.now + (serverT - clock.serverNow);

const nums = (row: WireValue[], from: number, count: number): number[] | null => {
  const out: number[] = [];
  for (let i = from; i < from + count; i += 1) {
    const n = wireNum(row[i]);
    if (n === null) {
      return null;
    }
    out.push(n);
  }
  return out;
};

/** An optional arena-time deadline on the sim clock (0 = none). */
const optTime = (rel: number | null, epoch: number): number =>
  rel === null || rel === 0 ? 0 : epoch + rel;

/** A mover row's motion: `[t, x, y, vx, vy, …]` with `t` mapped through `epoch`. */
const readMotion = (
  row: WireValue | undefined,
  epoch: number,
): { at: number; x: number; y: number; vx: number; vy: number; rest: WireValue[] } | null => {
  if (!Array.isArray(row)) {
    return null;
  }
  const [t, x, y, vx, vy] = nums(row, 0, 5) ?? [];
  if (
    t === undefined ||
    x === undefined ||
    y === undefined ||
    vx === undefined ||
    vy === undefined
  ) {
    return null;
  }
  return { at: epoch + t, rest: row.slice(5), vx, vy, x, y };
};

export const readAsteroidRow = (
  id: string,
  row: WireValue | undefined,
  epoch: number,
): Aged<AsteroidState> | null => {
  const m = readMotion(row, epoch);
  const radius = wireNum(m?.rest[0]);
  if (!m || radius === null) {
    return null;
  }
  return { at: m.at, e: { id, radius, rot: 0, vx: m.vx, vy: m.vy, x: m.x, y: m.y } };
};

export const readShotRow = (
  id: string,
  row: WireValue | undefined,
  epoch: number,
): Aged<EnemyShotState> | null => {
  const m = readMotion(row, epoch);
  const dies = wireNum(m?.rest[0]);
  if (!m || dies === null) {
    return null;
  }
  return { at: m.at, e: { diesAt: epoch + dies, id, vx: m.vx, vy: m.vy, x: m.x, y: m.y } };
};

export const readShardRow = (
  id: string,
  row: WireValue | undefined,
  epoch: number,
): Aged<ShardState> | null => readShotRow(id, row, epoch);

export const readItemRow = (
  id: string,
  row: WireValue | undefined,
  epoch: number,
): Aged<ItemState> | null => {
  const shot = readShotRow(id, row, epoch);
  if (!shot || !Array.isArray(row)) {
    return null;
  }
  const kind = ITEM_KIND_CODES[wireNum(row[6]) ?? -1];
  const idx = wireNum(row[7]);
  if (!kind || idx === null) {
    return null;
  }
  const base = shot.e;
  if (kind === "weapon") {
    return WEAPONS_SPECIAL[idx] ? { at: shot.at, e: { ...base, kind, weaponIdx: idx } } : null;
  }
  if (kind === "shield") {
    return SHIELD_MOD_KINDS[idx] ? { at: shot.at, e: { ...base, kind, shieldIdx: idx } } : null;
  }
  return BOOSTER_KINDS[idx] ? { at: shot.at, e: { ...base, boosterIdx: idx, kind } } : null;
};

export const readPullRow = (
  id: string,
  row: WireValue | undefined,
  epoch: number,
): PullState | null => {
  if (!Array.isArray(row)) {
    return null;
  }
  const [x, y, until] = nums(row, 0, 3) ?? [];
  if (x === undefined || y === undefined || until === undefined) {
    return null;
  }
  return { id, until: epoch + until, x, y };
};

export const readUfoRow = (row: WireValue | undefined, epoch: number): Aged<UfoState> | null => {
  if (!Array.isArray(row)) {
    return null;
  }
  const id = wireStr(row[0]);
  const [t, x, y, destX, destY, hp] = nums(row, 1, 6) ?? [];
  if (
    id === null ||
    t === undefined ||
    x === undefined ||
    y === undefined ||
    destX === undefined ||
    destY === undefined ||
    hp === undefined
  ) {
    return null;
  }
  return {
    at: epoch + t,
    e: { blinkUntil: optTime(wireNum(row[7]), epoch), destX, destY, hp, id, x, y },
  };
};

export const readBeaconRow = (row: WireValue | undefined, epoch: number): BeaconState | null => {
  if (!Array.isArray(row)) {
    return null;
  }
  const [x, y, activeAt, diesAt] = nums(row, 0, 4) ?? [];
  if (x === undefined || y === undefined || activeAt === undefined || diesAt === undefined) {
    return null;
  }
  const controller = wireStr(row[4]);
  return {
    activeAt: epoch + activeAt,
    contested: row[5] === 1,
    controllerId: controller || null,
    diesAt: epoch + diesAt,
    x,
    y,
  };
};

/** `en`: every enemy's motion at arena time `t`. */
export const readHot = (v: WireValue | undefined): { t: number; rows: WireValue[] } | null => {
  if (!Array.isArray(v)) {
    return null;
  }
  const [stamp, rows] = v;
  const t = wireNum(stamp);
  return t === null || !Array.isArray(rows) ? null : { rows, t };
};

/** `en` row: an enemy's motion as of the set's arena time. */
export interface EnemyMotion {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

export const readEnemyMotion = (row: WireValue): EnemyMotion | null => {
  if (!Array.isArray(row)) {
    return null;
  }
  const id = wireStr(row[0]);
  const [x, y, vx, vy, angle] = nums(row, 1, 5) ?? [];
  if (
    id === null ||
    x === undefined ||
    y === undefined ||
    vx === undefined ||
    vy === undefined ||
    angle === undefined
  ) {
    return null;
  }
  return { angle, id, vx, vy, x, y };
};

/** `ec` row: everything about an enemy but its motion. */
export type EnemyDetail = Omit<EnemyState, "x" | "y" | "vx" | "vy" | "angle">;

export const readEnemyDetail = (
  id: string,
  row: WireValue | undefined,
  epoch: number,
): EnemyDetail | null => {
  if (!Array.isArray(row)) {
    return null;
  }
  const kind = ENEMY_KIND_CODES[wireNum(row[0]) ?? -1];
  const hp = wireNum(row[1]);
  const maxHp = wireNum(row[2]);
  if (!kind || hp === null || maxHp === null) {
    return null;
  }
  const lances: Vec[] = [];
  const rawLances = row.at(9);
  if (Array.isArray(rawLances)) {
    for (let i = 0; i + 1 < rawLances.length; i += 2) {
      const lx = wireNum(rawLances[i]);
      const ly = wireNum(rawLances[i + 1]);
      if (lx !== null && ly !== null) {
        lances.push({ x: lx, y: ly });
      }
    }
  }
  return {
    attackAt: optTime(wireNum(row[6]), epoch),
    blinkUntil: optTime(wireNum(row[7]), epoch),
    chargeUntil: optTime(wireNum(row[5]), epoch),
    graceUntil: optTime(wireNum(row[8]), epoch),
    hp,
    id,
    kind,
    lances,
    maxHp,
    shielded: row[3] === 1,
    telegraphUntil: optTime(wireNum(row[4]), epoch),
  };
};
