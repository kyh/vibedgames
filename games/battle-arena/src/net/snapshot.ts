// World ↔ wire. Two shapes travel from the host:
//  - Snapshot: the whole World, ~1 Hz in sharedState.snap (and at once on a
//    phase or match edge) — what a late joiner starts from, and what a promoted
//    guest falls back to when its own copy missed frames. rngState travels so
//    the new host keeps the deterministic stream. Each unit rides as only the
//    fields that differ from a blank combatant: a barrel is a dozen keys, not
//    seventy.
//  - Frame: what changed in one sim tick, broadcast as an event every tick
//    (net/frames.ts builds it). fx ride the frames, so none are lost, and so
//    does every field the sim reads: a guest's copy is the host's world, which
//    a promoted guest carries on from.
// Both are JSON payload aliases — the lint config lists this module for that.
import { isJsonObject } from "../data/json";
import type { JsonObject, JsonValue } from "../data/json";
import { KILL_GOAL_FFA, MATCH_TIME } from "../data/config";
import { BOSS_POS } from "../data/map";
import { blankCombatant } from "../sim/world";
import type {
  BossState,
  Coin,
  Delivery,
  FxEvent,
  GroundEffect,
  PendingStrike,
  Projectile,
  Unit,
  World,
} from "../sim/types";

export type Snapshot = {
  now: number;
  gameTime: number;
  phase: World["phase"];
  winner: World["winner"];
  killGoal: number;
  matchTime: number;
  suddenDeath: boolean;
  leaderId: World["leaderId"];
  nextCoinAt: number;
  nextDeliveryAt: number;
  campRespawnAt: Record<string, number>;
  seq: number;
  rngState: number;
  /** Each unit's fields that differ from `blankUnit()`. */
  units: Record<string, JsonObject>;
  projectiles: Record<string, Projectile>;
  grounds: GroundEffect[];
  strikes: PendingStrike[];
  coins: Coin[];
  deliveries: Delivery[];
  boss: BossState;
};

/** One sim tick, as changes since the previous frame. Rows are keyed by id and
 *  carry only changed fields; a row for an id the receiver has never seen
 *  carries every field (the unit rows then always include `kind`). `*g` lists
 *  ids that are gone. Numbers are rounded for the wire (net/frames.ts). */
export type Frame = {
  /** Server time (ms) the tick stands for — what receivers interpolate on. */
  t: number;
  /** World.now after this tick (ms). */
  n: number;
  /** World.gameTime after this tick (s). */
  gt: number;
  u?: Record<string, JsonObject>;
  ug?: string[];
  p?: Record<string, JsonObject>;
  pg?: string[];
  g?: Record<string, JsonObject>;
  gg?: string[];
  c?: Record<string, JsonObject>;
  cg?: string[];
  d?: Record<string, JsonObject>;
  dg?: string[];
  /** World scalars that changed (phase, winner, leader, timers…). */
  w?: JsonObject;
  /** Boss fields that changed. */
  b?: JsonObject;
  fx?: FxEvent[];
};

/** The template unit rows are diffed against (and decoded onto). */
export const blankUnit = (): Unit => blankCombatant("", "hero", "", "", "", "");

const BLANK_UNIT: JsonObject = blankUnit();

/** Structural equality of two JSON values. */
export const sameJson = (a: JsonValue | undefined, b: JsonValue | undefined): boolean => {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) && a.length === b.length && a.every((value, i) => sameJson(value, b[i]))
    );
  }
  if (!isJsonObject(a) || !isJsonObject(b) || Array.isArray(b)) {
    return false;
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameJson(a[key], b[key]));
};

/** A unit as its difference from the blank template; nested values are copied
 *  so later host mutation never reaches the SDK's cached shared state. */
export const encodeUnit = (u: Unit): JsonObject => {
  const live: JsonObject = u;
  const row: JsonObject = {};
  for (const [key, value] of Object.entries(live)) {
    if (!sameJson(value, BLANK_UNIT[key])) {
      row[key] = value instanceof Object ? structuredClone(value) : value;
    }
  }
  return row;
};

