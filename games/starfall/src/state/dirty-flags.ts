/** Host-only: which shared-world arrays changed since the last 20Hz share.
 *  Every host-side mutation flips a flag; hostShareWorld sends those fields
 *  and clears them. One record shared by reference (never reassigned) so
 *  every collaborator marks the same flags the director reads. */
export interface DirtyFlags {
  asteroids: boolean;
  beacon: boolean;
  enemies: boolean;
  enemyShots: boolean;
  items: boolean;
  pulls: boolean;
  shards: boolean;
  ufo: boolean;
}

export const newDirtyFlags = (): DirtyFlags => ({
  asteroids: false,
  beacon: false,
  enemies: false,
  enemyShots: false,
  items: false,
  pulls: false,
  shards: false,
  ufo: false,
});

export const setAllDirty = (d: DirtyFlags, value: boolean): void => {
  d.asteroids = value;
  d.beacon = value;
  d.enemies = value;
  d.enemyShots = value;
  d.items = value;
  d.pulls = value;
  d.shards = value;
  d.ufo = value;
};
