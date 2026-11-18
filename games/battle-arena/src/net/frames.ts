import { isJsonNumber, isJsonObject } from "../data/json";
import type { JsonObject, JsonValue } from "../data/json";
import type { FxEvent, World } from "../sim/types";
import { blankUnit } from "./snapshot";
import type { Frame } from "./snapshot";

const UNIT_KEYS = [...Object.keys(blankUnit()), "campId", "homeX", "homeY"];

const PROJECTILE_KEYS = [
  "id",
  "ownerId",
  "team",
  "x",
  "y",
  "vx",
  "vy",
  "speed",
  "targetId",
  "damage",
  "dtype",
  "radius",
  "hitRadius",
  "pierce",
  "isAttack",
  "range",
  "burstAtEnd",
  "traveled",
  "kind",
  "onHit",
  "launchH",
  "hitIds",
];

const GROUND_KEYS = [
  "id",
  "ownerId",
  "team",
  "effect",
  "x",
  "y",
  "radius",
  "until",
  "tickInterval",
  "enemyDps",
  "allyHps",
  "dtype",
  "slowPct",
  "slowMs",
  "rootMs",
  "stunMs",
  "hexMs",
  "detonateAt",
  "detonateDmg",
  "detonateDtype",
  "telegraph",
  "nextTick",
];

const COIN_KEYS = ["id", "x", "y", "fromX", "fromY", "gold", "landAt", "expireAt", "loot"];
const DELIVERY_KEYS = ["id", "x", "y", "expireAt"];
const BOSS_KEYS = ["x", "y", "hp", "maxHp", "alive"];

const WORLD_KEYS = [
  "phase",
  "winner",
  "killGoal",
  "matchTime",
  "suddenDeath",
  "leaderId",
  "nextCoinAt",
  "nextDeliveryAt",
  "campRespawnAt",
  "strikes",
  "seq",
  "rngState",
];

const wireNumber = (key: string, v: number) => {
  switch (key) {
    case "hp": {
      return Math.ceil(v);
    }

    case "gold":
    case "xp": {
      return Math.floor(v);
    }

    case "maxHp": {
      return Math.round(v);
    }

    case "vx":
    case "vy": {
      return Math.round(v * 10) / 10;
    }

    default: {
      return Math.round(v * 100) / 100;
    }
  }
};

const wireValue: (key: string, v: JsonValue) => JsonValue = (key, v) => {
  if (isJsonNumber(v)) {
    return wireNumber(key, v);
  }

  if (Array.isArray(v)) {
    return v.map((item) => wireValue("", item));
  }

  if (isJsonObject(v)) {
    const out: JsonObject = {};

    for (const [k, item] of Object.entries(v)) {
      if (item !== undefined) {
        out[k] = wireValue("", item);
      }
    }

    return out;
  }

  return v;
};

const matchesWire = (key: string, live: JsonValue, sent: JsonValue | undefined) => {
  if (isJsonNumber(live)) {
    return wireNumber(key, live) === sent;
  }

  if (Array.isArray(live)) {
    if (!Array.isArray(sent) || sent.length !== live.length) {
      return false;
    }

    for (let i = 0; i < live.length; i += 1) {
      const item = live[i];

      if (item === undefined || !matchesWire("", item, sent[i])) {
        return false;
      }
    }

    return true;
  }

  if (isJsonObject(live)) {
    if (!isJsonObject(sent) || Array.isArray(sent)) {
      return false;
    }

    let count = 0;

    for (const k in live) {
      if (Object.hasOwn(live, k)) {
        const item = live[k];

        if (item !== undefined && !matchesWire("", item, sent[k])) {
          return false;
        }

        count += item === undefined ? 0 : 1;
      }
    }

    for (const k in sent) {
      if (Object.hasOwn(sent, k)) {
        count -= 1;
      }
    }

    return count === 0;
  }

  return live === sent;
};

const diffRow = (keys: readonly string[], live: JsonObject, sent: JsonObject) => {
  let delta: JsonObject | null = null;

  for (const key of keys) {
    const value = live[key];

    if (value === undefined || matchesWire(key, value, sent[key])) {
      continue;
    }

    const wire = wireValue(key, value);
    sent[key] = wire;
    delta ??= {};
    delta[key] = wire;
  }

  return delta;
};

interface Identified extends JsonObject {
  id: string;
}

interface KeyedRows {
  keys: readonly string[];
  sent: Map<string, JsonObject>;
  seen: Map<string, number>;
  pass: number;
}

const keyedRows = (keys: readonly string[]) => ({
  keys,
  pass: 0,
  seen: new Map(),
  sent: new Map(),
});

interface KeyedDiff {
  rows: Record<string, JsonObject> | null;
  gone: string[] | null;
}

