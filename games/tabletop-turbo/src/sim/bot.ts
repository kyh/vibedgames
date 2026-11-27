import { CAR_NOSE, PUNCH_REACH, SPRING_REACH } from "../shared/constants";
import { edgeDistance, inward } from "./arena";
import type { Arena } from "./arena";
import { wrapAngle } from "./car";
import type { Car, CarInput } from "./car";
import { hazardEscape, hazardThreat, shrinkAt } from "./hazards";
import type { Crate } from "./items";

/** What a bot sees of any other car. */
export interface BotView {
  key: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  alive: boolean;
  safe: boolean;
  human: boolean;
}

export interface BotBrain {
  /** A seeded 0–1 of its own, so two bots never think alike. */
  seed: number;
  target: string;
  /** Seconds until it may pick someone else, and until it next thinks at all. */
  holdT: number;
  thinkT: number;
  /** Where it is heading, as last decided. */
  gx: number;
  gz: number;
  /** Seconds left before the punch it has decided on, or -1 with none queued. */
  reactT: number;
  /** Radians its aim is off by for the next punch. */
  aimOff: number;
  /** Seconds of driving back to the middle after a hit, and of not minding the edge. */
  recoverT: number;
  carelessT: number;
  boost: boolean;
}

/** What the host shares between its bots so they do not all pile on one car. */
export interface Director {
  /** Target key → the bots on it. */
  chasing: Map<string, Set<string>>;
  /** Human key → the round time a bot last swung at them. */
  swungAt: Map<string, number>;
}

export const makeDirector: () => Director = () => ({ chasing: new Map(), swungAt: new Map() });

export const makeBrain: (index: number) => BotBrain = (index) => ({
  aimOff: 0,
  boost: false,
  carelessT: 0,
  gx: 0,
  gz: 0,
  holdT: 0,
  reactT: -1,
  recoverT: 0,
  seed: (index * 0.618034 + 0.137) % 1,
  target: "",
  thinkT: index * 0.03,
});

const HUMAN_SWING_GAP = 2.5;
const THINK = 1 / 6;
const FEELERS = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2.2, -2.2] as const;

const roll = (brain: BotBrain) => {
  brain.seed = (brain.seed * 9301 + 0.2113) % 1;

  return brain.seed;
};

const release = (director: Director, bot: string) => {
  for (const set of director.chasing.values()) {
    set.delete(bot);
  }
};

const pickTarget = (
  brain: BotBrain,
  car: Car,
  arena: Arena,
  late: boolean,
  views: readonly BotView[],
  director: Director,
) => {
  let best = "";
  let bestScore = Number.POSITIVE_INFINITY;

  for (const view of views) {
    const crowd = director.chasing.get(view.key)?.size ?? 0;

    if (view.key !== car.key && view.alive && !view.safe && crowd < 2) {
      const gap = Math.hypot(view.x - car.x, view.z - car.z);
      const edge = Math.max(0, edgeDistance(arena, view.x, view.z, late));
      const score = gap + edge * 1.6 + crowd * 6 + roll(brain) * 5;

      if (score < bestScore) {
        bestScore = score;
        best = view.key;
      }
    }
  }

  release(director, car.key);

  if (best !== "") {
    const set = director.chasing.get(best) ?? new Set<string>();
    set.add(car.key);
    director.chasing.set(best, set);
  }

  brain.target = best;
  brain.holdT = 1.5 + roll(brain) * 1.5;

  if (roll(brain) < 0.05) {
    brain.carelessT = 1.6;
  }
};

interface Sight {
  arena: Arena;
  time: number;
  late: boolean;
  views: readonly BotView[];
  crate: Crate | null;
  director: Director;
}

const clear = (arena: Arena, late: boolean, time: number, x: number, z: number, margin: number) =>
  edgeDistance(arena, x, z, late) > margin && hazardThreat(arena, time, x, z) < 0.6;

const pathClear = (
  car: Car,
  arena: Arena,
  late: boolean,
  time: number,
  a: number,
  look: number,
  margin: number,
) => {
  const cos = Math.cos(a);
  const sin = Math.sin(a);

  return (
    clear(arena, late, time, car.x + cos * look, car.z + sin * look, margin) &&
    clear(arena, late, time + 0.2, car.x + cos * look * 0.5, car.z + sin * look * 0.5, margin * 0.6)
  );
};

const wantsCrate = (car: Car, see: Sight) => {
  const { crate } = see;

  if (crate === null || car.bumper !== "plain" || car.mod !== "") {
    return null;
  }

  const near = Math.hypot(crate.x - car.x, crate.z - car.z) < 16;
  const there = edgeDistance(see.arena, crate.x, crate.z, see.late) > 0;

  return near && there && see.time >= crate.landAt - 1 ? crate : null;
};

