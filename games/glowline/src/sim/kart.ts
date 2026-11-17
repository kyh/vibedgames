// One kart's arcade physics on the track plane (x, z). Height is cosmetic: the
// road's hills come from the track sample under the kart.
//
// Heading `a` is radians with forward = (cos a, sin a); a positive steer turns
// right (clockwise seen from above, +x towards +z).

import {
  ACCEL,
  BOOST_ACCEL,
  BOOST_SECONDS,
  BOOST_SPEED,
  BOOST_TIERS,
  BRAKE,
  COAST_DRAG,
  DRIFT_BASE_TURN,
  DRIFT_MIN_SPEED,
  DRIFT_MIN_STEER,
  DRIFT_STEER_RANGE,
  GRIP,
  GRIP_DRIFT,
  GRIP_SHOULDER,
  GRIP_SLICK,
  LAPS,
  MAX_SPEED,
  OWN_PAINT_ACCEL,
  OWN_PAINT_SPEED,
  RAIL_SCRUB,
  REVERSE_SPEED,
  RIVAL_PAINT_SPEED,
  SHOULDER_SPEED,
  STEER_FULL_SPEED,
  STEER_SMOOTH,
  STEER_SPEED_FALLOFF,
  TURN_RATE,
} from "../shared/constants";
import { locate, pointAt } from "./track";
import type { Track } from "./track";

export interface KartInput {
  /** -1 left … 1 right. */
  steer: number;
  /** 0 … 1. */
  throttle: number;
  /** 0 … 1; reverses once stopped. */
  brake: number;
  drift: boolean;
}

export type Surface = "road" | "own" | "rival" | "shoulder";

export interface Kart {
  x: number;
  z: number;
  a: number;
  vx: number;
  vz: number;
  /** Smoothed steering, what the wheels show. */
  steer: number;
  /** -1 / 0 / 1: which way the current drift slides. */
  drift: number;
  /** Seconds the current drift has been held. */
  charge: number;
  /** Seconds of boost left. */
  boost: number;
  /** Nearest track sample (the hint for the next locate). */
  idx: number;
  /** Fractional lap position at the last step, in samples. */
  s: number;
  /** Lap progress in samples since the start line; grid slots start negative. */
  prog: number;
  /** Signed distance from the centreline. */
  lat: number;
  /** Road height under the kart. */
  h: number;
  surface: Surface;
  /** Room clock (ms) when the kart crossed the line for the last time; 0 until then. */
  finishMs: number;
}

/** What one step did, for effects and sound. */
export interface KartEvents {
  /** Boost tier fired on drift release: 0 none, 1–3. */
  boosted: number;
  driftStarted: boolean;
  /** Impact speed against the rail this step, 0 if none. */
  railHit: number;
}

export const NO_INPUT: KartInput = { brake: 0, drift: false, steer: 0, throttle: 0 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Shortest signed difference between two angles. */
export const angleDelta = (to: number, from: number): number => {
  const d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) {
    return d - Math.PI * 2;
  }
  return d < -Math.PI ? d + Math.PI * 2 : d;
};

/** Boost tier a drift of `charge` seconds has earned (0–3). */
export const boostTier = (charge: number): number => {
  let tier = 0;
  for (const need of BOOST_TIERS) {
    if (charge >= need) {
      tier += 1;
    }
  }
  return tier;
};

/** A kart parked on grid slot `slot` (0 = pole), two abreast behind the line. */
export const spawnKart = (track: Track, slot: number): Kart => {
  const row = Math.floor(slot / 2);
  const side = slot % 2 === 0 ? -1 : 1;
  const s = -6 - row * 5 - (slot % 2) * 2;
  const point = pointAt(track, s, side * track.halfWidth * 0.42);
  const where = locate(track, point.x, point.z, -1);
  return {
    a: point.a,
    boost: 0,
    charge: 0,
    drift: 0,
    finishMs: 0,
    h: where.h,
    idx: where.i,
    lat: where.lat,
    prog: s,
    s: where.s,
    steer: 0,
    surface: "road",
    vx: 0,
    vz: 0,
    x: point.x,
    z: point.z,
  };
};

