import type { FxEvent, GroundEffect, Mine, Projectile, Unit, World } from "../sim/types";
import { isJsonNumber, isJsonObject, isJsonString } from "./json";
import type { JsonObject, JsonValue } from "./json";
import { parseFxBatch, rebuildMap } from "./snapshot";
import type { Tick } from "./snapshot";

type Sent = Map<string, string | number | boolean | null>;

const NESTED = new Set(["hero", "creep", "structure"]);

const QUANTUM = new Map([
  ["x", 10],
  ["y", 10],
  ["tx", 10],
  ["ty", 10],
  ["hp", 10],
  ["mp", 10],
  ["vx", 1],
  ["vy", 1],
  ["hero.gold", 10],
  ["hero.xp", 10],
]);

const IMMUTABLE = new Set(["creep.waypoints"]);

const sigReplacer = (key: string, value: JsonValue) =>
  key === "until" || key === "nextTick" ? undefined : value;

const quantize = (name: string, value: JsonValue) => {
  const k = QUANTUM.get(name);

  return k !== undefined && isJsonNumber(value) ? Math.round(value * k) / k : value;
};

const signature = (value: JsonValue) =>
  value instanceof Object ? JSON.stringify(value, sigReplacer) : value;

const diffRecord = (sent: Sent, rec: JsonObject, prefix: string) => {
  let patch: JsonObject | null = null;

  for (const [key, raw] of Object.entries(rec)) {
    const name = prefix + key;

    if (raw === undefined || (IMMUTABLE.has(name) && sent.has(name))) {
      continue;
    }

    if (prefix === "" && NESTED.has(key) && isJsonObject(raw)) {
      const sub = diffRecord(sent, raw, `${key}.`);

      if (sub) {
        patch ??= {};
        patch[key] = sub;
      }

      continue;
    }

    const value = quantize(name, raw);
    const sig = IMMUTABLE.has(name) ? null : signature(value);

    if (sent.has(name) && sent.get(name) === sig) {
      continue;
    }

    sent.set(name, sig);
    patch ??= {};
    patch[key] = value;
  }

  return patch;
};

interface EntityDiff {
  added: JsonObject[];
  changed: [string, JsonObject][];
  removed: string[];
}

const diffEntities = <T extends JsonObject>(cache: Map<string, Sent>, live: Map<string, T>) => {
  const diff: EntityDiff = { added: [], changed: [], removed: [] };

  for (const [id, entity] of live) {
    const sent = cache.get(id);

    if (sent) {
      const patch = diffRecord(sent, entity, "");

      if (patch) {
        diff.changed.push([id, patch]);
      }
    } else {
      const fresh: Sent = new Map();
      cache.set(id, fresh);
      diff.added.push(diffRecord(fresh, entity, "") ?? {});
    }
  }

  for (const id of cache.keys()) {
    if (!live.has(id)) {
      diff.removed.push(id);
      cache.delete(id);
    }
  }

  return diff;
};

const worldFields: (w: World) => [string, JsonValue, string | number | boolean | null][] = (w) => {
  const grounds = JSON.stringify(
    w.groundEffects.map((g) => (g.followOwner ? { ...g, nextTick: 0, x: 0, y: 0 } : g)),
    sigReplacer,
  );

  const mines = Object.fromEntries(w.mines);

  return [
    ["phase", w.phase, w.phase],
    ["winner", w.winner, w.winner],
    ["nextWaveAt", w.nextWaveAt, w.nextWaveAt],
    ["waveCount", w.waveCount, w.waveCount],
    ["seq", w.seq, w.seq],
    ["rngState", w.rngState, w.rngState],
    ["campRespawnAt", w.campRespawnAt, JSON.stringify(w.campRespawnAt)],
    ["mines", mines, JSON.stringify(mines)],
    ["grounds", w.groundEffects, grounds],
  ];
};

/**
 * Host side: turns each sim step into a Tick against what was last sent. The
 * baseline is shared by every guest — events reach each one reliably and in
 * order — so a guest only needs a keyframe to start from, and `reset` marks the
 * moment a keyframe re-based everyone.
 */
export class TickEncoder {
  private readonly units = new Map<string, Sent>();
  private readonly projectiles = new Map<string, Sent>();
  private readonly world: Sent = new Map();

  /** Count everything in `w` as sent: a keyframe just carried it whole. */
  reset(w: World) {
    this.units.clear();
    this.projectiles.clear();
    this.world.clear();
    this.encode(w, 0, [], []);
  }

  encode(w: World, stamp: number, fx: FxEvent[], acks: [string, number, number][]) {
    const tick: Tick = { g: w.gameTime, n: w.now, t: stamp };
    let worldPatch: JsonObject | null = null;

    for (const [key, value, sig] of worldFields(w)) {
      if (!this.world.has(key) || this.world.get(key) !== sig) {
        this.world.set(key, sig);
        worldPatch ??= {};
        worldPatch[key] = value;
      }
    }

    if (worldPatch) {
      tick.w = worldPatch;
    }

    const units = diffEntities(this.units, w.units);
    const projectiles = diffEntities(this.projectiles, w.projectiles);

    if (units.added.length > 0) {
      tick.un = units.added;
    }

    if (units.changed.length > 0) {
      tick.u = units.changed;
    }

    if (units.removed.length > 0) {
      tick.ux = units.removed;
    }

    if (projectiles.added.length > 0) {
      tick.pn = projectiles.added;
    }

    if (projectiles.changed.length > 0) {
      tick.p = projectiles.changed;
    }

    if (projectiles.removed.length > 0) {
      tick.px = projectiles.removed;
    }

    if (fx.length > 0) {
      tick.f = fx;
    }

    if (acks.length > 0) {
      tick.k = acks;
    }

    return tick;
  }
}

