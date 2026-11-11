// Where the match happens on Kestrel Terminal's dock: the two sites (the
// level's relays A and B; relay C on the quay goes dark), and the two spawn
// areas — the west gate and the east quay by the boat. Spawn slots are found
// on the level's own walkable grid, so a level change moves them with it.
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
  sites: [Point, Point];
  siteLabels: [string, string];
  spawns: Record<End, Spawn[]>;
}

const GATE = { x: -31, z: 6 };
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

export const buildMap = (game: StrikeforceGame): MatchMap => {
  const { relays } = game.game.run;
  const byId = (id: string) => relays.find((r) => r.id === id);
  const a = byId("relay_a")?.o.pos ?? new Vector3(1.5, 0, 7.5);
  const b = byId("relay_b")?.o.pos ?? new Vector3(-2, 0, -19.5);
  const mid = { x: (a.x + b.x) / 2, y: 0, z: (a.z + b.z) / 2 };
  return {
    siteLabels: ["A — Yard", "B — Shed"],
    sites: [
      { x: a.x, y: a.y, z: a.z },
      { x: b.x, y: b.y, z: b.z },
    ],
    spawns: { gate: findSlots(game, GATE, mid), quay: findSlots(game, QUAY, mid) },
  };
};

/** Light sites A and B, darken relay C: the dock's only objectives are the two sites. */
export const dressRelays = (game: StrikeforceGame): void => {
  for (const relay of game.game.run.relays) {
    relay.o.object?.userData.setState?.(relay.id === "relay_c" ? "cut" : "live");
  }
};
