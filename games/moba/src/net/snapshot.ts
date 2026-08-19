// World <-> wire snapshot. The World is plain data except its three Maps and the
// rng closure, so encoding is just Map->record (+ drop rng); decoding rebuilds
// the Maps into a guest's persistent World so the renderer can read it unchanged.

import type { MultiplayerClient } from "@vibedgames/multiplayer";

import type { FxEvent, GroundEffect, Mine, Projectile, Unit, World } from "../sim/types";

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

export function encodeWorld(w: World): Snapshot {
  return {
    now: w.now,
    gameTime: w.gameTime,
    phase: w.phase,
    winner: w.winner,
    nextWaveAt: w.nextWaveAt,
    waveCount: w.waveCount,
    seq: w.seq,
    rngState: w.rngState,
    units: Object.fromEntries(w.units),
    projectiles: Object.fromEntries(w.projectiles),
    mines: Object.fromEntries(w.mines),
    grounds: w.groundEffects,
    campRespawnAt: w.campRespawnAt,
  };
}

/** A fresh World a guest renders from (never simulated locally). */
export function emptyGuestWorld(): World {
  return {
    now: 0,
    gameTime: 0,
    phase: "playing",
    winner: null,
    units: new Map(),
    projectiles: new Map(),
    nextWaveAt: 0,
    waveCount: 0,
    mines: new Map(),
    groundEffects: [],
    campRespawnAt: {},
    fx: [],
    seq: 0,
    rngState: 1,
  };
}

/** Mutate a guest's World in place from a decoded snapshot (preserves identity). */
export function applySnapshot(w: World, snap: Snapshot): void {
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
}

function rebuildMap<T>(map: Map<string, T>, rec: Record<string, T>): void {
  const seen = new Set<string>();
  for (const [k, val] of Object.entries(rec)) {
    seen.add(k);
    map.set(k, val);
  }
  for (const k of map.keys()) if (!seen.has(k)) map.delete(k);
}

type SharedState = MultiplayerClient["sharedState"];

/** The host-authored snapshot out of shared state, or null before the first
 *  broadcast. Only the hosting peer writes `snap` (encodeWorld output); the
 *  key-presence check filters empty rooms and foreign/stale documents. */
export function sharedSnapshot(state: SharedState): Snapshot | null {
  const snap = state["snap"];
  if (!(snap instanceof Object) || !("units" in snap) || !("gameTime" in snap)) return null;
  // SAFETY: `snap` is written exclusively by the trusted host via encodeWorld
  // and transported as JSON, so an object carrying the units+gameTime
  // discriminators is the host's Snapshot; guests only read it for rendering.
  return snap as Snapshot;
}

const isFiniteNumber = (x: SharedState[string] | undefined): x is number => Number.isFinite(x);

/** The fx-batch sequence number the host wrote alongside `fx`, or null. */
export function sharedFxSeq(state: SharedState): number | null {
  const v = state["fxSeq"];
  return isFiniteNumber(v) ? v : null;
}

// Known one-shot fx tags, for validating a broadcast fx batch at ingest.
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
/** Validate the broadcast fx array in shared state into typed FxEvents,
 *  dropping bad shapes. */
export function sharedFxBatch(state: SharedState): FxEvent[] {
  const v = state["fx"];
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is FxEvent => e instanceof Object && "t" in e && FX_TAGS.some((tag) => tag === e.t),
  );
}
