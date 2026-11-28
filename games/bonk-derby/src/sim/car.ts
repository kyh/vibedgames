import {
  ACCEL,
  ATTACK_BUFFER,
  BOOST_ACCEL,
  BOOST_MIN,
  BOOST_REFILL,
  BOOST_REST,
  BOOST_SECONDS,
  BOOST_SPEED,
  CAR_NOSE,
  CAR_RADIUS,
  CLASH_THROW,
  COAST_DRAG,
  CREDIT_SECONDS,
  DAMAGE_GAIN,
  DAMAGE_MAX,
  DROP_HEIGHT,
  FALL_SECONDS,
  GRAVITY,
  GRIP,
  HIT_LOCK_ANY,
  HIT_LOCK_SAME,
  KNOCK_HOP,
  KNOCK_TAU,
  MAX_SPEED,
  PUNCH_LUNGE,
  REVERSE,
  SAFE_SECONDS,
  SPECIAL_BUFFER,
  SPEED_THROW,
  STAGGER,
  STAGGER_EASE,
  TURN_RATE,
} from "../shared/constants";
import { edgeDistance } from "./arena";
import type { Arena, Spawn } from "./arena";
import {
  DASH_REACH,
  KINDS,
  PUNCH_HALF_WIDTH,
  PUNCH_REACH,
  SCOOP_HALF_WIDTH,
  SCOOP_LIFT,
  SCOOP_REACH,
  SLAM_RADIUS,
} from "./kinds";
import type { AttackKind, CarKind, KindDef } from "./kinds";
import {
  GIANT_POWER,
  GIANT_RADIUS,
  GIANT_SCALE,
  GIANT_SLOW,
  GIANT_WEIGHT,
  MAGNET_LOCK,
  MAGNET_STAGGER,
  MOD_SECONDS,
  SPRING_HEIGHT,
  TURBO_SPEED,
} from "./specials";
import type { ModKind, SpecialKind } from "./specials";

export interface CarInput {
  /** The wheel: -1 full left … 1 full right. */
  steer: number;
  /** The pedal: -1 full reverse … 1 full ahead. */
  gas: number;
  /** The attack button went down this step. */
  attack: boolean;
  /** The special button went down this step. */
  special: boolean;
  boost: boolean;
}

export const NO_INPUT: CarInput = {
  attack: false,
  boost: false,
  gas: 0,
  special: false,
  steer: 0,
};

export type AttackPhase = "idle" | "windup" | "strike" | "hold" | "retract";

/** drive: on the board. fall: over the edge. out: gone, waiting. drop: coming back down. */
export type CarMode = "drive" | "fall" | "out" | "drop";

/** What threw a car: a car's own attack, a special, the board, or another car landing. */
export type HitHow =
  | AttackKind
  | "ram"
  | "bumper"
  | "sweeper"
  | "piston"
  | "land"
  | "rocket"
  | "seeker"
  | "mine"
  | "shock"
  | "magnet"
  | "zap"
  | "stomp"
  | "oil";

export interface Hit {
  /** Unique per blow, so one sent twice lands once. */
  id: string;
  /** The car that dealt it, or "" for the board's own toys. */
  by: string;
  how: HitHow;
  /** Unit direction of the throw. */
  dx: number;
  dz: number;
  /** How far it throws a fresh car of even weight. */
  reach: number;
  /** Points of damage it adds. */
  damage: number;
  /** Seconds the car is left with no wheel, if longer than the throw itself. */
  stun: number;
  /** How high it tosses the car, against an ordinary blow. */
  lift: number;
}

