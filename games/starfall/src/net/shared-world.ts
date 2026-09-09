import type { MultiplayerClient } from "@vibedgames/multiplayer";
import { now as simNow } from "../shared/clock";
import { BASE_WORLD_H, BASE_WORLD_W } from "../shared/constants";
import type { AsteroidState, SharedState } from "../shared/constants";
import {
  asteroidToWire,
  beaconToWire,
  enemyShotToWire,
  enemyToWire,
  itemToWire,
  pullToWire,
  shardToWire,
  ufoToWire,
} from "../shared/wire";

/** The host-owned shared world as it crosses the wire: empty seed, patch encoding, and the guest-side blend of drifting entities toward a snapshot. */

/** Reconcile snaps instead of blending past this offset. */
export const SNAP_DIST = 80;

/** Index an entity array by id (reconcile does many find-by-id lookups). */
export const indexById = <T extends { id: string }>(list: readonly T[]): Map<string, T> => {
  const map = new Map<string, T>();
  for (const e of list) {
    map.set(e.id, e);
  }
  return map;
};

export const cloneAsteroid = (a: AsteroidState): AsteroidState => ({ ...a });

/** Soft-correct a dead-reckoned position toward the authoritative one. */
export const blendPos = (target: { x: number; y: number }, ax: number, ay: number): void => {
  const dx = ax - target.x;
  const dy = ay - target.y;
  if (dx * dx + dy * dy > SNAP_DIST * SNAP_DIST) {
    target.x = ax;
    target.y = ay;
  } else {
    target.x += dx * 0.3;
    target.y += dy * 0.3;
  }
};

/** Reconcile a host-owned drifting entity list (items, shards, enemy shots)
 *  toward the snapshot: adopt arrivals, blend survivors, drop departures —
 *  except entries this client already claimed locally (host lagging). */
export const reconcileDrifters = <
  T extends { id: string; x: number; y: number; vx: number; vy: number; diesAt: number },
>(
  local: T[],
  remote: readonly T[],
  claimed: ReadonlyMap<string, number>,
): T[] => {
  const byId = indexById(local);
  const ids = new Set<string>();
  for (const r of remote) {
    ids.add(r.id);
    if (claimed.has(r.id)) {
      continue;
    }
    const cur = byId.get(r.id);
    if (!cur) {
      local.push({ ...r });
      continue;
    }
    cur.vx = r.vx;
    cur.vy = r.vy;
    cur.diesAt = r.diesAt;
    blendPos(cur, r.x, r.y);
  }
  return local.filter((x) => ids.has(x.id) && !claimed.has(x.id));
};

export const emptyShared = (): SharedState =>
  // Every resettable field MUST be present — patches shallow-merge, so an
  // omitted key carries over.
  ({
    arenaEpoch: simNow(),
    asteroids: [],
    beacon: null,
    enemies: [],
    enemyShots: [],
    items: [],
    playH: BASE_WORLD_H,
    playW: BASE_WORLD_W,
    pulls: [],
    sectorBossIdx: -1,
    shards: [],
    ufo: null,
  });

export const isShared = (v: MultiplayerClient["sharedState"]): v is SharedState =>
  Array.isArray(v["asteroids"]);

/** A SharedState as a shallow-merge patch object — field by field, no cast.
 *  Quantized at this boundary (shared/wire.ts): the working copy keeps full
 *  precision; only the serialized snapshot is rounded. */
export const sharedToPatch = (s: SharedState) => ({
  arenaEpoch: Math.round(s.arenaEpoch),
  asteroids: s.asteroids.map(asteroidToWire),
  beacon: s.beacon ? beaconToWire(s.beacon) : null,
  enemies: s.enemies.map(enemyToWire),
  enemyShots: s.enemyShots.map(enemyShotToWire),
  items: s.items.map(itemToWire),
  playH: s.playH,
  playW: s.playW,
  pulls: s.pulls.map(pullToWire),
  sectorBossIdx: s.sectorBossIdx,
  shards: s.shards.map(shardToWire),
  ufo: s.ufo ? ufoToWire(s.ufo) : null,
});
