import type { MultiplayerClient } from "@vibedgames/multiplayer";

import type { FxEvent, GroundEffect, Mine, Projectile, Unit, World } from "../sim/types";
import { isSnapshot } from "./rows";
import { isJsonNumber, isJsonString } from "./json";
import type { JsonObject, JsonValue } from "./json";

export type Snapshot = {
  now: number;
  gameTime: number;
  phase: World["phase"];
  winner: World["winner"];
  nextWaveAt: number;
  waveCount: number;
  seq: number;
  rngState: number;
  units: Record<string, Unit>;
  projectiles: Record<string, Projectile>;
  mines: Record<string, Mine>;
  grounds: GroundEffect[];
  campRespawnAt: Record<string, number>;
};

/** A view, not a copy: units/projectiles/mines/grounds are the World's own
 *  objects, so whatever keeps a snapshot copies it — the keyframe the host
 *  publishes, restoreHostState, the guest mirror. */
export const encodeWorld = (w: World) => ({
  campRespawnAt: w.campRespawnAt,
  gameTime: w.gameTime,
  grounds: w.groundEffects,
  mines: Object.fromEntries(w.mines),
  nextWaveAt: w.nextWaveAt,
  now: w.now,
  phase: w.phase,
  projectiles: Object.fromEntries(w.projectiles),
  rngState: w.rngState,
  seq: w.seq,
  units: Object.fromEntries(w.units),
  waveCount: w.waveCount,
  winner: w.winner,
});

/**
 * One host sim step, streamed to every guest as an event: what changed since
 * the step before. Events arrive reliably and in order, so a guest that holds a
 * keyframe and every tick since holds the host's world.
 */
export type Tick = {
  /** Server time of the step (ms, `client.serverNow()`): the stamp guests
   *  interpolate and replay against, the same timebase whoever hosts. */
  t: number;
  /** World.now (sim ms) after the step. */
  n: number;
  /** World.gameTime after the step. */
  g: number;
  /** World-level fields that changed: wave/RNG/id bookkeeping, camps, mines, grounds. */
  w?: JsonObject;
  /** Units new this step, every field. */
  un?: JsonObject[];
  /** Units that changed: [id, changed fields] (hero/creep/structure nest one level). */
  u?: [string, JsonObject][];
  /** Units removed this step. */
  ux?: string[];
  pn?: JsonObject[];
  p?: [string, JsonObject][];
  px?: string[];
  /** One-shot effects since the previous step, in order. */
  f?: FxEvent[];
  /** Per guest hero: [heroId, newest input seq applied, sim ms it has been applied]. */
  k?: [string, number, number][];
};

/** A fresh World a guest renders from (never simulated locally). */
export const emptyGuestWorld: () => World = () => ({
  campRespawnAt: {},
  fx: [],
  gameTime: 0,
  groundEffects: [],
  mines: new Map(),
  nextWaveAt: 0,
  now: 0,
  phase: "playing",
  projectiles: new Map(),
  rngState: 1,
  seq: 0,
  units: new Map(),
  waveCount: 0,
  winner: null,
});

/** Make `map` hold exactly `rec`'s entries, keeping the Map's identity. */
export const rebuildMap = <T>(map: Map<string, T>, rec: Record<string, T>) => {
  const seen = new Set<string>();

  for (const [k, val] of Object.entries(rec)) {
    seen.add(k);
    map.set(k, val);
  }

  for (const k of map.keys()) {
    if (!seen.has(k)) {
      map.delete(k);
    }
  }
};

/** Mutate a guest's World in place from a decoded snapshot (preserves identity). */
export const applySnapshot = (w: World, snap: Snapshot) => {
  w.now = snap.now;
  w.gameTime = snap.gameTime;
  w.phase = snap.phase;
  w.winner = snap.winner;
  w.nextWaveAt = snap.nextWaveAt;
  w.waveCount = snap.waveCount;
  w.seq = snap.seq;
  w.rngState = snap.rngState ?? w.rngState;
  rebuildMap(w.units, snap.units);
  rebuildMap(w.projectiles, snap.projectiles);
  rebuildMap(w.mines, snap.mines);
  w.groundEffects = snap.grounds ?? [];
  w.campRespawnAt = snap.campRespawnAt ?? {};
};

type SharedState = MultiplayerClient["sharedState"];

/** The host-authored snapshot out of shared state, or null before the first
 *  broadcast. Only the hosting peer writes `snap` (encodeWorld output); the
 *  key-presence check filters empty rooms and foreign/stale documents. */
export const sharedSnapshot = (state: SharedState) => {
  const { snap } = state;

  return isSnapshot(snap) ? snap : null;
};

const isFiniteNumber = (x: SharedState[string] | undefined): x is number => Number.isFinite(x);

/** The server-clock stamp of the keyframe in `snap` (the step it was taken
 *  after), or null when shared state holds none. */
export const sharedSnapAt = (state: SharedState) => {
  const v = state.snapAt;

  return isFiniteNumber(v) ? v : null;
};

const FX_TAGS = [
  "hit",
  "death",
  "explosion",
  "cast",
  "blink",
  "levelup",
  "gold",
  "heal",
  "structureDown",
  "kill",
  "notify",
  "ability",
];

const castActor = (value: JsonValue | undefined) => {
  if (!(value instanceof Object) || !("unitId" in value) || !("at" in value)) {
    return null;
  }

  const { unitId, at } = value;

  if (!isJsonString(unitId) || unitId === "" || unitId.length > 128) {
    return null;
  }

  if (!isJsonNumber(at) || at < 0) {
    return null;
  }

  return { at, unitId };
};

/** Validate a tick's fx array into typed FxEvents, dropping bad shapes. */
export const parseFxBatch = (v: JsonValue | undefined) => {
  if (!Array.isArray(v)) {
    return [];
  }

  return v
    .filter(
      (e): e is FxEvent => e instanceof Object && "t" in e && FX_TAGS.some((tag) => tag === e.t),
    )
    .map((event) => {
      if (event.t !== "cast") {
        return event;
      }

      const actor = castActor(event.actor);
      const { actor: _actor, ...cast } = event;

      return actor ? { ...cast, actor } : cast;
    });
};
