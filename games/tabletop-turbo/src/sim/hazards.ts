import {
  BUMPER_DAMAGE,
  BUMPER_THROW,
  PISTON_DAMAGE,
  PISTON_OUT,
  PISTON_THROW,
  PISTON_WARN,
  ROUND_MS,
  SHRINK_MS,
  SHRINK_WARN_MS,
  SWEEPER_DAMAGE,
  SWEEPER_THROW,
} from "../shared/constants";
import { edgeDistance } from "./arena";
import type { Arena, HazardDef } from "./arena";
import type { Hit } from "./car";

type Piston = Extract<HazardDef, { kind: "piston" }>;

type Sweeper = Extract<HazardDef, { kind: "sweeper" }>;

const PISTON_SHOOT = 0.12;
const PISTON_BACK = 0.8;

/** Half the width of a sweeper arm, and of a piston's head. */
export const ARM_HALF = 0.5;
export const HEAD_HALF = 1.7;

const wrap = (v: number, period: number) => ((v % period) + period) % period;

/** Where the sweeper's arm points at `time` seconds into the round. */
export const sweeperAngle = (hazard: Sweeper, time: number) => hazard.phase + hazard.rate * time;

/**
 * A piston at `time`: `out` is how far the head is along its lane (0–1), `warn`
 * how close it is to firing (0 idle … 1 about to), `firing` true while it shoots.
 */
export const pistonAt = (hazard: Piston, time: number) => {
  const t = wrap(time + hazard.phase, hazard.period);
  const until = hazard.period - t;

  if (t < PISTON_SHOOT) {
    return { firing: true, out: t / PISTON_SHOOT, warn: 0 };
  }

  if (t < PISTON_OUT) {
    return { firing: false, out: 1, warn: 0 };
  }

  if (t < PISTON_OUT + PISTON_BACK) {
    return { firing: false, out: 1 - (t - PISTON_OUT) / PISTON_BACK, warn: 0 };
  }

  return { firing: false, out: 0, warn: until < PISTON_WARN ? 1 - until / PISTON_WARN : 0 };
};

/**
 * Has this toy gone with the rim? A piston stands just off the edge it fires
 * across, so it is judged by the board a little way down its lane.
 */
export const hazardGone = (arena: Arena, hazard: HazardDef, late: boolean) => {
  if (!late) {
    return false;
  }

  const reach = hazard.kind === "piston" ? 3 : 0;
  const a = hazard.kind === "piston" ? hazard.a : 0;

  return (
    edgeDistance(arena, hazard.x + Math.cos(a) * reach, hazard.z + Math.sin(a) * reach, true) < 0
  );
};

/** The board's rim at `ms` into the round: blinking, gone, and how far it has dropped. */
export const shrinkAt = (ms: number) => {
  const since = ms - (ROUND_MS - SHRINK_MS);

  return {
    drop: since > SHRINK_WARN_MS ? ((since - SHRINK_WARN_MS) / 1000) ** 2 * 30 : 0,
    late: since >= SHRINK_WARN_MS,
    warn: since >= 0 && since < SHRINK_WARN_MS,
  };
};

const sweeperHit = (
  hazard: Sweeper,
  index: number,
  time: number,
  x: number,
  z: number,
  r: number,
) => {
  const angle = sweeperAngle(hazard, time);
  const ax = Math.cos(angle);
  const az = Math.sin(angle);
  const ox = x - hazard.x;
  const oz = z - hazard.z;
  const along = Math.min(hazard.length, Math.max(-hazard.length, ox * ax + oz * az));
  const px = ox - ax * along;
  const pz = oz - az * along;
  const gap = Math.hypot(px, pz);

  if (gap > r + ARM_HALF) {
    return null;
  }

  const turn = Math.sign(hazard.rate) * Math.sign(along || 1);
  const tx = -az * turn;
  const tz = ax * turn;
  const out = Math.sign(along || 1);
  const dx = tx * 0.8 + ax * out * 0.6;
  const dz = tz * 0.8 + az * out * 0.6;
  const length = Math.hypot(dx, dz) || 1;

  return {
    by: "",
    damage: SWEEPER_DAMAGE,
    dx: dx / length,
    dz: dz / length,
    how: "sweeper",
    id: `hz-s${index}:${Math.floor(time * 4)}`,
    lift: 1,
    reach: SWEEPER_THROW,
    stun: 0,
  } satisfies Hit;
};

const pistonHit = (
  hazard: Piston,
  index: number,
  at: { time: number; skipped: number },
  x: number,
  z: number,
  r: number,
) => {
  const { skipped, time } = at;
  const state = pistonAt(hazard, time);
  const missed = wrap(time + hazard.phase, hazard.period) - skipped < PISTON_SHOOT;

  if (!state.firing && !missed) {
    return null;
  }

  const out = state.firing ? state.out : 1;

  const fx = Math.cos(hazard.a);
  const fz = Math.sin(hazard.a);
  const along = (x - hazard.x) * fx + (z - hazard.z) * fz;
  const across = Math.abs(-(x - hazard.x) * fz + (z - hazard.z) * fx);

  if (across > HEAD_HALF + r * 0.6 || along < 0 || along > out * hazard.reach + 1.2 + r) {
    return null;
  }

  return {
    by: "",
    damage: PISTON_DAMAGE,
    dx: fx,
    dz: fz,
    how: "piston",
    id: `hz-p${index}:${Math.floor((time + hazard.phase) / hazard.period)}`,
    lift: 1,
    reach: PISTON_THROW,
    stun: 0,
  } satisfies Hit;
};

