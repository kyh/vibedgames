import {
  ASTEROID_CULL_MARGIN,
  BOOSTER_KINDS,
  SHIELD_MOD_KINDS,
  WEAPONS_SPECIAL,
} from "../shared/constants";
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
import { inWorld } from "../sys/geometry";
import { wireNum, wireStr } from "./wire-read";
import type { WireRecord, WireValue } from "./wire-read";

/**
 * The host's world on the wire.
 *
 * Shared state merges key by key and an object or array key is re-sent whole
 * whenever it is written, so the world is cut into small keys, each written
 * only when something in it changed:
 *
 * - `t`: the host's sim clock at the send. Every patch carries it; a guest's
 *   HostClock learns the host's time from it.
 * - Row buckets `[stamp, rows]` (asteroids `as0..3`, enemy shots `es0..15`,
 *   shards `sh0..3`, items `it0`, pulls `pl0`, the UFO `uf0`, the beacon
 *   `bc0`, enemy details `ec0..15`). An entity lives in the bucket its id
 *   hashes to; a bucket is re-sent when one of its entities spawns, turns or
 *   is taken — never for motion a guest can extrapolate, and never for an
 *   expiry or edge cull every client applies by itself. Positions are as of
 *   the stamp and times are relative to it, so a guest ages each row by the
 *   host clock before comparing it with its own copy.
 * - `en`: every enemy's position, velocity and heading — steering changes
 *   them each tick, so this one row set goes every tick.
 * - `arenaEpoch`, `playW`, `playH`, `sectorBossIdx`: primitives, which the
 *   SDK only sends when they change.
 *
 * The server keeps the last value of every key, so a late joiner (and a guest
 * promoted to host) still receives the whole world.
 */

export const STAMP_KEY = "t";
export const HOT_KEY = "en";

/** A row bucket family: key prefix and how many buckets its entities hash into. */
export interface BucketFamily {
  readonly key: string;
  readonly buckets: number;
}

export const ASTEROIDS: BucketFamily = { buckets: 4, key: "as" };
export const SHOTS: BucketFamily = { buckets: 16, key: "es" };
export const SHARDS: BucketFamily = { buckets: 4, key: "sh" };
export const ITEMS: BucketFamily = { buckets: 1, key: "it" };
export const PULLS: BucketFamily = { buckets: 1, key: "pl" };
export const UFO: BucketFamily = { buckets: 1, key: "uf" };
export const BEACON: BucketFamily = { buckets: 1, key: "bc" };
export const ENEMY_DETAILS: BucketFamily = { buckets: 16, key: "ec" };

/** Straight movers drift from the host after a long frame on either side;
 *  each of their buckets is re-sent on a slow round robin to pull them back. */
const DRIFTING: readonly BucketFamily[] = [ASTEROIDS, SHOTS, SHARDS, ITEMS, UFO];
/** One drifting bucket refreshes every this many shares (~2.6 s per cycle). */
const REFRESH_EVERY = 2;
/** Past timestamps older than this ride as "none" (recoil and blink read at
 *  most ~0.4 s back). */
const STALE_MS = 2000;
/** An entity gone this close to its expiry left on its own. */
const EXPIRY_SLACK_MS = 150;

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

export const bucketKey = (family: BucketFamily, bucket: number): string => `${family.key}${bucket}`;

/** Stable bucket for an id (any client computes the same one). */
export const bucketOf = (id: string, buckets: number): number => {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + (id.codePointAt(i) ?? 0)) % 65_521;
  }
  return h % buckets;
};

/** A host deadline relative to a stamp, for one that may be absent: 0 is
 *  "none", so a deadline landing exactly on the stamp rides as -1. */
const relOpt = (v: number, t: number): number => {
  if (v <= 0) {
    return 0;
  }
  const r = Math.round(v - t);
  if (r < -STALE_MS) {
    return 0;
  }
  return r === 0 ? -1 : r;
};

const itemDropIdx = (it: ItemDrop): number => {
  if (it.kind === "weapon") {
    return it.weaponIdx;
  }
  return it.kind === "shield" ? it.shieldIdx : it.boosterIdx;
};

/** What the host last sent for one entity: its signature (what a guest can't
 *  extrapolate) and enough motion to tell an expiry from a removal. */
interface Sent {
  sig: string;
  bucket: number;
  diesAt: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
}

/** An entity the encoder can track: an id and a position (motion optional). */
interface Trackable {
  id: string;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  diesAt?: number;
}

interface Tracking<T extends Trackable> {
  family: BucketFamily;
  list: readonly T[];
  /** Everything a guest cannot extrapolate from the last row. */
  sig: (e: T) => string;
  row: (e: T, t: number) => WireValue[];
  /** Edge cull margin for a removal every client applies itself; Infinity for none. */
  cullMargin: number;
}