const think = (brain: BotBrain, car: Car, see: Sight) => {
  let target = see.views.find((view) => view.key === brain.target);

  if (!target || !target.alive || target.safe || brain.holdT <= 0) {
    pickTarget(brain, car, see.arena, see.late, see.views, see.director);
    target = see.views.find((view) => view.key === brain.target);
  }

  const crate = wantsCrate(car, see);

  if (crate) {
    brain.gx = crate.x;
    brain.gz = crate.z;
  } else if (target) {
    const out = inward(see.arena, target.x, target.z, see.late);
    const tx = target.x - car.x;
    const tz = target.z - car.z;
    const gap = Math.hypot(tx, tz) || 1;
    const lined = -(tx * out.x + tz * out.z) / gap;
    const stand = lined > 0.3 || gap < 4 ? 0 : 3.6;
    brain.gx = target.x + out.x * stand;
    brain.gz = target.z + out.z * stand;
    brain.boost = gap > 9 && roll(brain) < 0.5;
  } else {
    brain.gx = 0;
    brain.gz = 3;
    brain.boost = false;
  }
};

const route = (brain: BotBrain, car: Car, see: Sight, here: number, margin: number) => {
  const { arena, late, time } = see;
  const safe = inward(arena, car.x, car.z, late);
  const home = brain.recoverT > 0 || here < margin;
  const want = home ? Math.atan2(safe.z, safe.x) : Math.atan2(brain.gz - car.z, brain.gx - car.x);
  const escape = brain.carelessT > 0 ? null : hazardEscape(arena, time, car.x, car.z);

  if (escape && here > margin) {
    return { blocked: true, heading: Math.atan2(escape.z, escape.x) };
  }

  const look = 2.2 + Math.hypot(car.vx, car.vz) * 0.28;

  for (const offset of FEELERS) {
    if (!escape && pathClear(car, arena, late, time, want + offset, look, margin)) {
      return { blocked: false, heading: want + offset };
    }
  }

  return { blocked: true, heading: Math.atan2(safe.z, safe.x) };
};

const swing = (brain: BotBrain, car: Car, target: BotView, see: Sight, dt: number) => {
  const lead = 0.42;
  const tx = target.x + target.vx * lead - (car.x + car.vx * lead);
  const tz = target.z + target.vz * lead - (car.z + car.vz * lead);
  const gap = Math.hypot(tx, tz);
  const reach = CAR_NOSE + PUNCH_REACH * (car.bumper === "spring" ? SPRING_REACH : 1) + 0.6;
  const off = Math.abs(wrapAngle(Math.atan2(tz, tx) + brain.aimOff - car.a));
  const last = see.director.swungAt.get(target.key) ?? -10;
  const allowed = !target.human || see.time - last > HUMAN_SWING_GAP;
  let fire = false;

  if (brain.reactT < 0 && gap < reach && off < 0.4 && allowed) {
    brain.reactT = 0.18 + roll(brain) * 0.17;
    brain.aimOff = (roll(brain) - 0.5) * 2 * (0.1 + roll(brain) * 0.14);
  } else if (brain.reactT >= 0) {
    brain.reactT -= dt;

    if (brain.reactT <= 0) {
      fire = gap < reach * 1.25 && off < 0.7;
      brain.reactT = -1;
    }
  }

  if (fire && target.human) {
    see.director.swungAt.set(target.key, see.time);
  }

  return gap < reach * 1.7 ? { aim: Math.atan2(tz, tx) + brain.aimOff, fire } : null;
};

const tick = (brain: BotBrain, car: Car, dt: number) => {
  brain.holdT -= dt;
  brain.thinkT -= dt;
  brain.carelessT = Math.max(0, brain.carelessT - dt);

  if (car.stagger > 0) {
    brain.recoverT = 0.4;
    brain.reactT = -1;
  } else {
    brain.recoverT = Math.max(0, brain.recoverT - dt);
  }
};

/** A bot's stick and buttons for this step. `time` is seconds into the round. */
export const botInput: (
  brain: BotBrain,
  car: Car,
  arena: Arena,
  time: number,
  views: readonly BotView[],
  crate: Crate | null,
  director: Director,
  dt: number,
) => CarInput = (brain, car, arena, time, views, crate, director, dt) => {
  if (car.mode !== "drive") {
    brain.reactT = -1;
    brain.recoverT = 0.4;

    return { boost: false, mx: 0, mz: 0, punch: false };
  }

  const shrink = shrinkAt(time * 1000);
  const see: Sight = { arena, crate, director, late: shrink.late || shrink.warn, time, views };
  tick(brain, car, dt);

  if (brain.thinkT <= 0) {
    brain.thinkT = THINK;
    think(brain, car, see);
  }

  const here = edgeDistance(arena, car.x, car.z, see.late);
  const margin = brain.carelessT > 0 ? 0.2 : 1.3;
  const path = route(brain, car, see, here, margin);
  const target = views.find((view) => view.key === brain.target);
  const armed = car.cooldown <= 0 && car.phase === "idle" && brain.recoverT <= 0;
  const lined = target && armed ? swing(brain, car, target, see, dt) : null;
  const closing = lined !== null && !path.blocked;
  const heading = closing ? lined.aim : path.heading;
  const calm = (here < 2.6 && brain.carelessT <= 0 ? 0.7 : 1) * (closing ? 0.55 : 1);

  return {
    boost: brain.boost && !path.blocked && here > 4 && brain.recoverT <= 0,
    mx: Math.cos(heading) * calm,
    mz: Math.sin(heading) * calm,
    punch: lined?.fire === true,
  };
};