const diffKeyed = (
  state: KeyedRows,
  items: Iterable<Identified>,
  extra?: ReadonlyMap<string, JsonObject>,
) => {
  const out: KeyedDiff = { gone: null, rows: null };
  state.pass += 1;

  for (const item of items) {
    const { id } = item;
    state.seen.set(id, state.pass);
    let sent = state.sent.get(id);

    if (!sent) {
      sent = {};
      state.sent.set(id, sent);
    }

    const delta = diffRow(state.keys, item, sent);
    const more = extra?.get(id);
    const moreDelta = more ? diffRow(Object.keys(more), more, sent) : null;

    if (delta || moreDelta) {
      out.rows ??= {};
      out.rows[id] = { ...delta, ...moreDelta };
    }
  }

  for (const [id, pass] of state.seen) {
    if (pass !== state.pass) {
      state.seen.delete(id);
      state.sent.delete(id);
      out.gone ??= [];
      out.gone.push(id);
    }
  }

  return out;
};

const clearKeyed = (state: KeyedRows) => {
  state.sent.clear();
  state.seen.clear();
};

const wireFx = (e: FxEvent) => {
  const copy: FxEvent = { ...e };
  const fields: JsonObject = copy;

  for (const [key, value] of Object.entries(fields)) {
    if (isJsonNumber(value)) {
      fields[key] = Math.round(value * 100) / 100;
    }
  }

  return copy;
};

/** Builds the host's frame stream. One encoder per host: every guest gets the
 *  same broadcast, so one record of what was sent covers them all. */
export class FrameEncoder {
  private readonly units = keyedRows(UNIT_KEYS);
  private readonly projectiles = keyedRows(PROJECTILE_KEYS);
  private readonly grounds = keyedRows(GROUND_KEYS);
  private readonly coins = keyedRows(COIN_KEYS);
  private readonly deliveries = keyedRows(DELIVERY_KEYS);
  private world: JsonObject = {};
  private boss: JsonObject = {};

  /** Forget what was sent: the next frame carries every row in full (a new
   *  match, or a new host whose receivers hold a different world). */
  reset() {
    clearKeyed(this.units);
    clearKeyed(this.projectiles);
    clearKeyed(this.grounds);
    clearKeyed(this.coins);
    clearKeyed(this.deliveries);
    this.world = {};
    this.boss = {};
  }

  /** The frame for the tick just stepped. `t` is the tick's server-time
   *  stamp (whole ms); `acks` maps hero id → its owner's input ack
   *  ({ ack, ackAt }). */
  frame(w: World, t: number, fx: FxEvent[], acks: ReadonlyMap<string, JsonObject>) {
    const out: Frame = {
      gt: Math.round(w.gameTime * 1000) / 1000,
      n: Math.round(w.now * 100) / 100,
      t,
    };

    const units = diffKeyed(this.units, w.units.values(), acks);

    if (units.rows) {
      out.u = units.rows;
    }

    if (units.gone) {
      out.ug = units.gone;
    }

    const projectiles = diffKeyed(this.projectiles, w.projectiles.values());

    if (projectiles.rows) {
      out.p = projectiles.rows;
    }

    if (projectiles.gone) {
      out.pg = projectiles.gone;
    }

    const grounds = diffKeyed(this.grounds, w.grounds);

    if (grounds.rows) {
      out.g = grounds.rows;
    }

    if (grounds.gone) {
      out.gg = grounds.gone;
    }

    const coins = diffKeyed(this.coins, w.coins);

    if (coins.rows) {
      out.c = coins.rows;
    }

    if (coins.gone) {
      out.cg = coins.gone;
    }

    const deliveries = diffKeyed(this.deliveries, w.deliveries);

    if (deliveries.rows) {
      out.d = deliveries.rows;
    }

    if (deliveries.gone) {
      out.dg = deliveries.gone;
    }

    const scalars = diffRow(
      WORLD_KEYS,
      {
        campRespawnAt: w.campRespawnAt,
        killGoal: w.killGoal,
        leaderId: w.leaderId,
        matchTime: w.matchTime,
        nextCoinAt: w.nextCoinAt,
        nextDeliveryAt: w.nextDeliveryAt,
        phase: w.phase,
        rngState: w.rngState,
        seq: w.seq,
        strikes: w.strikes,
        suddenDeath: w.suddenDeath,
        winner: w.winner,
      },
      this.world,
    );

    if (scalars) {
      out.w = scalars;
    }

    const boss = diffRow(BOSS_KEYS, w.boss, this.boss);

    if (boss) {
      out.b = boss;
    }

    if (fx.length > 0) {
      out.fx = fx.map(wireFx);
    }

    return out;
  }
}