/** Host side: turns the working world into this tick's patch. */
export class WorldEncoder {
  private readonly sent = new Map<string, Map<string, Sent>>();
  private readonly dirty = new Set<string>();
  private shares = 0;
  private refreshCursor = 0;
  /** Enemies in the last hot row set (an empty set is sent once). */
  private hotCount = 0;

  /** Forget what guests hold: the next patch carries every bucket. */
  reset(): void {
    this.sent.clear();
    this.hotCount = -1;
    for (const family of [...DRIFTING, PULLS, BEACON, ENEMY_DETAILS]) {
      for (let i = 0; i < family.buckets; i += 1) {
        this.dirty.add(bucketKey(family, i));
      }
    }
  }

  encode(w: SharedState, now: number): WireRecord {
    const t = Math.round(now);
    const patch: WireRecord = {};
    patch[STAMP_KEY] = t;
    patch["arenaEpoch"] = Math.round(w.arenaEpoch);
    patch["playW"] = w.playW;
    patch["playH"] = w.playH;
    patch["sectorBossIdx"] = w.sectorBossIdx;
    this.shares += 1;
    if (this.shares % REFRESH_EVERY === 0) {
      this.queueRefresh();
    }
    this.track(patch, w, t, {
      cullMargin: ASTEROID_CULL_MARGIN,
      family: ASTEROIDS,
      list: w.asteroids,
      row: (a) => [a.id, Math.round(a.x), Math.round(a.y), q1(a.vx), q1(a.vy), q1(a.radius)],
      sig: (a) => `${q1(a.vx)},${q1(a.vy)},${q1(a.radius)}`,
    });
    this.track(patch, w, t, {
      cullMargin: 60,
      family: SHOTS,
      list: w.enemyShots,
      row: (s, at) => [
        s.id,
        Math.round(s.x),
        Math.round(s.y),
        Math.round(s.vx),
        Math.round(s.vy),
        Math.round(s.diesAt - at),
      ],
      sig: (s) => `${Math.round(s.vx)},${Math.round(s.vy)},${Math.round(s.diesAt)}`,
    });
    this.track(patch, w, t, {
      cullMargin: Infinity,
      family: SHARDS,
      list: w.shards,
      row: (s, at) => [
        s.id,
        Math.round(s.x),
        Math.round(s.y),
        q1(s.vx),
        q1(s.vy),
        Math.round(s.diesAt - at),
      ],
      sig: (s) => `${q1(s.vx)},${q1(s.vy)},${Math.round(s.diesAt)}`,
    });
    this.track(patch, w, t, {
      cullMargin: Infinity,
      family: ITEMS,
      list: w.items,
      row: (it, at) => [
        it.id,
        Math.round(it.x),
        Math.round(it.y),
        q1(it.vx),
        q1(it.vy),
        Math.round(it.diesAt - at),
        ITEM_KIND_CODES.indexOf(it.kind),
        itemDropIdx(it),
      ],
      sig: (it) => `${q1(it.vx)},${q1(it.vy)},${Math.round(it.diesAt)},${it.kind}`,
    });
    this.track(patch, w, t, {
      cullMargin: Infinity,
      family: PULLS,
      list: w.pulls.map((p) => ({ ...p, diesAt: p.until })),
      row: (p, at) => [p.id, Math.round(p.x), Math.round(p.y), Math.round(p.until - at)],
      sig: (p) => `${Math.round(p.until)}`,
    });
    this.track(patch, w, t, {
      cullMargin: Infinity,
      family: UFO,
      list: w.ufo ? [w.ufo] : [],
      row: (u, at) => [
        u.id,
        Math.round(u.x),
        Math.round(u.y),
        Math.round(u.destX),
        Math.round(u.destY),
        q1(u.hp),
        relOpt(u.blinkUntil, at),
      ],
      sig: (u) => `${Math.round(u.destX)},${Math.round(u.destY)},${q1(u.hp)},${u.blinkUntil}`,
    });
    const b = w.beacon;
    this.track(patch, w, t, {
      cullMargin: Infinity,
      family: BEACON,
      list: b ? [{ ...b, id: "beacon" }] : [],
      row: (bc, at) => [
        Math.round(bc.x),
        Math.round(bc.y),
        Math.round(bc.activeAt - at),
        Math.round(bc.diesAt - at),
        bc.controllerId ?? "",
        bc.contested ? 1 : 0,
      ],
      sig: (bc) =>
        `${Math.round(bc.x)},${Math.round(bc.y)},${bc.activeAt},${bc.diesAt},${bc.controllerId},${bc.contested}`,
    });
    // Details first, so a guest meets a new enemy's kind with its first pose.
    this.track(patch, w, t, {
      cullMargin: -1,
      family: ENEMY_DETAILS,
      list: w.enemies,
      row: enemyDetailRow,
      sig: enemyDetailSig,
    });
    if (w.enemies.length > 0 || this.hotCount !== 0) {
      patch[HOT_KEY] = [t, w.enemies.map(enemyHotRow)];
      this.hotCount = w.enemies.length;
    }
    return patch;
  }