/** Rebuild a full unit from its row. Values are adopted, not copied — decode a
 *  clone of anything that stays cached elsewhere (applySnapshot does). */
export const decodeUnit = (row: JsonObject): Unit => {
  const unit = blankUnit();
  const fields: JsonObject = unit;
  for (const [key, value] of Object.entries(row)) {
    fields[key] = value;
  }
  return unit;
};

export const encodeWorld = (w: World): Snapshot => ({
  boss: { ...w.boss },
  campRespawnAt: { ...w.campRespawnAt },
  coins: structuredClone(w.coins),
  deliveries: structuredClone(w.deliveries),
  gameTime: w.gameTime,
  grounds: structuredClone(w.grounds),
  killGoal: w.killGoal,
  leaderId: w.leaderId,
  matchTime: w.matchTime,
  nextCoinAt: w.nextCoinAt,
  nextDeliveryAt: w.nextDeliveryAt,
  now: w.now,
  phase: w.phase,
  projectiles: Object.fromEntries([...w.projectiles].map(([id, p]) => [id, structuredClone(p)])),
  rngState: w.rngState,
  seq: w.seq,
  strikes: structuredClone(w.strikes),
  suddenDeath: w.suddenDeath,
  units: Object.fromEntries([...w.units].map(([id, u]) => [id, encodeUnit(u)])),
  winner: w.winner,
});

export const emptyGuestWorld = (): World => ({
  boss: { alive: true, hp: 4000, maxHp: 4000, x: BOSS_POS.x, y: BOSS_POS.y },
  campRespawnAt: {},
  coins: [],
  deliveries: [],
  fx: [],
  gameTime: 0,
  grounds: [],
  killGoal: KILL_GOAL_FFA,
  leaderId: null,
  matchTime: MATCH_TIME,
  nextCoinAt: 0,
  nextDeliveryAt: 0,
  now: 0,
  phase: "playing",
  projectiles: new Map(),
  rngState: 1,
  seq: 0,
  strikes: [],
  suddenDeath: false,
  units: new Map(),
  winner: null,
});

const rebuildMap = <T, R>(
  map: Map<string, T>,
  rec: Record<string, R>,
  decode: (value: R) => T,
): void => {
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(rec)) {
    seen.add(k);
    map.set(k, decode(v));
  }
  for (const k of map.keys()) {
    if (!seen.has(k)) {
      map.delete(k);
    }
  }
};

/** Apply a snapshot onto a World in place (the Maps keep their identity). The
 *  World gets a copy, never the snapshot's own objects: one read off shared
 *  state is this client's copy of the room, which the next snapshot's ops
 *  are applied to, so a coin a frame pushed into it or a projectile moved in
 *  it would come back as the host's word. */
export const applySnapshot = (w: World, snapshot: Snapshot): void => {
  const s = structuredClone(snapshot);
  w.now = s.now;
  w.gameTime = s.gameTime;
  w.phase = s.phase;
  w.winner = s.winner;
  w.killGoal = s.killGoal;
  w.matchTime = s.matchTime;
  w.suddenDeath = s.suddenDeath;
  w.leaderId = s.leaderId;
  w.nextCoinAt = s.nextCoinAt;
  w.nextDeliveryAt = s.nextDeliveryAt;
  w.campRespawnAt = s.campRespawnAt ?? {};
  w.seq = s.seq;
  w.rngState = s.rngState ?? w.rngState;
  rebuildMap(w.units, s.units, decodeUnit);
  rebuildMap(w.projectiles, s.projectiles, (p) => p);
  w.grounds = s.grounds ?? [];
  w.strikes = s.strikes ?? [];
  w.coins = s.coins ?? [];
  w.deliveries = s.deliveries ?? [];
  w.boss = s.boss ?? w.boss;
};

export const isSnapshot = (v: Snapshot | JsonValue | undefined): v is Snapshot =>
  v instanceof Object && !Array.isArray(v) && "units" in v && "gameTime" in v;
