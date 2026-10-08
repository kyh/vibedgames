// The movement step every copy of a brawler runs: the host's sim, a solo
// player, and a guest predicting its own body. Keeping it in one pure function
// is what lets prediction agree with the host — and lets the netcode smoke test
// drive both copies without a scene.
import { BRAWLER_RADIUS } from "../config";
import type { BrawlerDef } from "../config";
import type { Position } from "../world/collision";

export interface Planar {
  x: number;
  y: number;
}

export interface MoverWorld {
  heightAt: (x: number, z: number) => number;
  resolveCircle: (position: Position, radius: number) => void;
}

export interface Mover {
  readonly position: Position & { y: number };
  /** Intended velocity this step (x, z in the vector's x, y). */
  readonly vel: Planar;
  /** Knockback still being shed, decaying over a few tenths of a second. */
  readonly knock: Planar;
}

/** Firing a ranged burst slows the shooter; melee swings keep full pace. */
export const BURST_SLOW = 0.82;
/** Knockback decay rate (per second). */
export const KNOCK_DECAY = 7;

/** One step: walk along the input at `speed`, add the decaying knockback, stay out of walls. */
export const stepMover = (
  body: Mover,
  moveX: number,
  moveZ: number,
  speed: number,
  world: MoverWorld,
  dt: number,
): void => {
  const { knock, position, vel } = body;
  vel.x = moveX * speed;
  vel.y = moveZ * speed;
  position.x += (vel.x + knock.x) * dt;
  position.z += (vel.y + knock.y) * dt;
  const decay = Math.exp(-KNOCK_DECAY * dt);
  knock.x *= decay;
  knock.y *= decay;
  world.resolveCircle(position, BRAWLER_RADIUS);
  position.y = world.heightAt(position.x, position.z);
};

export interface LeapArc {
  sx: number;
  sz: number;
  t: number;
  tx: number;
  tz: number;
}

/** Peak height of a leap above the line between its two tiles. */
const LEAP_HEIGHT = 3.4;

/** A leap's flight time, for kits whose super is one. */
export const leapFlight = (def: BrawlerDef): number =>
  def.super.kind === "leap" ? def.super.flight : 1;

/** Where a leap `t` seconds in puts the body: a straight ground track under a sine arc. */
export const leapPoint = (
  leap: LeapArc,
  flight: number,
  heightAt: (x: number, z: number) => number,
  out: Position & { y: number },
): number => {
  const progress = Math.max(0, Math.min(1, leap.t / flight));
  out.x = leap.sx + (leap.tx - leap.sx) * progress;
  out.z = leap.sz + (leap.tz - leap.sz) * progress;
  const from = heightAt(leap.sx, leap.sz);
  out.y =
    from +
    (heightAt(leap.tx, leap.tz) - from) * progress +
    Math.sin(progress * Math.PI) * LEAP_HEIGHT;
  return progress;
};