export const kartSpeed = (kart: Kart): number => Math.hypot(kart.vx, kart.vz);

export const kartLap = (kart: Kart, track: Track): number =>
  clamp(Math.floor(kart.prog / track.n) + 1, 1, LAPS);

export const raceLength = (track: Track): number => track.n * LAPS;

const surfaceUnder = (kart: Kart, track: Track, paintOwner: number, slot: number): Surface => {
  if (Math.abs(kart.lat) > track.halfWidth) {
    return "shoulder";
  }
  if (paintOwner === 0) {
    return "road";
  }
  return paintOwner === slot ? "own" : "rival";
};

/** Start, hold or release a drift; a release cashes the charge in as boost. */
const stepDrift = (
  kart: Kart,
  input: KartInput,
  vf: number,
  dt: number,
  events: KartEvents,
): void => {
  if (kart.drift === 0) {
    if (input.drift && Math.abs(input.steer) > DRIFT_MIN_STEER && vf > DRIFT_MIN_SPEED) {
      kart.drift = Math.sign(input.steer);
      kart.charge = 0;
      events.driftStarted = true;
    }
    return;
  }
  if (input.drift && vf >= DRIFT_MIN_SPEED * 0.6 && kart.surface !== "shoulder") {
    // Steering into the slide charges faster than holding it wide.
    kart.charge += dt * (0.7 + 0.5 * Math.max(0, kart.steer * kart.drift));
    return;
  }
  // Spinning down or sliding off the road under the button is a fizzle; letting go is the boost.
  const tier = input.drift ? 0 : boostTier(kart.charge);
  if (tier > 0) {
    kart.boost = Math.max(kart.boost, BOOST_SECONDS[tier - 1] ?? 0);
    events.boosted = tier;
  }
  kart.drift = 0;
  kart.charge = 0;
};

interface Limits {
  top: number;
  accel: number;
  grip: number;
}

const limitsFor = (kart: Kart): Limits => {
  const drifting = kart.drift !== 0;
  switch (kart.surface) {
    case "own": {
      return {
        accel: ACCEL * OWN_PAINT_ACCEL,
        grip: drifting ? GRIP_DRIFT : GRIP,
        top: MAX_SPEED * OWN_PAINT_SPEED,
      };
    }
    case "rival": {
      return {
        accel: ACCEL,
        grip: drifting ? GRIP_DRIFT : GRIP_SLICK,
        top: MAX_SPEED * RIVAL_PAINT_SPEED,
      };
    }
    case "shoulder": {
      return {
        accel: ACCEL,
        grip: drifting ? GRIP_DRIFT : GRIP_SHOULDER,
        top: MAX_SPEED * SHOULDER_SPEED,
      };
    }
    default: {
      return { accel: ACCEL, grip: drifting ? GRIP_DRIFT : GRIP, top: MAX_SPEED };
    }
  }
};

/** Forward speed after throttle, brake, boost and drag. */
const stepForward = (
  kart: Kart,
  input: KartInput,
  vf: number,
  limits: Limits,
  dt: number,
): number => {
  if (kart.boost > 0) {
    kart.boost = Math.max(0, kart.boost - dt);
    return Math.min(limits.top + BOOST_SPEED, vf + BOOST_ACCEL * dt);
  }
  if (input.brake > 0) {
    const slowed =
      vf > 0.5 ? Math.max(0, vf - BRAKE * input.brake * dt) : vf - ACCEL * 0.6 * input.brake * dt;
    return Math.max(slowed, -REVERSE_SPEED);
  }
  if (input.throttle > 0) {
    const goal = limits.top * clamp(input.throttle, 0, 1);
    if (vf < goal) {
      return Math.min(goal, vf + limits.accel * (1 - 0.55 * clamp(vf / limits.top, 0, 1)) * dt);
    }
    // Over this surface's top speed (boost ran out, drove onto a slick): bleed down.
    return vf - (vf - goal) * Math.min(1, 1.8 * dt);
  }
  return vf - vf * Math.min(1, COAST_DRAG * dt);
};