const isStringList = (v: JsonValue | undefined): v is string[] =>
  Array.isArray(v) && v.every((id) => isJsonString(id));

const isPatch = (v: JsonValue): v is [string, JsonObject] =>
  Array.isArray(v) && v.length === 2 && isJsonString(v[0]) && isJsonObject(v[1]);

const isAck = (v: JsonValue): v is [string, number, number] =>
  Array.isArray(v) &&
  v.length === 3 &&
  isJsonString(v[0]) &&
  isJsonNumber(v[1]) &&
  isJsonNumber(v[2]);

const isNewUnit = (v: JsonValue): v is JsonObject =>
  isJsonObject(v) &&
  isJsonString(v.id) &&
  isJsonString(v.kind) &&
  isJsonNumber(v.x) &&
  isJsonNumber(v.y) &&
  Array.isArray(v.statuses) &&
  isJsonObject(v.order);

const isNewProjectile = (v: JsonValue): v is JsonObject =>
  isJsonObject(v) && isJsonString(v.id) && isJsonNumber(v.x) && isJsonNumber(v.y);

/** Validate a tick event's payload. Only the elected host's ticks are read
 *  (the caller checks the sender), so this guards shape — a version-skewed
 *  peer — not intent. */
export const parseTick = (v: JsonValue) => {
  if (!isJsonObject(v) || !isJsonNumber(v.t) || !isJsonNumber(v.n) || !isJsonNumber(v.g)) {
    return null;
  }

  const tick: Tick = { g: v.g, n: v.n, t: v.t };

  if (isJsonObject(v.w)) {
    tick.w = v.w;
  }

  if (Array.isArray(v.un)) {
    tick.un = v.un.filter((rec) => isNewUnit(rec));
  }

  if (Array.isArray(v.u)) {
    tick.u = v.u.filter((patch) => isPatch(patch));
  }

  if (isStringList(v.ux)) {
    tick.ux = v.ux;
  }

  if (Array.isArray(v.pn)) {
    tick.pn = v.pn.filter((rec) => isNewProjectile(rec));
  }

  if (Array.isArray(v.p)) {
    tick.p = v.p.filter((patch) => isPatch(patch));
  }

  if (isStringList(v.px)) {
    tick.px = v.px;
  }

  if (v.f !== undefined) {
    tick.f = parseFxBatch(v.f);
  }

  if (Array.isArray(v.k)) {
    tick.k = v.k.filter((ack) => isAck(ack));
  }

  return tick;
};

const patchRecord = (target: JsonObject, patch: JsonObject) => {
  for (const [key, value] of Object.entries(patch)) {
    const into = target[key];

    if (NESTED.has(key) && isJsonObject(into) && isJsonObject(value)) {
      Object.assign(into, value);
    } else {
      target[key] = value;
    }
  }
};

const applyWorldPatch = (w: World, patch: JsonObject) => {
  const { phase, winner, nextWaveAt, waveCount, seq, rngState, campRespawnAt, mines, grounds } =
    patch;

  if (phase === "playing" || phase === "ended") {
    w.phase = phase;
  }

  if (winner === null || winner === "radiant" || winner === "dire") {
    w.winner = winner;
  }

  if (isJsonNumber(nextWaveAt)) {
    w.nextWaveAt = nextWaveAt;
  }

  if (isJsonNumber(waveCount)) {
    w.waveCount = waveCount;
  }

  if (isJsonNumber(seq)) {
    w.seq = seq;
  }

  if (isJsonNumber(rngState)) {
    w.rngState = rngState;
  }

  if (isJsonObject(campRespawnAt)) {
    w.campRespawnAt = campRespawnAt as Record<string, number>;
  }

  if (isJsonObject(mines)) {
    rebuildMap(w.mines, mines as Record<string, Mine>);
  }

  if (Array.isArray(grounds)) {
    w.groundEffects = grounds as GroundEffect[];
  }
};

/**
 * Replay one tick onto a world, which takes ownership of the tick's objects —
 * give each world its own copy. Entities the world does not know are skipped
 * (a guest that joined after their spawn sees them from the next keyframe).
 * `fx` queues the tick's one-shot effects for the renderer; a replica nobody
 * draws leaves them out.
 */
export const applyTick = (w: World, tick: Tick, fx: boolean) => {
  w.now = tick.n;
  w.gameTime = tick.g;

  if (tick.w) {
    applyWorldPatch(w, tick.w);
  }

  for (const rec of tick.un ?? []) {
    const unit = rec as Unit;
    w.units.set(unit.id, unit);
  }

  for (const [id, patch] of tick.u ?? []) {
    const unit = w.units.get(id);

    if (unit) {
      patchRecord(unit, patch);
    }
  }

  for (const id of tick.ux ?? []) {
    w.units.delete(id);
  }

  for (const rec of tick.pn ?? []) {
    const projectile = rec as Projectile;
    w.projectiles.set(projectile.id, projectile);
  }

  for (const [id, patch] of tick.p ?? []) {
    const projectile = w.projectiles.get(id);

    if (projectile) {
      patchRecord(projectile, patch);
    }
  }

  for (const id of tick.px ?? []) {
    w.projectiles.delete(id);
  }

  if (fx && tick.f) {
    w.fx.push(...tick.f);
  }
};
