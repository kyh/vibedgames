import { edgeDistance, inward } from "./arena";
import type { Arena } from "./arena";
import { BOOST_SPEED } from "../shared/constants";
import { launchOf, steerTo, wrapAngle } from "./car";
import type { Car, CarInput } from "./car";
import type { Cube } from "./cubes";
import { hazardEscape, hazardThreat, shrinkAt } from "./hazards";
import { DASH_REACH, KINDS, PUCK_SPEED, SLAM_RADIUS, SPIN_RADIUS, attackRange } from "./kinds";
import { MAGNET_RADIUS, SHOCK_RADIUS, ZAP_RADIUS } from "./specials";
import type { SpecialKind } from "./specials";

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
  damage: number;
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
  /** Radians its aim is off by for the next punch, and who that punch is for. */
  aimOff: number;
  mark: string;
  /** Seconds of driving back to the middle after a hit, and of not minding the edge. */
  recoverT: number;
  carelessT: number;
  boost: boolean;
  /** Which way it last went round something: 1 or -1. It tries that way first. */
  side: number;
  /** Seconds it has carried its special, and whether it has decided to let it go. */
  heldT: number;
  use: boolean;
}

/** What the host shares between its bots so they do not all pile on one car. */
export interface Director {
  /** Target key → the bots on it. */
  chasing: Map<string, Set<string>>;
  /** Human key → the round time a bot last swung at them. */
  swungAt: Map<string, number>;
}

export const makeDirector: () => Director = () => ({ chasing: new Map(), swungAt: new Map() });

export const makeBrain: (slot: number, salt: number) => BotBrain = (slot, salt) => ({
  aimOff: 0,
  boost: false,
  carelessT: 0,
  gx: 0,
  gz: 0,
  heldT: 0,
  holdT: 0,
  mark: "",
  reactT: -1,
  recoverT: 0,
  seed: ((slot + salt * 7) * 0.618034 + 0.137) % 1,
  side: slot % 2 === 0 ? 1 : -1,
  target: "",
  thinkT: slot * 0.03,
  use: false,
});

const HUMAN_SWING_GAP = 1.5;
const OPENING = 6;
const BOOST_SIGHT = 0.6;
const SHOT_STAND = 9;
const FLIP_WAYS = 16;
const FLIP_STAND = 3.3;

const SHOT_CROWDED = 6;
const THINK = 1 / 6;
const FEELERS = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2.2, -2.2] as const;

const roll = (brain: BotBrain) => {
  brain.seed = (brain.seed * 9301 + 0.2113) % 1;

  return brain.seed;
};

/** A bot that is off the board or gone stops counting towards anyone's crowd. */
export const releaseBot = (director: Director, bot: string) => {
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
      const score = gap + edge * 1.6 + crowd * 6 + roll(brain) * 5 - view.damage * 0.05;

      if (score < bestScore) {
        bestScore = score;
        best = view.key;
      }
    }
  }

  releaseBot(director, car.key);

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
  cubes: readonly Cube[];
  director: Director;
}

const clear = (arena: Arena, late: boolean, time: number, x: number, z: number, margin: number) =>
  edgeDistance(arena, x, z, late) > margin && hazardThreat(arena, time, x, z, late) < 0.6;

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

const wantsCube = (car: Car, see: Sight) => {
  let best: Cube | null = null;
  let bestGap = 22;

  for (const cube of car.special === "" ? see.cubes : []) {
    const gap = Math.hypot(cube.x - car.x, cube.z - car.z);
    const there = edgeDistance(see.arena, cube.x, cube.z, see.late) > 0;

    if (gap < bestGap && there && see.time >= cube.landAt - 1) {
      bestGap = gap;
      best = cube;
    }
  }

  return best;
};

const near = (car: Car, see: Sight, reach: number) => {
  let count = 0;

  for (const view of see.views) {
    const gap = Math.hypot(view.x - car.x, view.z - car.z);

    if (view.key !== car.key && view.alive && !view.safe && gap < reach) {
      count += 1;
    }
  }

  return count;
};

