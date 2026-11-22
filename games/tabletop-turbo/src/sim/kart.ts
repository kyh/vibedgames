import {
  ACCEL,
  BOOST_ACCEL,
  BOOST_SECONDS,
  BOOST_SPEED,
  BOOST_TIERS,
  BRAKE,
  CHASSIS,
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
  ORB_LOSS,
  ORB_SPEED,
  OWN_PAINT_ACCEL,
  OWN_PAINT_SPEED,
  RAIL_SCRUB,
  REVERSE_SPEED,
  RIVAL_PAINT_SPEED,
  SHOULDER_SPEED,
  SPIN_SECONDS,
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
  /** Glow orbs carried, 0 … ORB_MAX. */
  orbs: number;
  /** Seconds of spin-out left: no steering, no gas. */
  spin: number;
  /** Seconds of immunity to rival paint left. */
  proof: number;
  /** Which chassis: an index into CHASSIS. */
  chassis: number;
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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Shortest signed difference between two angles. */
export const angleDelta = (to: number, from: number) => {
  const d = (to - from) % (Math.PI * 2);

  if (d > Math.PI) {
    return d - Math.PI * 2;
  }

  return d < -Math.PI ? d + Math.PI * 2 : d;
};

/** Boost tier a drift of `charge` seconds has earned (0–3). */
export const boostTier = (charge: number) => {
  let tier = 0;

  for (const need of BOOST_TIERS) {
    if (charge >= need) {
      tier += 1;
    }
  }

  return tier;
};

/** A kart parked on grid slot `slot` (0 = pole), two abreast behind the line. */
export const spawnKart: (track: Track, slot: number, chassis?: number) => Kart = (
  track,
  slot,
  chassis = 0,
) => {
  const row = Math.floor(slot / 2);
  const side = slot % 2 === 0 ? -1 : 1;
  const s = -6 - row * 5 - (slot % 2) * 2;
  const point = pointAt(track, s, side * track.halfWidth * 0.42);
  const where = locate(track, point.x, point.z, -1);

  return {
    a: point.a,
    boost: 0,
    charge: 0,
    chassis,
    drift: 0,
    finishMs: 0,
    h: where.h,
    idx: where.i,
    lat: where.lat,
    orbs: 0,
    prog: s,
    proof: 0,
    s: where.s,
    spin: 0,
    steer: 0,
    surface: "road",
    vx: 0,
    vz: 0,
    x: point.x,
    z: point.z,
  };
};

export const kartSpeed = (kart: Kart) => Math.hypot(kart.vx, kart.vz);

export const kartLap = (kart: Kart, track: Track) =>
  clamp(Math.floor(kart.prog / track.n) + 1, 1, LAPS);

export const raceLength = (track: Track) => track.n * LAPS;

const surfaceUnder: (kart: Kart, track: Track, paintOwner: number, slot: number) => Surface = (
  kart,
  track,
  paintOwner,
  slot,
) => {
  if (Math.abs(kart.lat) > track.halfWidth) {
    return "shoulder";
  }

  if (paintOwner === 0) {
    return "road";
  }

  if (paintOwner === slot) {
    return "own";
  }

  return kart.proof > 0 ? "road" : "rival";
};

const stepDrift = (kart: Kart, input: KartInput, vf: number, dt: number, events: KartEvents) => {
  if (kart.drift === 0) {
    if (input.drift && Math.abs(input.steer) > DRIFT_MIN_STEER && vf > DRIFT_MIN_SPEED) {
      kart.drift = Math.sign(input.steer);
      kart.charge = 0;
      events.driftStarted = true;
    }

    return;
  }

  if (input.drift && vf >= DRIFT_MIN_SPEED * 0.6 && kart.surface !== "shoulder") {
    kart.charge += dt * (0.7 + 0.5 * Math.max(0, kart.steer * kart.drift));

    return;
  }

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

const surfaceLimits = (kart: Kart) => {
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

const limitsFor = (kart: Kart) => {
  const base = surfaceLimits(kart);
  const chassis = CHASSIS[kart.chassis] ?? CHASSIS[0];

  return {
    accel: base.accel * chassis.accel,
    grip: kart.drift === 0 ? base.grip * chassis.grip : base.grip,
    top: base.top * chassis.speed * (1 + kart.orbs * ORB_SPEED),
  };
};

/** Knock a kart into a spin: it loses its drift, its boost and a few orbs. */
export const spinOut = (kart: Kart) => {
  if (kart.spin > 0) {
    return;
  }

  kart.spin = SPIN_SECONDS;
  kart.drift = 0;
  kart.charge = 0;
  kart.boost = 0;
  kart.orbs = Math.max(0, kart.orbs - ORB_LOSS);
};

const stepForward = (kart: Kart, input: KartInput, vf: number, limits: Limits, dt: number) => {
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

    return vf - (vf - goal) * Math.min(1, 1.8 * dt);
  }

  return vf - vf * Math.min(1, COAST_DRAG * dt);
};

const RAIL_ASSIST = 0.06;

const stepCorridor = (kart: Kart, track: Track, events: KartEvents) => {
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
  driver: KartInput,
  track: Track,
  dt: number,
  paintOwner: number,
  slot: number,
) => {
  const events: KartEvents = { boosted: 0, driftStarted: false, railHit: 0 };
  kart.surface = surfaceUnder(kart, track, paintOwner, slot);
  kart.proof = Math.max(0, kart.proof - dt);
  const spinning = kart.spin > 0;
  kart.spin = Math.max(0, kart.spin - dt);
  const input = spinning ? NO_INPUT : driver;

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
  const driven = stepForward(kart, input, vf, limits, dt);
  const nextVf = spinning ? driven * Math.exp(-1.5 * dt) : driven;
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