/**
 * The blow, if any, the board's toys deal a body of radius `r` at (x, z) right
 * now. `skipped` is how many seconds the clock jumped to get here: a piston
 * that fired inside the jump still hits.
 */
export const hazardHit: (
  arena: Arena,
  time: number,
  x: number,
  z: number,
  r: number,
  late?: boolean,
  skipped?: number,
) => Hit | null = (arena, time, x, z, r, late = false, skipped = 0) => {
  for (const [index, hazard] of arena.def.hazards.entries()) {
    if (hazardGone(arena, hazard, late)) {
      continue;
    }

    if (hazard.kind === "bumper") {
      const dx = x - hazard.x;
      const dz = z - hazard.z;
      const gap = Math.hypot(dx, dz);

      if (gap < hazard.r + r) {
        return {
          by: "",
          damage: BUMPER_DAMAGE,
          dx: dx / (gap || 1),
          dz: dz / (gap || 1),
          how: "bumper",
          id: `hz-b${index}:${Math.floor(time * 4)}`,
          lift: 1,
          reach: BUMPER_THROW,
          stun: 0,
        };
      }
    } else {
      const hit =
        hazard.kind === "sweeper"
          ? sweeperHit(hazard, index, time, x, z, r)
          : pistonHit(hazard, index, { skipped, time }, x, z, r);

      if (hit) {
        return hit;
      }
    }
  }

  return null;
};

const sweeperEta = (hazard: Sweeper, time: number, ox: number, oz: number) => {
  const far = Math.hypot(ox, oz);
  const wide = Math.asin(Math.min(1, 1.9 / Math.max(far, 0.01)));
  const angle = sweeperAngle(hazard, time);
  const ahead = wrap((Math.atan2(oz, ox) - angle) * Math.sign(hazard.rate), Math.PI);

  return ahead > Math.PI - wide ? 0 : Math.max(0, ahead - wide) / Math.abs(hazard.rate);
};

/**
 * How unsafe (x, z) is about to be, 0–1: inside the sweep of an arm that is
 * coming, or in the lane of a piston about to fire. Bots steer by it.
 */
export const hazardThreat = (arena: Arena, time: number, x: number, z: number, late = false) => {
  let worst = 0;

  for (const hazard of arena.def.hazards) {
    if (hazardGone(arena, hazard, late)) {
      continue;
    }

    if (hazard.kind === "bumper") {
      const gap = Math.hypot(x - hazard.x, z - hazard.z) - hazard.r;
      worst = Math.max(worst, gap < 1.6 ? 0.7 : 0);
    } else if (hazard.kind === "sweeper") {
      const ox = x - hazard.x;
      const oz = z - hazard.z;
      const far = Math.hypot(ox, oz);

      if (far < hazard.length + 1.6) {
        const seconds = sweeperEta(hazard, time, ox, oz);
        worst = Math.max(worst, seconds < 0.9 ? 1 - seconds / 0.9 : 0);
      }
    } else {
      const state = pistonAt(hazard, time);
      const fx = Math.cos(hazard.a);
      const fz = Math.sin(hazard.a);
      const along = (x - hazard.x) * fx + (z - hazard.z) * fz;
      const across = Math.abs(-(x - hazard.x) * fz + (z - hazard.z) * fx);

      if (across < HEAD_HALF + 1.4 && along > -1 && along < hazard.reach + 2.5) {
        const warned = state.warn > 0 ? 0.9 : 0;
        worst = Math.max(worst, state.firing ? 1 : warned);
      }
    }
  }

  return worst;
};

/**
 * The way out of whatever is about to hit (x, z): a unit vector, or null when
 * nothing is coming.
 */
export const hazardEscape = (arena: Arena, time: number, x: number, z: number, late = false) => {
  for (const hazard of arena.def.hazards) {
    if (hazardGone(arena, hazard, late)) {
      continue;
    }

    const ox = x - hazard.x;
    const oz = z - hazard.z;
    const far = Math.hypot(ox, oz) || 1;

    if (hazard.kind === "sweeper" && far < hazard.length + 1.8) {
      if (sweeperEta(hazard, time, ox, oz) < 1.1) {
        return { x: ox / far, z: oz / far };
      }
    } else if (hazard.kind === "piston") {
      const state = pistonAt(hazard, time);
      const fx = Math.cos(hazard.a);
      const fz = Math.sin(hazard.a);
      const along = ox * fx + oz * fz;
      const across = -ox * fz + oz * fx;
      const live = state.firing || state.warn > 0;

      if (live && Math.abs(across) < HEAD_HALF + 1.6 && along > -1 && along < hazard.reach + 3) {
        const side = across >= 0 ? 1 : -1;

        return { x: -fz * side, z: fx * side };
      }
    }
  }

  return null;
};
