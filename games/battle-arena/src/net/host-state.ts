import type { PlayerMap } from "@vibedgames/multiplayer";
import { SPAWNS } from "../data/map";
import type { World } from "../sim/types";
import { createWorld, ensureBots, setHeroInput, spawnHero } from "../sim/world";
import { applySnapshot, encodeWorld } from "./snapshot";
import type { Snapshot } from "./snapshot";

const ONLINE_SEED = 0xba_da_55;
export interface HeroPick {
  champId: string;
  name: string;
}
export interface OnlineSeat {
  slot: number;
  team: string;
}

export function humanRoster(world: World) {
  const picks: Record<string, HeroPick> = {};
  const seats: Record<string, OnlineSeat> = {};
  for (const unit of world.units.values()) {
    if (unit.kind !== "hero" || unit.isBot) {
      continue;
    }
    picks[unit.ownerId] = { champId: unit.champId, name: unit.name };
    seats[unit.ownerId] = { slot: unit.slot, team: unit.team };
  }
  return { picks, seats };
}

/** Election transfers the accepted simulation in place. Only an absent
 * snapshot seeds a room; cloning keeps later host steps out of the SDK cache. */
export function restoreHostState(world: World, snapshot: Snapshot | null) {
  applySnapshot(
    world,
    snapshot ? structuredClone(snapshot) : encodeWorld(createWorld(ONLINE_SEED)),
  );
  world.fx.length = 0;
  return humanRoster(world);
}

/** Grace connections retain their actual hero/seat. A new human replaces the
 * bot at one free human seat, never a different human or a fallback slot 0. */
export function reconcileHostHeroes(
  world: World,
  players: PlayerMap,
  picks: Record<string, HeroPick>,
  seats: Record<string, OnlineSeat>,
): void {
  if (world.phase !== "playing") {
    return;
  }
  for (const unit of world.units.values()) {
    if (unit.kind !== "hero" || unit.isBot) {
      continue;
    }
    if (players[unit.ownerId]) {
      seats[unit.ownerId] = { slot: unit.slot, team: unit.team };
      if (players[unit.ownerId]?.connected === false)
        setHeroInput(unit, 0, 0, unit.aimX, unit.aimY, false);
    } else {
      world.units.delete(unit.id);
    }
  }
  for (const ownerId of Object.keys(seats)) {
    if (players[ownerId]) {
      continue;
    }
    delete seats[ownerId];
    delete picks[ownerId];
  }
  const used = new Set(Object.values(seats).map((seat) => seat.slot));
  for (const ownerId of Object.keys(players)) {
    if (world.units.has(`h-${ownerId}`)) {
      continue;
    }
    const pick = picks[ownerId];
    if (!pick) {
      continue;
    }
    let seat = seats[ownerId];
    if (!seat) {
      const slot = SPAWNS.findIndex((_, index) => !used.has(index));
      if (slot === -1) {
        continue;
      }
      seat = { slot, team: ownerId };
      seats[ownerId] = seat;
      used.add(slot);
    }
    for (const unit of world.units.values()) {
      if (unit.kind === "hero" && unit.isBot && unit.slot === seat.slot) {
        world.units.delete(unit.id);
      }
    }
    spawnHero(world, {
      champId: pick.champId,
      id: `h-${ownerId}`,
      isBot: false,
      name: pick.name || "Player",
      ownerId,
      slot: seat.slot,
      team: seat.team,
    });
  }
  ensureBots(world);
}