  private queueRefresh(): void {
    let n = this.refreshCursor;
    for (const family of DRIFTING) {
      if (n < family.buckets) {
        this.dirty.add(bucketKey(family, n));
        this.refreshCursor += 1;
        return;
      }
      n -= family.buckets;
    }
    this.refreshCursor = 0;
  }

  /** Diff one family against what was sent, then write its dirty buckets. */
  private track<T extends Trackable>(
    patch: WireRecord,
    w: SharedState,
    t: number,
    spec: Tracking<T>,
  ): void {
    const { family } = spec;
    let sent = this.sent.get(family.key);
    if (!sent) {
      sent = new Map();
      this.sent.set(family.key, sent);
    }
    const live = new Set<string>();
    for (const e of spec.list) {
      live.add(e.id);
      const sig = spec.sig(e);
      const prev = sent.get(e.id);
      if (prev && prev.sig === sig) {
        continue;
      }
      const bucket = bucketOf(e.id, family.buckets);
      this.dirty.add(bucketKey(family, bucket));
      sent.set(e.id, {
        bucket,
        diesAt: e.diesAt ?? 0,
        sig,
        t,
        vx: e.vx ?? 0,
        vy: e.vy ?? 0,
        x: e.x,
        y: e.y,
      });
    }
    for (const [id, prev] of sent) {
      if (live.has(id)) {
        continue;
      }
      sent.delete(id);
      // Enemy details never need a removal: `en` names who is alive.
      if (spec.cullMargin >= 0 && !culledByItself(prev, spec.cullMargin, w, t)) {
        this.dirty.add(bucketKey(family, prev.bucket));
      }
    }
    for (let i = 0; i < family.buckets; i += 1) {
      const key = bucketKey(family, i);
      if (!this.dirty.delete(key)) {
        continue;
      }
      const rows: WireValue[] = [];
      for (const e of spec.list) {
        if (family.buckets === 1 || bucketOf(e.id, family.buckets) === i) {
          rows.push(spec.row(e, t));
        }
      }
      patch[key] = [t, rows];
    }
  }
}

/** Would every client drop this entity on its own by now — expired, or
 *  flown past the edge cull? Then its removal needs no resend. */
const culledByItself = (prev: Sent, margin: number, w: SharedState, now: number): boolean => {
  if (prev.diesAt > 0 && prev.diesAt <= now + EXPIRY_SLACK_MS) {
    return true;
  }
  if (!Number.isFinite(margin)) {
    return false;
  }
  const dt = (now - prev.t) / 1000;
  return !inWorld(prev.x + prev.vx * dt, prev.y + prev.vy * dt, margin, w.playW, w.playH);
};

const enemyHotRow = (e: EnemyState): WireValue[] => [
  e.id,
  Math.round(e.x),
  Math.round(e.y),
  Math.round(e.vx),
  Math.round(e.vy),
  q2(e.angle),
];

const flatLances = (lances: readonly Vec[]): number[] =>
  lances.flatMap((p) => [Math.round(p.x), Math.round(p.y)]);

const enemyDetailSig = (e: EnemyState): string =>
  [
    e.kind,
    q1(e.hp),
    e.maxHp,
    e.shielded,
    Math.round(e.telegraphUntil),
    Math.round(e.chargeUntil),
    Math.round(e.attackAt),
    Math.round(e.blinkUntil),
    Math.round(e.graceUntil),
    flatLances(e.lances).join(" "),
  ].join(",");

const enemyDetailRow = (e: EnemyState, t: number): WireValue[] => [
  e.id,
  ENEMY_KIND_CODES.indexOf(e.kind),
  q1(e.hp),
  Math.round(e.maxHp),
  e.shielded ? 1 : 0,
  relOpt(e.telegraphUntil, t),
  relOpt(e.chargeUntil, t),
  relOpt(e.attackAt, t),
  relOpt(e.blinkUntil, t),
  relOpt(e.graceUntil, t),
  flatLances(e.lances),
];

// ---- guest side: decode ------------------------------------------------------------

/** One decoded bucket: its stamp (host clock) and raw rows. */
export interface Bucket {
  t: number;
  rows: WireValue[][];
}

export const readBucket = (v: WireValue | undefined): Bucket | null => {
  if (!Array.isArray(v)) {
    return null;
  }
  const [stamp, rawRows] = v;
  const t = wireNum(stamp);
  if (t === null || !Array.isArray(rawRows)) {
    return null;
  }
  const rows: WireValue[][] = [];
  for (const r of rawRows) {
    if (Array.isArray(r)) {
      rows.push(r);
    }
  }
  return { rows, t };
};

