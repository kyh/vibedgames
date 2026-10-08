import type { Team } from "../data/config";
import type { World } from "../sim/types";
import { createWorld } from "../sim/world";
import { applySnapshot, encodeWorld } from "./snapshot";
import type { Snapshot } from "./snapshot";

export interface OnlineSeat {
  team: Team;
  slot: number;
}

/** Each human hero's pick and seat, read back off the world it lives in. */
export const seatsOf = (world: World) => {
  const picks: Record<string, string> = {};
  const seats: Record<string, OnlineSeat> = {};
  for (const unit of world.units.values()) {
    const { hero } = unit;
    if (!hero || hero.isBot) {
      continue;
    }
    picks[hero.ownerId] = hero.defId;
    seats[hero.ownerId] = { slot: hero.slot, team: unit.team };
  }
  return { picks, seats };
};

/** Server election transfers the accepted match, never starts another one.
 * Keep the render world's identity and restore seats from its existing heroes.
 * Copy the accepted snapshot so later simulation cannot mutate the SDK cache.
 * Only a room without a snapshot may seed a fresh simulation. */
export const restoreHostState = (world: World, snapshot: Snapshot | null) => {
  applySnapshot(world, snapshot ? structuredClone(snapshot) : encodeWorld(createWorld(1234)));
  world.fx.length = 0;
  return seatsOf(world);
};
