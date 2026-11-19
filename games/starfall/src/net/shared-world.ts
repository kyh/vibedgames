import { now as simNow } from "../shared/clock";
import { BASE_WORLD_H, BASE_WORLD_W } from "../shared/constants";
import type { SharedState } from "../shared/constants";

/** Index an entity array by id (reconcile does many find-by-id lookups). */
export const indexById = <T extends { id: string }>(list: readonly T[]) => {
  const map = new Map<string, T>();

  for (const e of list) {
    map.set(e.id, e);
  }

  return map;
};

/** Drop the entity with this id (a client claimed or consumed it). */
export const removeById = <T extends { id: string }>(list: T[], id: string) => {
  const idx = list.findIndex((e) => e.id === id);

  if (idx !== -1) {
    list.splice(idx, 1);
  }
};

export const emptyShared: () => SharedState = () => ({
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

/** Replace every field of the working copy in place. The world record is
 *  shared by reference with every collaborator, so adoption (host admission,
 *  solo seed) must mutate it rather than swap the object. */
export const adoptShared = (target: SharedState, next: SharedState) => {
  target.arenaEpoch = next.arenaEpoch;
  target.asteroids = next.asteroids;
  target.beacon = next.beacon;
  target.enemies = next.enemies;
  target.enemyShots = next.enemyShots;
  target.items = next.items;
  target.playH = next.playH;
  target.playW = next.playW;
  target.pulls = next.pulls;
  target.sectorBossIdx = next.sectorBossIdx;
  target.shards = next.shards;
  target.ufo = next.ufo;
};