const behind = (car: Car, see: Sight, reach: number) =>
  see.views.some((view) => {
    const dx = view.x - car.x;
    const dz = view.z - car.z;
    const gap = Math.hypot(dx, dz) || 1;
    const ahead = (dx * Math.cos(car.a) + dz * Math.sin(car.a)) / gap;

    return view.key !== car.key && view.alive && gap < reach && ahead < -0.3;
  });

interface Chance {
  car: Car;
  see: Sight;
  held: number;
  gap: number;
  off: number;
}

const USES: Record<SpecialKind, (c: Chance) => boolean> = {
  giant: (c) => near(c.car, c.see, 9) > 0,
  magnet: (c) => c.gap > 5 && c.gap < MAGNET_RADIUS - 1 && c.off < 0.6 && c.car.cooldown <= 0.2,
  mine: (c) => behind(c.car, c.see, 8) || c.held > 6,
  oil: (c) => behind(c.car, c.see, 8) || c.held > 6,
  rocket: (c) => c.gap < 34 && c.off < 0.09,
  seeker: (c) => c.gap < 30 && c.off < 1.2 && c.held > 0.6,
  shield: (c) => near(c.car, c.see, 6) > 0 && (c.car.damage > 40 || c.held > 4),
  shock: (c) => near(c.car, c.see, SHOCK_RADIUS * 0.75) > 0,
  spring: (c) => near(c.car, c.see, 3.6) > 0 || c.held > 6,
  turbo: (c) =>
    (c.gap > 10 || c.held > 3) && edgeDistance(c.see.arena, c.car.x, c.car.z, c.see.late) > 6,
  wrench: (c) => c.car.damage > 45 || (c.held > 8 && c.car.damage > 15),
  zap: (c) => near(c.car, c.see, ZAP_RADIUS * 0.8) > (c.held > 5 ? 0 : 1),
};

const wantsSpecial = (brain: BotBrain, car: Car, see: Sight, target: BotView | undefined) => {
  const tx = (target?.x ?? car.x) - car.x;
  const tz = (target?.z ?? car.z) - car.z;
  const gap = target ? Math.hypot(tx, tz) : 99;
  const off = target ? Math.abs(wrapAngle(Math.atan2(tz, tx) - car.a)) : 9;

  return car.special !== "" && USES[car.special]({ car, gap, held: brain.heldT, off, see });
};

const standOff = (car: Car, see: Sight, target: BotView, lined: number, gap: number) => {
  const { attack } = KINDS[car.kind];

  if (attack !== "punch" && attack !== "dash") {
    return 0;
  }

  return lined > 0.3 || gap < 4 ? 0 : 3.6;
};

const flipStand = (car: Car, see: Sight, target: BotView) => {
  const def = KINDS[car.kind];
  const reach = launchOf(def.throw * def.power, target.damage, 1) * 0.9;
  let best = { x: target.x, z: target.z };
  let bestGap = Number.POSITIVE_INFINITY;

  for (let i = 0; i < FLIP_WAYS; i += 1) {
    const a = (i / FLIP_WAYS) * Math.PI * 2;
    const x = target.x + Math.cos(a) * FLIP_STAND;
    const z = target.z + Math.sin(a) * FLIP_STAND;
    const tx = target.x + Math.cos(a) * reach;
    const tz = target.z + Math.sin(a) * reach;
    const lands = edgeDistance(see.arena, tx, tz, see.late);
    const gap = Math.hypot(x - car.x, z - car.z);

    if (lands < 0 && gap < bestGap && clear(see.arena, see.late, see.time, x, z, 1.3)) {
      bestGap = gap;
      best = { x, z };
    }
  }

  return best;
};

const shotStand = (car: Car, see: Sight, target: BotView, gap: number) => {
  const x = target.x + ((car.x - target.x) / gap) * SHOT_STAND;
  const z = target.z + ((car.z - target.z) / gap) * SHOT_STAND;

  return edgeDistance(see.arena, x, z, see.late) > 2 ? { x, z } : { x: target.x, z: target.z };
};