export interface Car {
  key: string;
  bot: boolean;
  kind: CarKind;
  x: number;
  y: number;
  z: number;
  /** Heading, radians: 0 is +x, a quarter turn is +z. */
  a: number;
  vx: number;
  vy: number;
  vz: number;
  /** Knock velocity: laid over the drive velocity, gone in a few tenths. */
  kx: number;
  kz: number;
  /** The time constant the knock now running fades on. */
  ktau: number;
  /** Seconds left without the wheel after a hit. */
  stagger: number;
  /** Seconds left sliding on oil. */
  slip: number;
  /** -1 … 1, how hard the nose is swinging: the body leans on it. */
  steer: number;
  meter: number;
  boosting: boolean;
  rest: number;
  phase: AttackPhase;
  phaseT: number;
  buffer: number;
  /** Seconds the special's button is still remembered. */
  wish: number;
  cooldown: number;
  /** The length of the cooldown now running, for the ring. */
  cooldownOf: number;
  landed: boolean;
  struck: Set<string>;
  /** Attacks thrown this round. */
  attacks: number;
  /** Damage taken since it last dropped in: the more, the further it flies. */
  damage: number;
  mode: CarMode;
  modeT: number;
  safe: number;
  /** Times this car has gone over the edge this round. */
  falls: number;
  /** Who gets the next fall, and seconds since they earned it. */
  lastBy: string;
  lastByT: number;
  /** Who got the last fall: "" if it fell on its own. Kept until the next one. */
  outBy: string;
  /** Times this car has been thrown this round, and the last blow it took. */
  launches: number;
  hitId: string;
  hitHow: HitHow;
  lockAny: number;
  locks: Map<string, number>;
  /** The special it carries, the number it has used this round and the last of them. */
  special: SpecialKind | "";
  uses: number;
  usedKind: SpecialKind | "";
  mod: ModKind;
  modT: number;
  /** In the air off a spring: it stomps where it lands. */
  hop: boolean;
  /** Radians of roll since it left the floor, and which way it rolls. */
  tumble: number;
  spin: number;
}

/** What one step of one car did, for whoever draws and scores it. */
export interface CarEvents {
  /** The attack went off. */
  struck: boolean;
  /** The attack ended without touching anyone. */
  whiffed: boolean;
  /** Wheels back on the floor after a throw or a drop. */
  landed: boolean;
  /** Came down off a spring. */
  stomped: boolean;
  /** Went over the edge this step. */
  fell: boolean;
  /** Finished falling: one fall on the counter. */
  out: boolean;
  /** The special let go this step. */
  used: SpecialKind | "";
}

export const makeCar: (key: string, bot: boolean, kind?: CarKind) => Car = (
  key,
  bot,
  kind = "bumper",
) => ({
  a: 0,
  attacks: 0,
  boosting: false,
  bot,
  buffer: 0,
  cooldown: 0,
  cooldownOf: KINDS[kind].cooldown,
  damage: 0,
  falls: 0,
  hitHow: "punch",
  hitId: "",
  hop: false,
  key,
  kind,
  ktau: KNOCK_TAU,
  kx: 0,
  kz: 0,
  landed: false,
  lastBy: "",
  lastByT: CREDIT_SECONDS,
  launches: 0,
  lockAny: 0,
  locks: new Map<string, number>(),
  meter: 1,
  mod: "",
  modT: 0,
  mode: "out",
  modeT: 0,
  outBy: "",
  phase: "idle",
  phaseT: 0,
  rest: 0,
  safe: 0,
  slip: 0,
  special: "",
  spin: 1,
  stagger: 0,
  steer: 0,
  struck: new Set<string>(),
  tumble: 0,
  usedKind: "",
  uses: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  wish: 0,
  x: 0,
  y: 0,
  z: 0,
});

const clearMotion = (car: Car, spawn: Spawn) => {
  Object.assign(car, {
    a: spawn.a,
    boosting: false,
    buffer: 0,
    damage: 0,
    hop: false,
    ktau: KNOCK_TAU,
    kx: 0,
    kz: 0,
    lastBy: "",
    lastByT: CREDIT_SECONDS,
    lockAny: 0,
    mod: "",
    modT: 0,
    modeT: 0,
    phase: "idle",
    phaseT: 0,
    slip: 0,
    stagger: 0,
    steer: 0,
    tumble: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    wish: 0,
    x: spawn.x,
    z: spawn.z,
  } satisfies Partial<Car>);
  car.locks.clear();
  car.struck.clear();
};

/** A new round: on the grid, wheels down, everything this round counts back at zero. */
export const gridCar = (car: Car, spawn: Spawn) => {
  clearMotion(car, spawn);
  Object.assign(car, {
    attacks: 0,
    cooldown: 0,
    falls: 0,
    hitId: "",
    launches: 0,
    meter: 1,
    mode: "drive",
    outBy: "",
    safe: 0,
    special: "",
    usedKind: "",
    uses: 0,
    y: 0,
  } satisfies Partial<Car>);
};

