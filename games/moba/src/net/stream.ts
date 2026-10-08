// The host's per-step world stream. Each sim step the host sends one Tick event
// holding only what changed since the step before — a moving unit costs its
// position, a swing its attack fields — instead of the whole World (~30 KB) a
// dozen times a second. Guests replay ticks onto their copy of the world: on
// arrival onto the replica a promoted guest resumes, and ~100 ms later onto the
// world they render (net/mirror.ts).

import type { FxEvent, GroundEffect, Mine, Projectile, Unit, World } from "../sim/types";
import { isJsonNumber, isJsonObject, isJsonString } from "./json";
import type { JsonObject, JsonValue } from "./json";
import { parseFxBatch, rebuildMap } from "./snapshot";
import type { Tick } from "./snapshot";

/** What was last sent per field: primitives as-is, objects and arrays as JSON. */
type Sent = Map<string, string | number | boolean | null>;

/** Sub-records diffed field by field: a hero's gold ticks every step, its
 *  ability table almost never, so sending the whole hero on any change would
 *  cost more than the rest of the tick combined. */
const NESTED = new Set(["hero", "creep", "structure"]);

/** Continuous fields that change every step a body moves, rounded so the wire
 *  carries "1234.5" rather than seventeen digits: 0.1 px or point is far below
 *  anything drawn or felt. Everything else travels exact. */
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

/** A creep's lane route is fixed at spawn and never mutated, so it is sent
 *  with the creep and not re-serialized every step to prove it unchanged. */
const IMMUTABLE = new Set(["creep.waypoints"]);

/** Expiry and next-tick times are refreshed every step by auras and damage
 *  ticks without changing what anyone sees, so they do not count as a change:
 *  a status set is re-sent when a status starts, ends or changes strength,
 *  carrying its current times. */
const sigReplacer = (key: string, value: JsonValue): JsonValue | undefined =>
  key === "until" || key === "nextTick" ? undefined : value;

const quantize = (name: string, value: JsonValue): JsonValue => {
  const k = QUANTUM.get(name);
  return k !== undefined && isJsonNumber(value) ? Math.round(value * k) / k : value;
};

const signature = (value: JsonValue): string | number | boolean | null =>
  value instanceof Object ? JSON.stringify(value, sigReplacer) : value;

/** Diff one record against what was last sent for it, recording what is sent
 *  now. A record never sent before comes back whole. */
const diffRecord = (sent: Sent, rec: JsonObject, prefix: string): JsonObject | null => {
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

/** Units and projectiles are type aliases of JSON data, so each reads as a
 *  JsonObject without conversion. */
const diffEntities = <T extends JsonObject>(
  cache: Map<string, Sent>,
  live: Map<string, T>,
): EntityDiff => {
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

/** The world-level fields, with grounds signed without their per-step churn:
 *  damage-tick times, and the position of zones that ride their owner (a guest
 *  places those on the owner it draws). */
const worldFields = (w: World): [string, JsonValue, string | number | boolean | null][] => {
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
  reset(w: World): void {
    this.units.clear();
    this.projectiles.clear();
    this.world.clear();
    this.encode(w, 0, [], []);
  }

  encode(w: World, stamp: number, fx: FxEvent[], acks: [string, number, number][]): Tick {
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

// ---- guest side ------------------------------------------------------------

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

/** A new entity must carry at least the fields every reader dereferences;
 *  anything thinner is a version-skewed peer and is dropped, not drawn. */
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
export const parseTick = (v: JsonValue): Tick | null => {
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

/** Write a patch into an entity. Its fields are what the host's encoder read
 *  off the same type, so they land type-correct; hero/creep/structure merge
 *  one level down, as the encoder diffed them. */
const patchRecord = (target: JsonObject, patch: JsonObject): void => {
  for (const [key, value] of Object.entries(patch)) {
    const into = target[key];
    if (NESTED.has(key) && isJsonObject(into) && isJsonObject(value)) {
      Object.assign(into, value);
    } else {
      target[key] = value;
    }
  }
};

const applyWorldPatch = (w: World, patch: JsonObject): void => {
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
  // The host's encoder sends these exactly as World holds them, and only the
  // elected host's ticks are applied.
  if (isJsonObject(campRespawnAt)) {
    // SAFETY: the host's world.campRespawnAt record, camp id -> game seconds.
    w.campRespawnAt = campRespawnAt as Record<string, number>;
  }
  if (isJsonObject(mines)) {
    // SAFETY: Object.fromEntries(world.mines) on the host.
    rebuildMap(w.mines, mines as Record<string, Mine>);
  }
  if (Array.isArray(grounds)) {
    // SAFETY: the host's world.groundEffects array.
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
export const applyTick = (w: World, tick: Tick, fx: boolean): void => {
  w.now = tick.n;
  w.gameTime = tick.g;
  if (tick.w) {
    applyWorldPatch(w, tick.w);
  }
  for (const rec of tick.un ?? []) {
    // SAFETY: isNewUnit vetted the fields readers dereference; the rest is the
    // host encoder's full copy of a Unit, sent whole the first step it exists.
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
    // SAFETY: as for units — the host's full copy of a new Projectile.
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