/** A room that holds a Starfall world (a stamp and an arena epoch). */
export const isWorld = (s: WireRecord): boolean =>
  wireNum(s[STAMP_KEY]) !== null && wireNum(s["arenaEpoch"]) !== null;

/** Host time → this client's clock, for one bucket: `at(rel)` is the absolute
 *  local time of a stamp-relative offset. */
export type BucketTime = (rel: number) => number;

/** A relative deadline that may be absent (0 = none). */
const optTime = (rel: number | null, at: BucketTime): number =>
  rel === null || rel === 0 ? 0 : at(rel);

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

export const readAsteroidRow = (row: WireValue[]): AsteroidState | null => {
  const id = wireStr(row[0]);
  const [x, y, vx, vy, radius] = nums(row, 1, 5) ?? [];
  if (
    id === null ||
    x === undefined ||
    y === undefined ||
    vx === undefined ||
    vy === undefined ||
    radius === undefined
  ) {
    return null;
  }
  return { id, radius, rot: 0, vx, vy, x, y };
};

export const readShotRow = (row: WireValue[], at: BucketTime): EnemyShotState | null => {
  const id = wireStr(row[0]);
  const [x, y, vx, vy, ttl] = nums(row, 1, 5) ?? [];
  if (
    id === null ||
    x === undefined ||
    y === undefined ||
    vx === undefined ||
    vy === undefined ||
    ttl === undefined
  ) {
    return null;
  }
  return { diesAt: at(ttl), id, vx, vy, x, y };
};

export const readShardRow = (row: WireValue[], at: BucketTime): ShardState | null =>
  readShotRow(row, at);

export const readItemRow = (row: WireValue[], at: BucketTime): ItemState | null => {
  const base = readShotRow(row, at);
  const kind = ITEM_KIND_CODES[wireNum(row[6]) ?? -1];
  const idx = wireNum(row[7]);
  if (!base || !kind || idx === null) {
    return null;
  }
  if (kind === "weapon") {
    return WEAPONS_SPECIAL[idx] ? { ...base, kind, weaponIdx: idx } : null;
  }
  if (kind === "shield") {
    return SHIELD_MOD_KINDS[idx] ? { ...base, kind, shieldIdx: idx } : null;
  }
  return BOOSTER_KINDS[idx] ? { ...base, boosterIdx: idx, kind } : null;
};

export const readPullRow = (row: WireValue[], at: BucketTime): PullState | null => {
  const id = wireStr(row[0]);
  const [x, y, ttl] = nums(row, 1, 3) ?? [];
  if (id === null || x === undefined || y === undefined || ttl === undefined) {
    return null;
  }
  return { id, until: at(ttl), x, y };
};

export const readUfoRow = (row: WireValue[], at: BucketTime): UfoState | null => {
  const id = wireStr(row[0]);
  const [x, y, destX, destY, hp] = nums(row, 1, 5) ?? [];
  if (
    id === null ||
    x === undefined ||
    y === undefined ||
    destX === undefined ||
    destY === undefined ||
    hp === undefined
  ) {
    return null;
  }
  return { blinkUntil: optTime(wireNum(row[6]), at), destX, destY, hp, id, x, y };
};

export const readBeaconRow = (row: WireValue[], at: BucketTime): BeaconState | null => {
  const [x, y, activeRel, diesRel] = nums(row, 0, 4) ?? [];
  if (x === undefined || y === undefined || activeRel === undefined || diesRel === undefined) {
    return null;
  }
  const controller = wireStr(row[4]);
  return {
    activeAt: at(activeRel),
    contested: row[5] === 1,
    controllerId: controller || null,
    diesAt: at(diesRel),
    x,
    y,
  };
};

/** `en` row: an enemy's motion as of the stamp. */
export interface EnemyMotion {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

export const readEnemyMotion = (row: WireValue[]): EnemyMotion | null => {
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

export const readEnemyDetail = (row: WireValue[], at: BucketTime): EnemyDetail | null => {
  const id = wireStr(row[0]);
  const kind = ENEMY_KIND_CODES[wireNum(row[1]) ?? -1];
  const hp = wireNum(row[2]);
  const maxHp = wireNum(row[3]);
  if (id === null || !kind || hp === null || maxHp === null) {
    return null;
  }
  const lances: Vec[] = [];
  const rawLances = row.at(10);
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
    attackAt: optTime(wireNum(row[7]), at),
    blinkUntil: optTime(wireNum(row[8]), at),
    chargeUntil: optTime(wireNum(row[6]), at),
    graceUntil: optTime(wireNum(row[9]), at),
    hp,
    id,
    kind,
    lances,
    maxHp,
    shielded: row[4] === 1,
    telegraphUntil: optTime(wireNum(row[5]), at),
  };
};
