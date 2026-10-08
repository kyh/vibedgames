import { SHIP_RADIUS } from "../shared/constants";
import type { Vec, Weapon } from "../shared/constants";
import type { MasteryShot } from "../shared/weapon-mastery";
import { dist2, segHitsCircle } from "./geometry";

/** The simulated beam — mine, or a remote player's rebuilt from its fire event — its shape and hit tests. */

/** What a HOMING beam (or ARC hop) is steering toward / hit. */
export type TargetRef =
  | { kind: "enemy"; id: string }
  | { kind: "player"; id: string }
  | { kind: "ufo" }
  | { kind: "asteroid"; id: string };

/** A simulated beam: my own, or a remote player's rebuilt from its `fire`
 *  event (sys/remote-fire.ts). Its deadlines are on the shooter's clock. */
export interface Beam {
  head: Vec;
  tail: Vec;
  angle: number;
  weapon: Weapon;
  released: boolean;
  exploding: boolean;
  explosionRadius: number;
  vanished: boolean;
  /** HOMING: live lock; null = fly straight. */
  target: TargetRef | null;
  /** Targets this beam already damaged — once per beam lifetime (per pass for
   *  GLAIVE: cleared at turnaround). Stops through-beams re-hitting every
   *  frame of overlap and explosions double-damaging. */
  hitIds: Set<string>;
  /** GLAIVE boomerang state. */
  glaive: { returning: boolean; traveled: number } | null;
  /** ARC: bolt anchor points (damage applied at cast; render-only afterwards). */
  chain: Vec[] | null;
  /** ARC fizzle bolt: render-only and never sent (must not hit PvP victims). */
  fizzle: boolean;
  /** ARC render expiry / MINE lifetime expiry (0 = neither). */
  diesAt: number;
  /** MINE: arm timestamp (inert + blinking until then; explodes on trigger). */
  mine: { armAt: number } | null;
  /** RICOCHET: bounces remaining off asteroids/world edges. */
  bouncesLeft: number;
  /** SINGULARITY: collapse window end (0 = not collapsing). The orb is
   *  frozen while now < this; at expiry it pops (exploding). */
  collapseUntil: number;
  /** Distance flown since the muzzle (FLAK airburst trigger). */
  traveled: number;
  /** GLAIVE visual spin. */
  spin: number;
  /** HUD mastery tracking for the local RAILGUN/GLAIVE window; null otherwise. */
  mastery: MasteryShot | null;
}

/** Beams vanish this far outside the world. */
export const BEAM_CULL_MARGIN = 200;

/** A fresh beam leaving `origin` along `angle` — the one constructor for mine
 *  and for every remote copy, so both fly the same shot. */
export const newBeam = (origin: Vec, angle: number, weapon: Weapon, now: number): Beam => {
  const b: Beam = {
    angle,
    bouncesLeft: weapon.ricochet?.bounces ?? 0,
    chain: null,
    collapseUntil: 0,
    // Range-limited beams (PLASMA stream, SINGULARITY flight) expire after
    // range px of travel; everything else rides 0 (callers may override).
    diesAt: weapon.range > 0 && weapon.speed > 0 ? now + (weapon.range / weapon.speed) * 1000 : 0,
    exploding: false,
    explosionRadius: 0,
    fizzle: false,
    glaive: weapon.boomerang ? { returning: false, traveled: 0 } : null,
    head: { ...origin },
    hitIds: new Set(),
    mastery: null,
    mine: null,
    released: false,
    // desync glaive spin phases a little
    spin: now % 1000,
    tail: { ...origin },
    target: null,
    traveled: 0,
    vanished: false,
    weapon,
  };
  if (weapon.windupMs > 0 && weapon.length > 0) {
    // RAILGUN: near-hitscan — the full lance renders (and hits) immediately.
    b.head.x += Math.cos(angle) * weapon.length;
    b.head.y += Math.sin(angle) * weapon.length;
    b.released = true;
  }
  return b;
};

/** Does a beam touch a circle: the blast disc while exploding, else the
 *  tail→head segment. Width is half-padded into the segment test so wide
 *  beams (DRILL 8px) hit what they visually cover, not just their axis. */
export const beamHitsCircle = (b: Beam, cx: number, cy: number, r: number): boolean => {
  if (b.exploding) {
    return dist2(b.head.x, b.head.y, cx, cy) <= b.explosionRadius * b.explosionRadius;
  }
  return segHitsCircle(b.tail.x, b.tail.y, b.head.x, b.head.y, cx, cy, r + b.weapon.width / 2);
};

/** Which part of a beam touches the ship at (x,y): the index of the ARC chain
 *  segment that hit (0 for plain beams and blasts), or null for a miss. */
export const beamHitSeg = (b: Beam, x: number, y: number): number | null => {
  if (b.chain && b.chain.length >= 2) {
    const pad = SHIP_RADIUS + b.weapon.width / 2;
    for (let i = 0; i < b.chain.length - 1; i += 1) {
      const p0 = b.chain[i];
      const p1 = b.chain[i + 1];
      if (p0 && p1 && segHitsCircle(p0.x, p0.y, p1.x, p1.y, x, y, pad)) {
        return i;
      }
    }
    return null;
  }
  return beamHitsCircle(b, x, y, SHIP_RADIUS) ? 0 : null;
};

export const targetKey = (ref: TargetRef): string =>
  ref.kind === "ufo" ? "ufo" : `${ref.kind}:${ref.id}`;

/** A lock as it rides a fire event: one letter, then the target's id. */
export const encodeTarget = (ref: TargetRef): string =>
  ref.kind === "ufo" ? "u" : `${ref.kind.charAt(0)}${ref.id}`;

export const decodeTarget = (code: string): TargetRef | null => {
  const id = code.slice(1);
  switch (code.charAt(0)) {
    case "e": {
      return { id, kind: "enemy" };
    }
    case "p": {
      return { id, kind: "player" };
    }
    case "a": {
      return { id, kind: "asteroid" };
    }
    case "u": {
      return { kind: "ufo" };
    }
    default: {
      return null;
    }
  }
};