/** Back from a fall: dropped in over `spawn`, untouchable until a moment after it lands. */
export const dropCar = (car: Car, spawn: Spawn) => {
  clearMotion(car, spawn);
  Object.assign(car, {
    cooldown: 0,
    meter: Math.max(car.meter, 0.5),
    mode: "drop",
    safe: SAFE_SECONDS,
    y: DROP_HEIGHT,
  } satisfies Partial<Car>);
};

export const carScale = (car: Car) => (car.mod === "giant" ? GIANT_SCALE : 1);
export const carRadius = (car: Car) => CAR_RADIUS * (car.mod === "giant" ? GIANT_RADIUS : 1);

/** A blow throws this car 1/weight as far. */
export const carWeight = (car: Car) =>
  KINDS[car.kind].weight * (car.mod === "giant" ? GIANT_WEIGHT : 1);

const carPower = (car: Car) => KINDS[car.kind].power * (car.mod === "giant" ? GIANT_POWER : 1);

/** How far a blow of `reach` throws a car carrying `damage` and weighing `weight`. */
export const launchOf = (reach: number, damage: number, weight: number) =>
  (reach * (1 + damage * DAMAGE_GAIN)) / weight;

/** The time constant and the seconds without a wheel that go with a throw of `reach`. */
export const flightOf = (reach: number) => {
  const long = Math.min(1, Math.max(0, (reach - 6) / 12));

  return { stagger: STAGGER * (1 + long * 0.8), tau: KNOCK_TAU * (1 + long * 0.9) };
};

const windupOf = (car: Car) => KINDS[car.kind].windup;

/** Seconds since this car's attack went off: negative while it winds up, large when idle. */
export const attackClock = (car: Car) => {
  const def = KINDS[car.kind];

  if (car.phase === "windup") {
    return car.phaseT - windupOf(car);
  }

  if (car.phase === "strike") {
    return car.phaseT;
  }

  if (car.phase === "hold") {
    return def.strike + car.phaseT;
  }

  return car.phase === "retract" ? def.strike + def.hold + car.phaseT : 99;
};

/**
 * How an attack looks `t` seconds after it went off (negative: winding up).
 * A punch or a scoop is how far the plate is out, in world units; the rest run
 * 0–1 (a whirl is how far round it has come).
 */
export const swingAt = (kind: CarKind, t: number) => {
  const def = KINDS[kind];
  const out = def.strike + def.hold;

  if (def.attack === "punch" || def.attack === "scoop") {
    const reach = def.attack === "punch" ? PUNCH_REACH : SCOOP_REACH;

    if (t < 0) {
      return -0.3;
    }

    return t < out
      ? reach * Math.min(1, t / (def.strike * 0.5))
      : reach * Math.max(0, 1 - (t - out) / def.retract);
  }

  if (t < 0) {
    return 0;
  }

  if (def.attack === "spin") {
    return t < def.strike ? t / def.strike : 0;
  }

  if (def.attack === "shot") {
    return Math.max(0, 1 - t / 0.2);
  }

  return t < out ? 1 : Math.max(0, 1 - (t - out) / def.retract);
};

/** 0 just fired … 1 ready again. */
export const attackReady = (car: Car) =>
  car.cooldown <= 0 ? 1 : 1 - Math.min(1, car.cooldown / car.cooldownOf);