const think = (brain: BotBrain, car: Car, see: Sight) => {
  let target = see.views.find((view) => view.key === brain.target);

  if (!target || !target.alive || target.safe || brain.holdT <= 0) {
    pickTarget(brain, car, see.arena, see.late, see.views, see.director);
    target = see.views.find((view) => view.key === brain.target);
  }

  const cube = wantsCube(car, see);
  brain.use = car.special !== "" && wantsSpecial(brain, car, see, target) && roll(brain) < 0.6;

  if (cube) {
    brain.gx = cube.x;
    brain.gz = cube.z;
  } else if (target) {
    const out = inward(see.arena, target.x, target.z, see.late);
    const tx = target.x - car.x;
    const tz = target.z - car.z;
    const gap = Math.hypot(tx, tz) || 1;
    const lined = -(tx * out.x + tz * out.z) / gap;
    const stand = standOff(car, see, target, lined, gap);
    const { attack } = KINDS[car.kind];
    const back = attack === "shot" ? shotStand(car, see, target, gap) : null;
    const spot = attack === "scoop" ? flipStand(car, see, target) : back;
    brain.gx = spot?.x ?? target.x + out.x * stand;
    brain.gz = spot?.z ?? target.z + out.z * stand;
    brain.boost = gap > 9 && roll(brain) < 0.5;
  } else {
    brain.gx = 0;
    brain.gz = 3;
    brain.boost = false;
  }
};

const lookAhead = (car: Car) => 2.2 + Math.hypot(car.vx, car.vz) * 0.28;

const nearestSpawn = (car: Car, arena: Arena) => {
  let best = { x: 0, z: 0 };
  let bestGap = Number.POSITIVE_INFINITY;

  for (const spawn of arena.def.spawns) {
    const gap = Math.hypot(spawn.x - car.x, spawn.z - car.z);

    if (gap < bestGap) {
      bestGap = gap;
      best = spawn;
    }
  }

  return best;
};

const feel = (
  brain: BotBrain,
  car: Car,
  see: Sight,
  late: boolean,
  want: number,
  margin: number,
) => {
  const look = lookAhead(car);

  for (const base of FEELERS) {
    const offset = base * brain.side;

    if (pathClear(car, see.arena, late, see.time, want + offset, look, margin)) {
      brain.side = offset < 0 ? -brain.side : brain.side;

      return want + offset;
    }
  }

  return null;
};

const onBoardWay = (car: Car, see: Sight, want: number, margin: number) => {
  const look = lookAhead(car);

  for (const offset of FEELERS) {
    const a = want + offset;
    const x = car.x + Math.cos(a) * look;
    const z = car.z + Math.sin(a) * look;

    if (edgeDistance(see.arena, x, z, see.late) > margin) {
      return a;
    }
  }

  return null;
};

const flee = (brain: BotBrain, car: Car, see: Sight) => {
  const spawn = nearestSpawn(car, see.arena);
  const want = Math.atan2(spawn.z - car.z, spawn.x - car.x);

  return { blocked: true, heading: feel(brain, car, see, false, want, 0.8) ?? want, rush: true };
};

const route = (brain: BotBrain, car: Car, see: Sight, here: number, margin: number) => {
  const { arena, late, time } = see;

  if (here <= 0) {
    return flee(brain, car, see);
  }

  const safe = inward(arena, car.x, car.z, late);
  const home = brain.recoverT > 0 || here < margin;
  const want = home ? Math.atan2(safe.z, safe.x) : Math.atan2(brain.gz - car.z, brain.gx - car.x);
  const escape = brain.carelessT > 0 ? null : hazardEscape(arena, time, car.x, car.z, late);

  if (escape && here > margin) {
    const away = Math.atan2(escape.z, escape.x);

    return { blocked: true, heading: onBoardWay(car, see, away, margin) ?? away, rush: false };
  }

  const open = escape ? null : feel(brain, car, see, late, want, margin);

  return open === null
    ? { blocked: true, heading: Math.atan2(safe.z, safe.x), rush: false }
    : { blocked: false, heading: open, rush: false };
};

