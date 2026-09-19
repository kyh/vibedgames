import { SHIP_RADIUS } from "../shared/constants";
import type { SerializedBeam, Vec, Weapon } from "../shared/constants";
import type { MasteryShot } from "../shared/weapon-mastery";
import { dist2, segHitsCircle } from "./geometry";

/** The locally-simulated beam: its shape, hit tests, and the wire form remotes render. */

/** What a HOMING beam (or ARC hop) is steering toward / hit. */
export type TargetRef =
  | { kind: "enemy"; id: string }
  | { kind: "player"; id: string }
  | { kind: "ufo" }
  | { kind: "asteroid"; id: string };

/** A locally-simulated beam (only ever our own — remote beams arrive serialized). */
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
  /** ARC fizzle bolt: render-only, never serialized (must not hit PvP victims). */
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

export const serializeBeam = (b: Beam): SerializedBeam => {
  if (b.chain && b.chain.length >= 2) {
    const [first] = b.chain;
    const last = b.chain.at(-1);
    return {
      chain: b.chain,
      exploding: false,
      explosionRadius: 0,
      hx: last?.x ?? b.head.x,
      hy: last?.y ?? b.head.y,
      power: b.weapon.power,
      tint: b.weapon.tint,
      tx: first?.x ?? b.tail.x,
      ty: first?.y ?? b.tail.y,
      width: b.weapon.width,
    };
  }
  const sb: SerializedBeam = {
    exploding: b.exploding,
    explosionRadius: b.explosionRadius,
    hx: b.head.x,
    hy: b.head.y,
    power: b.weapon.power,
    tint: b.weapon.tint,
    tx: b.tail.x,
    ty: b.tail.y,
    width: b.weapon.width,
  };
  if (b.glaive) {
    sb.glaive = true;
  }
  if (b.mine) {
    sb.mine = true;
  }
  if (b.weapon.singularity && !b.exploding) {
    sb.orb = true;
  }
  return sb;
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

/** Which part of a serialized beam touches the ship at (x,y): the index of
 *  the ARC chain segment that hit (0 for plain beams and blasts), or null
 *  for a miss. Width is render-real: padded by half so wide beams hit
 *  their cover. */
export const serializedBeamHitSeg = (sb: SerializedBeam, x: number, y: number): number | null => {
  const pad = SHIP_RADIUS + sb.width / 2;
  if (sb.chain && sb.chain.length >= 2) {
    for (let i = 0; i < sb.chain.length - 1; i += 1) {
      const p0 = sb.chain[i];
      const p1 = sb.chain[i + 1];
      if (p0 && p1 && segHitsCircle(p0.x, p0.y, p1.x, p1.y, x, y, pad)) {
        return i;
      }
    }
    return null;
  }
  if (sb.exploding) {
    return dist2(sb.hx, sb.hy, x, y) <= sb.explosionRadius * sb.explosionRadius ? 0 : null;
  }
  return segHitsCircle(sb.tx, sb.ty, sb.hx, sb.hy, x, y, pad) ? 0 : null;
};

export const targetKey = (ref: TargetRef): string =>
  ref.kind === "ufo" ? "ufo" : `${ref.kind}:${ref.id}`;