/** Most the rail turns a kart's nose in one step (radians). */
const RAIL_ASSIST = 0.06;

/** Keep the kart inside the rails and book the distance it covered. */
const stepCorridor = (kart: Kart, track: Track, events: KartEvents): void => {
  let where = locate(track, kart.x, kart.z, kart.idx);
  if (Math.abs(where.lat) > track.rail) {
    const nx = -(track.tz[where.i] ?? 0);
    const nz = track.tx[where.i] ?? 1;
    const side = Math.sign(where.lat);
    const over = Math.abs(where.lat) - track.rail;
    kart.x -= nx * side * over;
    kart.z -= nz * side * over;
    const out = (kart.vx * nx + kart.vz * nz) * side;
    if (out > 0) {
      kart.vx -= nx * side * out * 1.25;
      kart.vz -= nz * side * out * 1.25;
      events.railHit = out;
    }
    kart.vx *= RAIL_SCRUB;
    kart.vz *= RAIL_SCRUB;
    // Rail assist: ease the nose round to run along the rail, so a kart that
    // hits it head-on slides away instead of parking against it.
    const along = Math.atan2(track.tz[where.i] ?? 0, track.tx[where.i] ?? 1);
    kart.a += clamp(angleDelta(along, kart.a), -RAIL_ASSIST, RAIL_ASSIST);
    where = locate(track, kart.x, kart.z, where.i);
  }
  let moved = where.s - kart.s;
  if (moved > track.n / 2) {
    moved -= track.n;
  } else if (moved < -track.n / 2) {
    moved += track.n;
  }
  kart.prog += moved;
  kart.s = where.s;
  kart.idx = where.i;
  kart.lat = where.lat;
  kart.h = where.h;
};

/**
 * Advance `kart` by `dt` seconds. `paintOwner` is the slot whose paint is under
 * the kart (0 none) and `slot` the kart's own, so the sim knows friend from foe
 * without knowing who anyone is.
 */
export const stepKart = (
  kart: Kart,
  input: KartInput,
  track: Track,
  dt: number,
  paintOwner: number,
  slot: number,
): KartEvents => {
  const events: KartEvents = { boosted: 0, driftStarted: false, railHit: 0 };
  kart.surface = surfaceUnder(kart, track, paintOwner, slot);

  const fx = Math.cos(kart.a);
  const fz = Math.sin(kart.a);
  const vf = kart.vx * fx + kart.vz * fz;
  const vl = kart.vx * -fz + kart.vz * fx;

  kart.steer += (clamp(input.steer, -1, 1) - kart.steer) * Math.min(1, dt / STEER_SMOOTH);
  stepDrift(kart, input, vf, dt, events);

  const speedShare = clamp(Math.abs(vf) / STEER_FULL_SPEED, 0, 1);
  const authority = speedShare * (1 - STEER_SPEED_FALLOFF * clamp(vf / MAX_SPEED, 0, 1));
  const wheel =
    kart.drift === 0
      ? kart.steer
      : kart.drift * (DRIFT_BASE_TURN + DRIFT_STEER_RANGE * kart.steer * kart.drift);
  kart.a += wheel * TURN_RATE * authority * dt * (vf < 0 ? -1 : 1);

  const limits = limitsFor(kart);
  const nextVf = stepForward(kart, input, vf, limits, dt);
  const nextVl = vl * Math.exp(-limits.grip * dt);

  const nfx = Math.cos(kart.a);
  const nfz = Math.sin(kart.a);
  kart.vx = nfx * nextVf - nfz * nextVl;
  kart.vz = nfz * nextVf + nfx * nextVl;
  kart.x += kart.vx * dt;
  kart.z += kart.vz * dt;

  stepCorridor(kart, track, events);
  return events;
};
