// World <-> wire snapshot. The World is plain data except its three Maps and the
// rng closure, so encoding is just Map->record (+ drop rng); decoding rebuilds
// the Maps into a guest's persistent World so the renderer can read it unchanged.

import type { MultiplayerClient } from "@vibedgames/multiplayer";

import type { FxEvent, GroundEffect, Mine, Projectile, Unit, World } from "../sim/types";

// oxlint-disable-next-line typescript/consistent-type-definitions -- must stay assignable to the JSON index-signature type; interfaces get no implicit index signature
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

export const encodeWorld = (w: World): Snapshot => ({
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

/** A fresh World a guest renders from (never simulated locally). */
export const emptyGuestWorld = (): World => ({
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

const rebuildMap = <T>(map: Map<string, T>, rec: Record<string, T>): void => {
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
export const applySnapshot = (w: World, snap: Snapshot): void => {
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
export const sharedSnapshot = (state: SharedState): Snapshot | null => {
  const { snap } = state;
  if (!(snap instanceof Object) || !("units" in snap) || !("gameTime" in snap)) {
    return null;
  }
  // SAFETY: `snap` is written exclusively by the trusted host via encodeWorld
  // and transported as JSON, so an object carrying the units+gameTime
  // discriminators is the host's Snapshot; guests only read it for rendering.
  return snap as Snapshot;
};

const isFiniteNumber = (x: SharedState[string] | undefined): x is number => Number.isFinite(x);

/** The fx-batch sequence number the host wrote alongside `fx`, or null. */
export const sharedFxSeq = (state: SharedState): number | null => {
  const v = state["fxSeq"];
  return isFiniteNumber(v) ? v : null;
};

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
export const sharedFxBatch = (state: SharedState): FxEvent[] => {
  const v = state["fx"];
  if (!Array.isArray(v)) {
    return [];
  }
  return v.filter(
    (e): e is FxEvent => e instanceof Object && "t" in e && FX_TAGS.some((tag) => tag === e.t),
  );
};
