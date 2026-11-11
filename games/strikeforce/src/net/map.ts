// Where deathmatch happens on Kestrel Terminal's dock: spawn points on a grid
// over the whole dock, the West Lot to the quay. Every point is found on the
// level's own walkable grid, so a level change moves them with it.
import { Vector3 } from "three";

import type { StrikeforceGame } from "../core/types";

export interface Spawn {
  pos: Vector3;
  yaw: number;
}

/** The dock's extent (the West Lot to the quay edge). */
const DOCK = { x0: -106, x1: 27, z0: -26, z1: 24 };
/** Metres between spawn grid points. */
const STEP = 9;
/** Where fresh spawns face: the middle of the old yard. */
const CENTRE = { x: 0, z: -6 };

/** The yaw that faces from `from` towards `to` (the camera looks down -Z at yaw 0). */
const yawTowards = (from: { x: number; z: number }, to: { x: number; z: number }): number =>
  Math.atan2(-(to.x - from.x), -(to.z - from.z));

/** Walkable points with a little room around them, spread over the dock. */
export const arenaSpawns = (game: StrikeforceGame): Spawn[] => {
  const { nav } = game.physics;
  const points: Spawn[] = [];
  for (let x = DOCK.x0; x <= DOCK.x1; x += STEP) {
    for (let z = DOCK.z0; z <= DOCK.z1; z += STEP) {
      const roomy = [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].every(([dx = 0, dz = 0]) => nav.isWalkable(x + dx, z + dz));
      if (roomy) {
        const pos = new Vector3(x, 0, z);
        points.push({ pos, yaw: yawTowards(pos, CENTRE) });
      }
    }
  }
  return points;
};

/** Of a few random spawns, the one farthest from every enemy. */
export const safestSpawn = (
  spawns: readonly Spawn[],
  enemies: readonly { x: number; z: number }[],
  rng: () => number = Math.random,
): Spawn | undefined => {
  let best: Spawn | undefined;
  let bestD = -1;
  for (let i = 0; i < 6 && spawns.length > 0; i += 1) {
    const spot = spawns[Math.floor(rng() * spawns.length)];
    if (!spot) {
      continue;
    }
    let nearest = Infinity;
    for (const e of enemies) {
      nearest = Math.min(nearest, Math.hypot(e.x - spot.pos.x, e.z - spot.pos.z));
    }
    if (nearest > bestD) {
      bestD = nearest;
      best = spot;
    }
  }
  return best;
};

/** Deathmatch has no objectives: every relay on the dock goes dark. */
export const darkenRelays = (game: StrikeforceGame): void => {
  for (const relay of game.game.run.relays) {
    relay.o.object?.userData.setState?.("cut");
  }
};