export const wrapAngle = (a: number) => {
  const turn = Math.PI * 2;
  const r = ((a % turn) + turn) % turn;

  return r > Math.PI ? r - turn : r;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const STICK_BACK = 1.92;
const STICK_BLEND = 0.52;

/**
 * A stick as the driver sees it, the car's nose up the screen: `sx` right,
 * `sy` ahead. Ahead is the pedal, across is the wheel, and pulling back past
 * the side backs the car up with the wheel turned over.
 */
export const stickInput = (sx: number, sy: number) => {
  // WARNING: forward and reverse blend across STICK_BLEND; a hard switch makes a thumb held back-and-sideways flip the car between them.
  const size = Math.min(1, Math.hypot(sx, sy));

  if (size < 0.15) {
    return { gas: 0, steer: 0 };
  }

  const off = Math.atan2(sx, sy);
  const back = clamp((Math.abs(off) - STICK_BACK) / STICK_BLEND, 0, 1);
  const ahead = size * Math.min(1, 0.3 + Math.max(0, Math.cos(off)));
  const wheel = clamp(off / 0.7, -1, 1) * Math.min(1, size * 1.2);
  const reversed = -Math.sign(off) * clamp((Math.PI - Math.abs(off)) / 0.6, 0, 1);

  return {
    gas: ahead + (-size - ahead) * back,
    steer: wheel + (reversed - wheel) * back,
  };
};

/** The wheel and pedal that take `car` towards heading `want` at `size` 0–1 of full speed. */
export const steerTo = (car: Car, want: number, size: number) => {
  const off = wrapAngle(want - car.a);

  return {
    gas: size * (0.25 + 0.75 * Math.max(0, Math.cos(off))),
    steer: clamp(off / 0.22, -1, 1),
  };
};

/** Is (x, z) inside the box in front of this car that its punch or scoop sweeps? */
export const inFront = (car: Car, x: number, z: number, radius: number) => {
  const scoop = KINDS[car.kind].attack === "scoop";
  const cos = Math.cos(car.a);
  const sin = Math.sin(car.a);
  const along = (x - car.x) * cos + (z - car.z) * sin;
  const across = Math.abs(-(x - car.x) * sin + (z - car.z) * cos);
  const scale = carScale(car);

  return (
    along > 0.2 &&
    along < CAR_NOSE * scale + (scoop ? SCOOP_REACH : PUNCH_REACH) * scale + radius * 0.6 &&
    across < (scoop ? SCOOP_HALF_WIDTH : PUNCH_HALF_WIDTH) * scale + radius * 0.7
  );
};

/** The blow this car's attack deals to something at (x, z). */
export const attackHit = (car: Car, x: number, z: number, id: string) => {
  const def = KINDS[car.kind];
  const cos = Math.cos(car.a);
  const sin = Math.sin(car.a);
  const gap = Math.hypot(x - car.x, z - car.z) || 1;
  const ox = (x - car.x) / gap;
  const oz = (z - car.z) / gap;
  const speed = Math.max(0, car.vx * cos + car.vz * sin);
  let dx = cos * 0.7 + ox * 0.3;
  let dz = sin * 0.7 + oz * 0.3;
  let reach = def.throw + speed * SPEED_THROW;

  if (def.attack === "scoop") {
    dx = -cos;
    dz = -sin;
    reach = def.throw;
  } else if (def.attack === "slam") {
    dx = ox;
    dz = oz;
    reach = def.throw * (1 - 0.35 * Math.min(1, gap / SLAM_RADIUS));
  } else if (def.attack === "spin") {
    dx = ox * 0.75 - oz * 0.55;
    dz = oz * 0.75 + ox * 0.55;
    reach = def.throw;
  }

  const length = Math.hypot(dx, dz) || 1;

  return {
    by: car.key,
    damage: def.damage * (car.mod === "giant" ? 1.2 : 1),
    dx: dx / length,
    dz: dz / length,
    how: def.attack,
    id,
    lift: def.attack === "scoop" ? SCOOP_LIFT : 1,
    reach: reach * carPower(car),
    stun: 0,
  } satisfies Hit;
};

/** A shove with no stagger: recoil, a clash, a lunge, a dash. `reach` is how far it carries. */
export const nudge = (car: Car, dx: number, dz: number, reach: number) => {
  const keep = car.ktau / KNOCK_TAU;
  car.kx = car.kx * keep + (dx * reach) / KNOCK_TAU;
  car.kz = car.kz * keep + (dz * reach) / KNOCK_TAU;
  car.ktau = KNOCK_TAU;
};

/** Two bumpers met: this car bounces back off the other, nobody is thrown. */
export const clash = (car: Car, dx: number, dz: number) => {
  car.vx = 0;
  car.vz = 0;
  car.ktau = KNOCK_TAU;
  car.kx = (dx * CLASH_THROW) / KNOCK_TAU;
  car.kz = (dz * CLASH_THROW) / KNOCK_TAU;
  car.phase = "retract";
  car.phaseT = 0;
  car.landed = true;
};

/**
 * Would this car's bumper meet a punch coming along (dx, dz)? Only while its own
 * punch is out and pointed back at the blow.
 */
export const wouldClash = (car: Car, hit: Hit) =>
  hit.how === "punch" &&
  KINDS[car.kind].attack === "punch" &&
  (car.phase === "strike" || car.phase === "hold") &&
  Math.cos(car.a) * hit.dx + Math.sin(car.a) * hit.dz < -0.5;

const lockOf = (hit: Hit) => (hit.how === "ram" ? `ram:${hit.by}` : hit.by || hit.how);

/** Can this blow land at all: on the board, not just back, not just hit by the same car. */
export const canHit = (car: Car, hit: Hit) => {
  if (car.mode !== "drive" || car.safe > 0 || car.hitId === hit.id) {
    return false;
  }

  if (hit.how === "land") {
    return true;
  }

  const shoved = car.hitHow === "ram" || car.hitHow === "land";
  const open = car.lockAny <= 0 || (hit.how !== "ram" && shoved);

  return open && (car.locks.get(lockOf(hit)) ?? 0) <= 0;
};

/** What `takeHit` answers when a blow does not throw the car. */
export const MISSED = -1;
export const BLOCKED = -2;

/**
 * Throw the car. Returns how far it will travel, `MISSED` if the blow did not
 * land, or `BLOCKED` if a shield took it.
 */
export const takeHit = (car: Car, hit: Hit) => {
  if (!canHit(car, hit)) {
    return MISSED;
  }

  if (car.mod === "shield" && hit.how !== "land") {
    Object.assign(car, { hitId: hit.id, lockAny: HIT_LOCK_SAME, mod: "", modT: 0 });

    return BLOCKED;
  }

  const fixed = hit.how === "land" || hit.how === "magnet" || hit.how === "zap";
  const reach = fixed ? hit.reach : launchOf(hit.reach, car.damage, carWeight(car));
  const flying = car.stagger > STAGGER_EASE;
  const along = car.kx * hit.dx + car.kz * hit.dz;

  if (hit.by !== "" && hit.how !== "land" && (!flying || along <= 0 || car.lastBy === "")) {
    car.lastBy = hit.by;
    car.lastByT = 0;
  }

  const soft = hit.how === "ram" || hit.how === "land";
  const pulled = hit.how === "magnet";
  const flight = flightOf(reach);
  const thrown = (soft ? STAGGER * 0.5 : flight.stagger) + STAGGER_EASE;
  const hop = KNOCK_HOP * clamp(reach / 5, 0.3, 2.4) * hit.lift;
  Object.assign(car, {
    boosting: false,
    damage: Math.min(DAMAGE_MAX, car.damage + hit.damage),
    hitHow: hit.how,
    hitId: hit.id,
    hop: false,
    ktau: flight.tau,
    kx: (hit.dx * reach) / flight.tau,
    kz: (hit.dz * reach) / flight.tau,
    launches: car.launches + 1,
    lockAny: HIT_LOCK_ANY,
    phase: "idle",
    phaseT: 0,
    spin: Math.sin(car.a) * hit.dx - Math.cos(car.a) * hit.dz >= 0 ? 1 : -1,
    stagger: Math.max(hit.stun, pulled ? MAGNET_STAGGER : thrown),
    tumble: 0,
    vx: 0,
    vy: Math.sqrt(2 * GRAVITY * hop),
    vz: 0,
  } satisfies Partial<Car>);
  car.locks.set(lockOf(hit), pulled ? MAGNET_LOCK : HIT_LOCK_SAME);

  return reach;
};

const letGo = (car: Car) => {
  const kind = car.special;
  const grounded = car.y <= 0.01 && car.vy <= 0;

  if (kind === "" || car.stagger > STAGGER_EASE || (kind === "spring" && !grounded)) {
    return "";
  }

  Object.assign(car, { safe: 0, special: "", usedKind: kind, uses: car.uses + 1 });

  if (kind === "giant" || kind === "turbo" || kind === "shield") {
    car.mod = kind;
    car.modT = MOD_SECONDS[kind];
  } else if (kind === "wrench") {
    car.damage = 0;
  } else if (kind === "spring") {
    car.vy = Math.sqrt(2 * GRAVITY * SPRING_HEIGHT);
    car.hop = true;
  }

  return kind;
};

const stepTimers = (car: Car, dt: number) => {
  car.buffer = Math.max(0, car.buffer - dt);
  car.cooldown = Math.max(0, car.cooldown - dt);
  car.lockAny = Math.max(0, car.lockAny - dt);
  car.safe = Math.max(0, car.safe - dt);
  car.stagger = Math.max(0, car.stagger - dt);
  car.slip = Math.max(0, car.slip - dt);
  car.lastByT += dt;

  if (car.lastByT >= CREDIT_SECONDS) {
    car.lastBy = "";
  }

  for (const [key, left] of car.locks) {
    if (left <= dt) {
      car.locks.delete(key);
    } else {
      car.locks.set(key, left - dt);
    }
  }

  if (car.mod !== "") {
    car.modT -= dt;

    if (car.modT <= 0) {
      car.mod = "";
    }
  }
};

const strike = (car: Car, def: KindDef, events: CarEvents) => {
  Object.assign(car, {
    attacks: car.attacks + 1,
    cooldown: def.cooldown,
    cooldownOf: def.cooldown,
    phase: "strike",
    phaseT: 0,
  } satisfies Partial<Car>);
  events.struck = true;
  const cos = Math.cos(car.a);
  const sin = Math.sin(car.a);

  if (def.attack === "dash") {
    nudge(car, cos, sin, DASH_REACH);
  } else if (def.attack === "shot") {
    nudge(car, -cos, -sin, 0.5);
  } else if (def.attack === "punch" && car.boosting) {
    nudge(car, cos, sin, PUNCH_LUNGE);
  }
};

const stepAttack = (car: Car, input: CarInput, dt: number, events: CarEvents) => {
  const def = KINDS[car.kind];

  if (input.attack) {
    car.buffer = ATTACK_BUFFER;
  }

  if (car.phase === "idle") {
    const free = car.cooldown <= 0 && car.stagger <= STAGGER_EASE && car.slip <= 0;

    if (car.buffer > 0 && free && car.y <= 0.01) {
      Object.assign(car, { buffer: 0, landed: false, phase: "windup", phaseT: 0, safe: 0 });
      car.struck.clear();

      if (def.attack === "slam") {
        car.vy = (GRAVITY * windupOf(car)) / 2;
      }
    }

    return;
  }

  car.phaseT += dt;

  if (car.phase === "windup" && car.phaseT >= windupOf(car)) {
    strike(car, def, events);
  } else if (car.phase === "strike" && car.phaseT >= def.strike) {
    car.phase = "hold";
    car.phaseT = 0;

    if (!car.landed && def.whiff > def.cooldown) {
      car.cooldown += def.whiff - def.cooldown;
      car.cooldownOf = def.whiff;
      events.whiffed = true;
    }
  } else if (car.phase === "hold" && car.phaseT >= def.hold) {
    car.phase = "retract";
    car.phaseT = 0;
  } else if (car.phase === "retract" && car.phaseT >= def.retract) {
    car.phase = "idle";
    car.phaseT = 0;
  }
};

const stepBoost = (car: Car, want: boolean, dt: number) => {
  if (car.mod === "turbo") {
    car.boosting = want;
    car.meter = 1;

    return;
  }

  car.boosting = want && (car.boosting ? car.meter > 0 : car.meter >= BOOST_MIN);

  if (car.boosting) {
    car.meter = Math.max(0, car.meter - dt / BOOST_SECONDS);
    car.rest = BOOST_REST;
  } else {
    car.rest = Math.max(0, car.rest - dt);

    if (car.rest <= 0) {
      car.meter = Math.min(1, car.meter + dt / BOOST_REFILL);
    }
  }
};

const controlOf = (car: Car) => {
  if (car.stagger > STAGGER_EASE || car.slip > 0) {
    return 0;
  }

  return car.stagger > 0 ? 0.4 + 0.6 * (1 - car.stagger / STAGGER_EASE) : 1;
};

const commitOf = (car: Car, attack: AttackKind) => {
  const out = car.phase === "windup" || car.phase === "strike" || car.phase === "hold";

  if (!out || attack === "spin" || attack === "shot") {
    return 1;
  }

  return attack === "dash" && car.phase === "strike" ? 0.1 : 0.3;
};

const topSpeed = (car: Car, def: KindDef) => {
  const turbo = car.mod === "turbo" ? TURBO_SPEED : 1;
  const giant = car.mod === "giant" ? GIANT_SLOW : 1;

  return (car.boosting ? BOOST_SPEED : MAX_SPEED) * def.speed * turbo * giant;
};

const stepDrive = (car: Car, input: CarInput, dt: number) => {
  const def = KINDS[car.kind];
  const control = controlOf(car);
  const gas = clamp(input.gas, -1, 1);
  const wheel = clamp(input.steer, -1, 1) * control;
  const turbo = car.mod === "turbo" && gas > 0.15;
  stepBoost(car, (input.boost || turbo) && gas > 0.15 && car.stagger <= 0 && car.slip <= 0, dt);
  car.a = wrapAngle(car.a + wheel * TURN_RATE * def.turn * commitOf(car, def.attack) * dt);
  car.steer += (wheel - car.steer) * Math.min(1, dt * 12);
  const cos = Math.cos(car.a);
  const sin = Math.sin(car.a);
  let forward = car.vx * cos + car.vz * sin;
  let side = -car.vx * sin + car.vz * cos;
  side *= Math.exp(-(car.slip > 0 ? 0.6 : GRIP) * dt);

  if (control > 0 && Math.abs(gas) > 0.05) {
    const top = topSpeed(car, def);
    const target = gas > 0 ? top * gas : top * REVERSE * gas;
    const rate = (car.boosting ? BOOST_ACCEL : ACCEL) * def.accel * control * dt;
    forward += Math.min(rate, Math.max(-rate * 1.5, target - forward));
  } else if (control > 0) {
    forward *= Math.exp(-COAST_DRAG * dt);
    forward -= Math.sign(forward) * Math.min(Math.abs(forward), 5 * dt);
  } else if (car.slip > 0) {
    forward *= Math.exp(-0.6 * dt);
  }

  car.vx = cos * forward - sin * side;
  car.vz = sin * forward + cos * side;
};

const stepAir = (car: Car, dt: number, events: CarEvents) => {
  if (car.y <= 0 && car.vy <= 0) {
    return;
  }

  car.vy -= GRAVITY * dt;
  car.y += car.vy * dt;

  if (car.stagger > 0) {
    car.tumble += dt * 13;
  }

  if (car.y <= 0) {
    events.landed = true;
    events.stomped = car.hop;
    Object.assign(car, { hop: false, tumble: 0, vy: 0, y: 0 });
  }
};

/** Advance one car by `dt`. `late` is the board with its rim gone. */
export const stepCar = (car: Car, input: CarInput, arena: Arena, late: boolean, dt: number) => {
  const events: CarEvents = {
    fell: false,
    landed: false,
    out: false,
    stomped: false,
    struck: false,
    used: "",
    whiffed: false,
  };

  car.modeT += dt;

  if (car.mode === "out") {
    return events;
  }

  if (car.mode === "fall") {
    car.vy -= GRAVITY * dt;
    car.x += car.vx * dt;
    car.y += car.vy * dt;
    car.z += car.vz * dt;
    car.tumble += dt * 9;

    if (car.modeT >= FALL_SECONDS) {
      Object.assign(car, { falls: car.falls + 1, mode: "out", modeT: 0, outBy: car.lastBy });
      events.out = true;
    }

    return events;
  }

  if (car.mode === "drop") {
    car.vy -= GRAVITY * dt;
    car.y += car.vy * dt;

    if (car.y <= 0) {
      Object.assign(car, { mode: "drive", modeT: 0, safe: SAFE_SECONDS, vy: 0, y: 0 });
      events.landed = true;
    }

    return events;
  }

  stepTimers(car, dt);
  stepAttack(car, input, dt, events);

  car.wish = input.special ? SPECIAL_BUFFER : Math.max(0, car.wish - dt);

  if (car.wish > 0) {
    events.used = letGo(car);
    car.wish = events.used === "" ? car.wish : 0;
  }

  stepDrive(car, input, dt);
  car.x += (car.vx + car.kx) * dt;
  car.z += (car.vz + car.kz) * dt;
  const fade = Math.exp(-dt / car.ktau);
  car.kx *= fade;
  car.kz *= fade;
  stepAir(car, dt, events);

  if (car.y <= 0 && edgeDistance(arena, car.x, car.z, late) < 0) {
    Object.assign(car, {
      boosting: false,
      mode: "fall",
      modeT: 0,
      phase: "idle",
      vx: (car.vx + car.kx) * 0.55,
      vy: 0,
      vz: (car.vz + car.kz) * 0.55,
    } satisfies Partial<Car>);
    events.fell = true;
  }

  return events;
};