const lineUp = (car: Car, see: Sight, gap: number, off: number, soon: number) => {
  const { attack } = KINDS[car.kind];
  const reach = attackRange(car.kind);

  if (attack === "slam" || attack === "spin") {
    return soon < (attack === "slam" ? SLAM_RADIUS - 1 : SPIN_RADIUS - 0.4);
  }

  if (attack === "shot") {
    return gap < reach && off < 0.1;
  }

  if (attack === "dash") {
    const far = DASH_REACH + 1.6;

    const lane = [0.4, 0.7, 1].every((part) =>
      clear(
        see.arena,
        see.late,
        see.time,
        car.x + Math.cos(car.a) * far * part,
        car.z + Math.sin(car.a) * far * part,
        0.8,
      ),
    );

    return gap < reach && gap > 2.4 && off < 0.24 && lane;
  }

  return gap < reach && Math.sin(Math.min(off, 1.5)) * gap < (attack === "scoop" ? 1.9 : 1.6);
};

const sightOf = (brain: BotBrain, car: Car, view: BotView) => {
  const { attack, windup } = KINDS[car.kind];
  const shot = attack === "shot";
  const lead = shot ? 0.1 : 0.42;
  const tx = view.x - car.x + (view.vx - (shot ? 0 : car.vx)) * lead;
  const tz = view.z - car.z + (view.vz - (shot ? 0 : car.vz)) * lead;
  const gap = Math.hypot(tx, tz);
  const flight = shot ? gap / PUCK_SPEED : 0;
  const aim = Math.atan2(tz + view.vz * flight, tx + view.vx * flight) + brain.aimOff;

  return {
    aim,
    gap,
    off: Math.abs(wrapAngle(aim - car.a)),
    soon: Math.hypot(tx + (view.vx - car.vx) * windup, tz + (view.vz - car.vz) * windup),
  };
};

const opens = (brain: BotBrain, car: Car, see: Sight, view: BotView) => {
  const at = sightOf(brain, car, view);
  const last = see.director.swungAt.get(view.key) ?? -10;
  const fair = !view.human || (see.time > OPENING && see.time - last > HUMAN_SWING_GAP);

  return fair && view.alive && !view.safe && lineUp(car, see, at.gap, at.off, at.soon);
};

const markOf = (brain: BotBrain, car: Car, see: Sight, target: BotView) => {
  if (opens(brain, car, see, target)) {
    return target.key;
  }

  const { attack } = KINDS[car.kind];
  const close = attack !== "shot" && attack !== "dash";

  const other = close
    ? see.views.find((view) => view.key !== car.key && opens(brain, car, see, view))
    : undefined;

  return other?.key ?? "";
};

const letFly = (brain: BotBrain, car: Car, see: Sight) => {
  const { attack } = KINDS[car.kind];
  const view = see.views.find((each) => each.key === brain.mark);
  const at = view ? sightOf(brain, car, view) : null;
  const round = attack === "slam" || attack === "spin";
  const fire = at !== null && at.gap < attackRange(car.kind) * 1.25 && (at.off < 0.7 || round);

  if (fire && view?.human === true) {
    see.director.swungAt.set(view.key, see.time);
  }

  brain.reactT = -1;
  brain.mark = "";

  return fire;
};

const swing = (brain: BotBrain, car: Car, target: BotView, see: Sight, dt: number) => {
  const { attack } = KINDS[car.kind];
  const at = sightOf(brain, car, target);
  const reach = attackRange(car.kind);
  let fire = false;

  if (brain.reactT < 0) {
    brain.mark = markOf(brain, car, see, target);

    if (brain.mark !== "") {
      brain.reactT = (attack === "shot" ? 0.08 : 0.18) + roll(brain) * 0.17;
      brain.aimOff =
        (roll(brain) - 0.5) * 2 * (0.1 + roll(brain) * 0.14) * (attack === "shot" ? 0.4 : 1);
    }
  } else {
    brain.reactT -= dt;
    fire = brain.reactT <= 0 && letFly(brain, car, see);
  }

  const aims = attack !== "slam" && attack !== "spin";
  const crowded = attack === "shot" && at.gap < SHOT_CROWDED;

  return at.gap < reach * 1.7 && aims
    ? { aim: at.aim, crowded, fire, slow: at.gap < reach * 0.8 }
    : { aim: null, crowded: false, fire, slow: false };
};

