import { lerpTint } from "../render/tint";
import {
  ARC_RENDER_MS,
  MINE_ARM_MS,
  MINE_LIFETIME_MS,
  SHIELD_MOD_SPECS,
  SHIP_RADIUS,
  TWIN_ORBIT_RADIUS,
  TWIN_POWER_MULT,
  WEAPONS_SPECIAL,
  WEAPON_DEFAULT,
} from "../shared/constants";
import type { Vec, Weapon } from "../shared/constants";
import { mulberry32 } from "../shared/rng";
import { newBeam } from "./beam";
import type { Beam, TargetRef } from "./beam";
import { DEG } from "./geometry";

/**
 * A trigger pull as data. The shooter builds its beams from a FireSpec and
 * sends the same spec as a `fire` event (net/fire-wire.ts); every other client
 * rebuilds identical beams from it and flies them itself (sys/remote-fire.ts).
 * Bullets are events, not arrays streamed in player state.
 */

/** What left the gun: a weapon volley (pellets, a mine, a NOVA ring), a SENTRY
 *  turret bolt, a REFLECT return bolt, or an ARC / TESLA bolt with its hops. */
export type FireKind = "volley" | "turret" | "reflect" | "chain";

export interface FireSpec {
  kind: FireKind;
  /** When the trigger was pulled: the shooter's sim clock for its own beams;
   *  on the wire, server time — the clock its pose is stamped with, so
   *  receivers play the shot on the timeline the hull is drawn on. */
  t: number;
  /** WEAPONS_SPECIAL index, or one of the FIRE_* codes (net/fire-wire.ts). */
  code: number;
  /** Shooter level the weapon was scaled for. */
  level: number;
  weapon: Weapon;
  /** Ship centre (the turret for a turret bolt) and aim. */
  x: number;
  y: number;
  angle: number;
  /** Seeds the per-pellet jitter (16 bits), so every client fans the same spread. */
  seed: number;
  /** TWIN drone orbit angle at the shot; null without the booster. */
  twin: number | null;
  /** HOMING locks taken by the shooter at the nose and at the twin drone. */
  lock: TargetRef | null;
  twinLock: TargetRef | null;
  /** ARC / TESLA bolt anchors, muzzle first. */
  chain: Vec[] | null;
}

/** SENTRY stat block: the turret keeps firing it even after the owner's
 *  weapon slot moves on (the turret outlives the trigger). */
export const SENTRY_WEAPON = WEAPONS_SPECIAL.find((w) => w.sentry) ?? WEAPON_DEFAULT;

/** REFLECT return bolt: NORMAL stats in the mod's tint. */
export const REFLECT_WEAPON: Weapon = { ...WEAPON_DEFAULT, tint: SHIELD_MOD_SPECS.reflect.tint };

/** PLASMA CONE per-shot tint gradient endpoints (hot pink -> orange). */
export const PLASMA_TINT_A = 0xff_2d_78;

export const PLASMA_TINT_B = 0xff_9a_3d;

/** A NOVA-family weapon: a ring centred on the ship, no projectile. */
export const isNova = (w: Weapon): boolean => w.explosion !== null && w.speed === 0;

/** TWIN drone position for an orbit angle around a ship. */
export const twinOrigin = (x: number, y: number, orbit: number): Vec => ({
  x: x + Math.cos(orbit) * TWIN_ORBIT_RADIUS,
  y: y + Math.sin(orbit) * TWIN_ORBIT_RADIUS,
});

/** The pellet/spread loop, parameterized by origin (ship nose or TWIN drone). */
const pellets = (
  out: Beam[],
  origin: Vec,
  aim: number,
  weapon: Weapon,
  lock: TargetRef | null,
  roll: () => number,
  now: number,
): void => {
  const n = weapon.pellets;
  for (let i = 0; i < n; i += 1) {
    const spread = n > 1 ? -weapon.spreadDeg / 2 + (weapon.spreadDeg * i) / (n - 1) : 0;
    const jitter = (roll() * 2 - 1) * weapon.jitterDeg;
    const b = newBeam(origin, aim + (spread + jitter) * DEG, weapon, now);
    b.target = weapon.homing ? lock : null;
    out.push(b);
  }
};

/** Pellets from the nose, the MIRROR copy from the tail, and the TWIN drone's
 *  weaker copies — one CLUSTER launch is one of these too. */
const pelletVolley = (spec: FireSpec, roll: () => number): Beam[] => {
  const { x, y, angle, t } = spec;
  // PLASMA: each shot picks its own point on the hot pink -> orange gradient.
  const w =
    spec.weapon.sfx === "plasma"
      ? { ...spec.weapon, tint: lerpTint(PLASMA_TINT_A, PLASMA_TINT_B, roll()) }
      : spec.weapon;
  const out: Beam[] = [];
  const nose = { x: x + Math.cos(angle) * SHIP_RADIUS, y: y + Math.sin(angle) * SHIP_RADIUS };
  pellets(out, nose, angle, w, spec.lock, roll, t);
  if (w.mirror) {
    const back = { x: x - Math.cos(angle) * SHIP_RADIUS, y: y - Math.sin(angle) * SHIP_RADIUS };
    pellets(out, back, angle + Math.PI, w, null, roll, t);
  }
  if (spec.twin !== null) {
    const drone = twinOrigin(x, y, spec.twin);
    const tw = { ...w, power: w.power * TWIN_POWER_MULT };
    pellets(out, drone, angle, tw, spec.twinLock, roll, t);
    if (tw.mirror) {
      pellets(out, drone, angle + Math.PI, tw, null, roll, t);
    }
  }
  return out;
};

/** Every beam one trigger pull puts in the air, built identically on the
 *  shooter and on every client that receives its `fire` event. */
export const buildVolley = (spec: FireSpec): Beam[] => {
  const { weapon: w, x, y, angle, t } = spec;
  switch (spec.kind) {
    case "chain": {
      const [muzzle] = spec.chain ?? [];
      const b = newBeam(muzzle ?? { x, y }, angle, w, t);
      b.chain = spec.chain;
      b.diesAt = t + ARC_RENDER_MS;
      return [b];
    }
    case "turret":
    case "reflect": {
      return [newBeam({ x, y }, angle, w, t)];
    }
    case "volley": {
      break;
    }
    default: {
      spec.kind satisfies never;
    }
  }
  if (w.mine) {
    const tail = {
      x: x - Math.cos(angle) * (SHIP_RADIUS + 4),
      y: y - Math.sin(angle) * (SHIP_RADIUS + 4),
    };
    const b = newBeam(tail, angle, w, t);
    b.released = true;
    b.mine = { armAt: t + MINE_ARM_MS };
    b.diesAt = t + MINE_LIFETIME_MS;
    return [b];
  }
  if (isNova(w)) {
    // NOVA: a radial shockwave centred on the ship, born exploding.
    const b = newBeam({ x, y }, angle, w, t);
    b.released = true;
    b.exploding = true;
    return [b];
  }
  return pelletVolley(spec, mulberry32(spec.seed));
};
