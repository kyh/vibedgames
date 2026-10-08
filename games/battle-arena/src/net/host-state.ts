import type { PlayerMap } from "@vibedgames/multiplayer";
import { SPAWNS } from "../data/map";
import type { World } from "../sim/types";
import { createWorld, ensureBots, setHeroInput, spawnHero } from "../sim/world";
import type { NetMirror } from "./mirror";
import type { HeldInput, OwnHeroPredictor } from "./own-hero";
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

export const humanRoster = (world: World) => {
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
};

/** Election transfers the accepted simulation in place. Only an absent
 * snapshot seeds a room; cloning keeps later host steps out of the SDK cache. */
export const restoreHostState = (world: World, snapshot: Snapshot | null) => {
  applySnapshot(
    world,
    snapshot ? structuredClone(snapshot) : encodeWorld(createWorld(ONLINE_SEED)),
  );
  world.fx.length = 0;
  return humanRoster(world);
};

/** Where a newly elected host's world came from. */
export type TakeoverSource = "own" | "mirror" | "snapshot";

export interface TakeoverFrom {
  /** The world is a sim this client ran, and the room's newest snapshot is
   *  the last one it published: a host back from a dropped connection. */
  ours: boolean;
  /** This client's copy of the old host's stream, and its own hero's prediction. */
  mirror: NetMirror;
  predictor: OwnHeroPredictor;
  ownId: string;
  held: HeldInput;
  /** The room's newest snapshot, null in a room that has none yet. */
  snapshot: Snapshot | null;
}

/**
 * Take over the simulation from the freshest world on hand, in place: our own
 * if we ran on past the room's newest snapshot; else the mirror, which saw
 * every frame the old host sent, with our hero where prediction drew it; else
 * the room's snapshot, up to a second behind (or a fresh world in a room
 * without one). Returns the human roster and where the world came from.
 */
export const takeOver = (world: World, from: TakeoverFrom) => {
  let source: TakeoverSource = "own";
  if (!from.ours) {
    if (from.mirror.takeOver(world)) {
      const me = world.units.get(from.ownId);
      if (me) {
        from.predictor.handover(me, world.units, from.held, world.now);
      }
      source = "mirror";
    } else {
      restoreHostState(world, from.snapshot);
      source = "snapshot";
    }
  }
  return { ...humanRoster(world), source };
};

/** Grace connections retain their actual hero/seat. A new human replaces the
 * bot at one free human seat, never a different human or a fallback slot 0. */
export const reconcileHostHeroes = (
  world: World,
  players: PlayerMap,
  picks: Record<string, HeroPick>,
  seats: Record<string, OnlineSeat>,
): void => {
  if (world.phase !== "playing") {
    return;
  }
  for (const unit of world.units.values()) {
    if (unit.kind !== "hero" || unit.isBot) {
      continue;
    }
    if (players[unit.ownerId]) {
      seats[unit.ownerId] = { slot: unit.slot, team: unit.team };
      if (players[unit.ownerId]?.connected === false) {
        setHeroInput(unit, 0, 0, unit.aimX, unit.aimY, false);
      }
    } else {
      world.units.delete(unit.id);
    }
  }
  for (const ownerId of Object.keys(seats)) {
    if (players[ownerId]) {
      continue;
    }
    // oxlint-disable-next-line typescript/no-dynamic-delete -- the caller keeps these records by reference; the departed owner must vanish from its own object
    delete seats[ownerId];
    // oxlint-disable-next-line typescript/no-dynamic-delete -- same shared-record contract as the seat above
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
};