const tick = (brain: BotBrain, car: Car, dt: number) => {
  brain.holdT -= dt;
  brain.thinkT -= dt;
  brain.carelessT = Math.max(0, brain.carelessT - dt);
  brain.heldT = car.special === "" ? 0 : brain.heldT + dt;

  if (car.stagger > 0) {
    brain.recoverT = 0.4;
    brain.reactT = -1;
  } else {
    brain.recoverT = Math.max(0, brain.recoverT - dt);
  }
};

const BLOCKED_TURN = 1.7;

const calmOf = (brain: BotBrain, here: number, rush: boolean, slow: boolean) => {
  const wary = here < 2.6 && brain.carelessT <= 0 && !rush;

  return (wary ? 0.7 : 1) * (slow ? 0.6 : 1);
};

const sightClear = (car: Car, see: Sight, margin: number) =>
  pathClear(car, see.arena, see.late, see.time, car.a, BOOST_SPEED * BOOST_SIGHT, margin);

const wantsBoost = (brain: BotBrain, here: number) =>
  brain.boost && here > 4 && brain.recoverT <= 0;

const lineOf = (
  brain: BotBrain,
  car: Car,
  see: Sight,
  dt: number,
  open: boolean,
  margin: number,
) => {
  const target = see.views.find((view) => view.key === brain.target);
  const armed = car.cooldown <= 0 && car.phase === "idle" && brain.recoverT <= 0;
  const lined = target && armed ? swing(brain, car, target, see, dt) : null;
  const aim = lined?.aim ?? null;
  const reach = lookAhead(car);

  const closing =
    aim !== null && open && pathClear(car, see.arena, see.late, see.time, aim, reach, margin);

  return {
    aim: closing ? aim : null,
    crowded: closing && lined?.crowded === true,
    fire: lined?.fire === true,
    slow: closing && lined?.slow === true,
  };
};

const drive: (brain: BotBrain, car: Car, see: Sight, dt: number) => CarInput = (
  brain,
  car,
  see,
  dt,
) => {
  const here = edgeDistance(see.arena, car.x, car.z, see.late);
  const margin = brain.carelessT > 0 ? 0.2 : 1.3;
  const path = route(brain, car, see, here, margin);
  const open = !path.blocked && here > margin;
  const line = lineOf(brain, car, see, dt, open, margin);
  const calm = calmOf(brain, here, path.rush, line.slow);
  const special = brain.use;
  brain.use = false;
  const heading = line.aim ?? path.heading;
  const wheel = steerTo(car, heading, calm);
  const off = Math.abs(wrapAngle(heading - car.a));
  const far = open && sightClear(car, see, margin);
  const backing = (path.blocked && off > BLOCKED_TURN) || line.crowded;

  return {
    attack: line.fire,
    boost: (path.rush && off < 1) || (wantsBoost(brain, here) && far && off < 0.5),
    gas: backing ? -0.8 : wheel.gas,
    special,
    steer: wheel.steer,
  };
};

/** A bot's wheel, pedal and buttons for this step. `time` is seconds into the round. */
export const botInput: (
  brain: BotBrain,
  car: Car,
  arena: Arena,
  time: number,
  views: readonly BotView[],
  cubes: readonly Cube[],
  director: Director,
  dt: number,
) => CarInput = (brain, car, arena, time, views, cubes, director, dt) => {
  if (car.mode !== "drive") {
    brain.reactT = -1;
    brain.recoverT = 0.4;
    brain.use = false;
    releaseBot(director, car.key);

    return { attack: false, boost: false, gas: 0, special: false, steer: 0 };
  }

  const shrink = shrinkAt(time * 1000);
  const see: Sight = { arena, cubes, director, late: shrink.late || shrink.warn, time, views };
  tick(brain, car, dt);

  if (brain.thinkT <= 0) {
    brain.thinkT = THINK;
    think(brain, car, see);
  }

  return drive(brain, car, see, dt);
};
