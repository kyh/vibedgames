// World <-> wire snapshot. The World is plain data except its three Maps and the
// rng closure, so encoding is just Map->record (+ drop rng); decoding rebuilds
// the Maps into a guest's persistent World so the renderer can read it unchanged.

import type { GroundEffect, Mine, Projectile, Unit, World } from "../sim/types";

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
    startedAt: 0,
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
  for (const k of Object.keys(rec)) {
    seen.add(k);
    map.set(k, rec[k]!);
  }
  for (const k of map.keys()) if (!seen.has(k)) map.delete(k);
}

/** Strip a snapshot down for the wire (it's already plain; this validates shape). */
export function isSnapshot(v: unknown): v is Snapshot {
  return typeof v === "object" && v !== null && "units" in v && "gameTime" in v;
}
