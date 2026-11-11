// Where the match happens on Kestrel Terminal's dock: the two sites (the
// level's relays A and B; relay C on the quay goes dark), the two round spawn
// areas — the West Lot's haul road and the east quay by the boat — and, for
// deathmatch, arena spawn points spread over the whole dock. Every point is
// found on the level's own walkable grid, so a level change moves them with it.
import { Vector3 } from "three";

import type { StrikeforceGame } from "../core/types";
import type { Point } from "./rules";

/** Which end a side spawns at: the attackers always take the gate. */
export type End = "gate" | "quay";

export interface Spawn {
  pos: Vector3;
  yaw: number;
}

export interface MatchMap {
  /** Deathmatch spawns: walkable points on a grid over the whole dock. */
  arena: Spawn[];
  sites: [Point, Point];
  siteLabels: [string, string];
  spawns: Record<End, Spawn[]>;
}

const WEST_LOT = { x: -97, z: 5 };
const QUAY = { x: 25, z: 17 };
const SLOTS = 8;
/** Metres between spawn slots. */
const SPACING = 1.6;

/** The yaw that faces from `from` towards `to` (the camera looks down -Z at yaw 0). */
const yawTowards = (from: { x: number; z: number }, to: { x: number; z: number }): number =>
  Math.atan2(-(to.x - from.x), -(to.z - from.z));

const findSlots = (
  game: StrikeforceGame,
  centre: { x: number; z: number },
  facing: Point,
): Spawn[] => {
  const { nav } = game.physics;
  const slots: Spawn[] = [];
  // Walk outward in rings until eight walkable spots stand apart.
  for (let r = 0; r <= 14 && slots.length < SLOTS; r += 0.8) {
    const steps = Math.max(1, Math.round((2 * Math.PI * r) / SPACING));
    for (let i = 0; i < steps && slots.length < SLOTS; i += 1) {
      const a = (i / steps) * Math.PI * 2;
      const x = centre.x + Math.cos(a) * r;
      const z = centre.z + Math.sin(a) * r;
      const clear =
        nav.isWalkable(x, z) && slots.every((s) => Math.hypot(s.pos.x - x, s.pos.z - z) >= SPACING);
      if (clear) {
        const pos = new Vector3(x, 0, z);
        slots.push({ pos, yaw: yawTowards(pos, facing) });
      }
    }
  }
  return slots.length > 0
    ? slots
    : [{ pos: new Vector3(centre.x, 0, centre.z), yaw: yawTowards(centre, facing) }];
};

/** The dock's extent (the West Lot to the quay edge). */
const DOCK = { x0: -106, x1: 27, z0: -26, z1: 24 };
/** Metres between arena grid points. */
const ARENA_STEP = 9;

const arenaPoints = (game: StrikeforceGame, centre: Point): Spawn[] => {
  const { nav } = game.physics;
  const points: Spawn[] = [];
  for (let x = DOCK.x0; x <= DOCK.x1; x += ARENA_STEP) {
    for (let z = DOCK.z0; z <= DOCK.z1; z += ARENA_STEP) {
      // A point needs a little room around it, not just its own cell.
      const roomy = [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].every(([dx = 0, dz = 0]) => nav.isWalkable(x + dx, z + dz));
      if (roomy) {
        const pos = new Vector3(x, 0, z);
        points.push({ pos, yaw: yawTowards(pos, centre) });
      }
    }
  }
  return points;
};

export const buildMap = (game: StrikeforceGame): MatchMap => {
  const { relays } = game.game.run;
  const byId = (id: string) => relays.find((r) => r.id === id);
  const a = byId("relay_a")?.o.pos ?? new Vector3(1.5, 0, 7.5);
  const b = byId("relay_b")?.o.pos ?? new Vector3(-2, 0, -19.5);
  const mid = { x: (a.x + b.x) / 2, y: 0, z: (a.z + b.z) / 2 };
  return {
    arena: arenaPoints(game, mid),
    siteLabels: ["A — Yard", "B — Shed"],
    sites: [
      { x: a.x, y: a.y, z: a.z },
      { x: b.x, y: b.y, z: b.z },
    ],
    spawns: { gate: findSlots(game, WEST_LOT, mid), quay: findSlots(game, QUAY, mid) },
  };
};

/**
 * Rounds: light sites A and B, darken relay C (the only objectives are the two
 * sites). Deathmatch has no objectives: every relay goes dark.
 */
export const dressRelays = (game: StrikeforceGame, sites: boolean): void => {
  for (const relay of game.game.run.relays) {
    relay.o.object?.userData.setState?.(sites && relay.id !== "relay_c" ? "live" : "cut");
  }
};
