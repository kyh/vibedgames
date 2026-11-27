import {
  ACCEL,
  BOOST_ACCEL,
  BOOST_MIN,
  BOOST_REFILL,
  BOOST_REST,
  BOOST_SECONDS,
  BOOST_SPEED,
  BOT_WINDUP,
  CAR_NOSE,
  CAR_RADIUS,
  CLASH_THROW,
  COAST_DRAG,
  CREDIT_SECONDS,
  DENT_GAIN,
  DENT_HEAL,
  DROP_HEIGHT,
  FALL_SECONDS,
  GIANT_SCALE,
  GIANT_SLOW,
  GIANT_TAKEN,
  GRAVITY,
  GRIP,
  HIT_LOCK_ANY,
  HIT_LOCK_SAME,
  ITEM_PUNCHES,
  ITEM_SECONDS,
  KNOCK_HOP,
  KNOCK_TAU,
  MAX_SPEED,
  MEGA_FORCE,
  MEGA_WIDTH,
  PUNCH_BUFFER,
  PUNCH_COOLDOWN,
  PUNCH_HALF_WIDTH,
  PUNCH_HOLD,
  PUNCH_LUNGE,
  PUNCH_REACH,
  PUNCH_RETRACT,
  PUNCH_STRIKE,
  PUNCH_SPEED_THROW,
  PUNCH_THROW,
  PUNCH_WHIFF_COOLDOWN,
  PUNCH_WINDUP,
  SAFE_SECONDS,
  SPRING_FORCE,
  SPRING_REACH,
  STAGGER,
  STAGGER_EASE,
  TURN_RATE,
} from "../shared/constants";
import type { ItemKind } from "../shared/constants";
import { edgeDistance } from "./arena";
import type { Arena, Spawn } from "./arena";

export interface CarInput {
  /** Where the stick points on the board (x right, z towards the camera), length 0–1. */
  mx: number;
  mz: number;
  /** The punch button went down this step. */
  punch: boolean;
  boost: boolean;
}

export const NO_INPUT: CarInput = { boost: false, mx: 0, mz: 0, punch: false };

export type PunchPhase = "idle" | "windup" | "strike" | "hold" | "retract";

/** drive: on the board. fall: over the edge. out: gone, waiting. drop: coming back down. */
export type CarMode = "drive" | "fall" | "out" | "drop";

export type BumperKind = "plain" | "mega" | "spring";

export type ModKind = "" | "giant" | "turbo";

/** What threw a car. */
export type HitHow = "punch" | "ram" | "bumper" | "sweeper" | "piston" | "land";

export interface Hit {
  /** Unique per blow, so one sent twice lands once. */
  id: string;
  /** The car that dealt it, or "" for the board's own toys. */
  by: string;
  how: HitHow;
  /** Unit direction of the throw. */
  dx: number;
  dz: number;
  /** How far it throws an undented car. */
  reach: number;
}

export interface Car {
  key: string;
  bot: boolean;
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
  /** Seconds left without the wheel after a hit. */
  stagger: number;
  /** -1 … 1, how hard the nose is swinging: the body leans on it. */
  steer: number;
  meter: number;
  boosting: boolean;
  rest: number;
  phase: PunchPhase;
  phaseT: number;
  buffer: number;
  cooldown: number;
  /** The length of the cooldown now running, for the ring. */
  cooldownOf: number;
  landed: boolean;
  struck: Set<string>;
  /** Punches thrown this round. */
  punches: number;
  dent: number;
  dentT: number;
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
  bumper: BumperKind;
  bumperUses: number;
  mod: ModKind;
  modT: number;
  /** Radians of roll since it left the floor, and which way it rolls. */
  tumble: number;
  spin: number;
}

/** What one step of one car did, for whoever draws and scores it. */
export interface CarEvents {
  /** The bumper fired. */
  struck: boolean;
  /** The punch ended without touching anyone. */
  whiffed: boolean;
  /** Wheels back on the floor after a throw or a drop. */
  landed: boolean;
  /** Went over the edge this step. */
  fell: boolean;
  /** Finished falling: one fall on the counter. */
  out: boolean;
}

export const makeCar: (key: string, bot: boolean) => Car = (key, bot) => ({
  a: 0,
  boosting: false,
  bot,
  buffer: 0,
  bumper: "plain",
  bumperUses: 0,
  cooldown: 0,
  cooldownOf: PUNCH_COOLDOWN,
  dent: 0,
  dentT: 0,
  falls: 0,
  hitHow: "punch",
  hitId: "",
  key,
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
  outBy: "",
  modeT: 0,
  phase: "idle",
  phaseT: 0,
  punches: 0,
  rest: 0,
  safe: 0,
  spin: 1,
  stagger: 0,
  steer: 0,
  struck: new Set<string>(),
  tumble: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  x: 0,
  y: 0,
  z: 0,
});

const clearMotion = (car: Car, spawn: Spawn) => {
  Object.assign(car, {
    a: spawn.a,
    boosting: false,
    buffer: 0,
    dent: 0,
    dentT: 0,
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
    stagger: 0,
    steer: 0,
    tumble: 0,
    vx: 0,
    vy: 0,
    vz: 0,
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
    bumper: "plain",
    bumperUses: 0,
    cooldown: 0,
    falls: 0,
    hitId: "",
    launches: 0,
    meter: 1,
    mode: "drive",
    outBy: "",
    punches: 0,
    safe: 0,
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
export const carRadius = (car: Car) => CAR_RADIUS * (car.mod === "giant" ? 1.3 : 1);

/** How far past the nose this car's bumper reaches, and half the width it sweeps. */
export const punchReach = (car: Car) => PUNCH_REACH * (car.bumper === "spring" ? SPRING_REACH : 1);

export const punchHalfWidth = (car: Car) =>
  PUNCH_HALF_WIDTH * (car.bumper === "mega" ? MEGA_WIDTH : 1);

const windupOf = (car: Car) => (car.bot ? BOT_WINDUP : PUNCH_WINDUP);

/** Where the bumper is, in world units past its rest: negative while it winds back. */
export const bumperOut = (car: Car) => {
  const reach = punchReach(car);

  if (car.phase === "windup") {
    return -0.3 * Math.min(1, car.phaseT / windupOf(car));
  }

  if (car.phase === "strike") {
    return reach * Math.min(1, car.phaseT / (PUNCH_STRIKE * 0.5));
  }

  if (car.phase === "hold") {
    return reach;
  }

  return car.phase === "retract" ? reach * (1 - car.phaseT / PUNCH_RETRACT) : 0;
};

/** 0 just fired … 1 ready again. */
export const punchReady = (car: Car) =>
  car.cooldown <= 0 ? 1 : 1 - Math.min(1, car.cooldown / car.cooldownOf);

export const wrapAngle = (a: number) => {
  const turn = Math.PI * 2;
  const r = ((a % turn) + turn) % turn;

  return r > Math.PI ? r - turn : r;
};

/** Is (x, z) inside the box this car's bumper sweeps, given the target's radius? */
export const inPunch = (car: Car, x: number, z: number, radius: number) => {
  const cos = Math.cos(car.a);
  const sin = Math.sin(car.a);
  const along = (x - car.x) * cos + (z - car.z) * sin;
  const across = Math.abs(-(x - car.x) * sin + (z - car.z) * cos);
  const scale = carScale(car);

  return (
    along > 0.2 &&
    along < CAR_NOSE * scale + punchReach(car) + radius * 0.6 &&
    across < punchHalfWidth(car) + radius * 0.7
  );
};

const bumperForce = (car: Car) => {
  if (car.bumper === "mega") {
    return MEGA_FORCE;
  }

  return car.bumper === "spring" ? SPRING_FORCE : 1;
};

/** The blow this car's bumper deals to something at (x, z). */
export const punchHit = (car: Car, x: number, z: number, id: string) => {
  const cos = Math.cos(car.a);
  const sin = Math.sin(car.a);
  const gap = Math.hypot(x - car.x, z - car.z) || 1;
  const dx = cos * 0.7 + ((x - car.x) / gap) * 0.3;
  const dz = sin * 0.7 + ((z - car.z) / gap) * 0.3;
  const length = Math.hypot(dx, dz) || 1;
  const speed = Math.max(0, car.vx * cos + car.vz * sin);

  return {
    by: car.key,
    dx: dx / length,
    dz: dz / length,
    how: "punch",
    id,
    reach: (PUNCH_THROW + speed * PUNCH_SPEED_THROW) * bumperForce(car),
  } satisfies Hit;
};

/** A shove with no stagger: recoil, a clash, a lunge. `reach` is how far it carries. */
export const nudge = (car: Car, dx: number, dz: number, reach: number) => {
  car.kx += (dx * reach) / KNOCK_TAU;
  car.kz += (dz * reach) / KNOCK_TAU;
};

/** Two bumpers met: this car bounces back off the other, nobody is thrown. */
export const clash = (car: Car, dx: number, dz: number) => {
  car.vx = 0;
  car.vz = 0;
  car.kx = (dx * CLASH_THROW) / KNOCK_TAU;
  car.kz = (dz * CLASH_THROW) / KNOCK_TAU;
  car.phase = "retract";
  car.phaseT = 0;
  car.landed = true;
};

/**
 * Would this car's bumper meet a punch coming along (dx, dz)? Only while its own
 * bumper is out and pointed back at the blow.
 */
export const wouldClash = (car: Car, hit: Hit) =>
  hit.how === "punch" &&
  (car.phase === "strike" || car.phase === "hold") &&
  Math.cos(car.a) * hit.dx + Math.sin(car.a) * hit.dz < -0.5;

const lockOf = (hit: Hit) => (hit.how === "ram" ? `ram:${hit.by}` : hit.by || hit.how);

/** Can this blow land at all: on the board, not shielded, not just hit by the same car. */
export const canHit = (car: Car, hit: Hit) => {
  if (car.mode !== "drive" || car.safe > 0 || car.hitId === hit.id) {
    return false;
  }

  if (hit.how === "land") {
    return true;
  }

  const shoved = car.hitHow === "ram" || car.hitHow === "land";
  const open = car.lockAny <= 0 || (hit.how === "punch" && shoved);

  return open && (car.locks.get(lockOf(hit)) ?? 0) <= 0;
};

/** Throw the car. Returns how far it will travel, or 0 if the blow did not land. */
export const takeHit = (car: Car, hit: Hit) => {
  if (!canHit(car, hit)) {
    return 0;
  }

  const gain = (DENT_GAIN[car.dent] ?? 1) * (car.mod === "giant" ? GIANT_TAKEN : 1);
  const reach = hit.reach * (hit.how === "land" ? 1 : gain);
  const flying = car.stagger > STAGGER_EASE;
  const along = car.kx * hit.dx + car.kz * hit.dz;

  if (hit.by !== "" && hit.how !== "land" && (!flying || along <= 0 || car.lastBy === "")) {
    car.lastBy = hit.by;
    car.lastByT = 0;
  }

  if (hit.how === "punch") {
    car.dent = Math.min(DENT_GAIN.length - 1, car.dent + 1);
    car.dentT = 0;
  }

  const soft = hit.how === "ram" || hit.how === "land";
  Object.assign(car, {
    boosting: false,
    hitHow: hit.how,
    hitId: hit.id,
    kx: (hit.dx * reach) / KNOCK_TAU,
    kz: (hit.dz * reach) / KNOCK_TAU,
    launches: car.launches + 1,
    lockAny: HIT_LOCK_ANY,
    phase: "idle",
    phaseT: 0,
    spin: Math.sin(car.a) * hit.dx - Math.cos(car.a) * hit.dz >= 0 ? 1 : -1,
    stagger: (soft ? STAGGER * 0.5 : STAGGER) + STAGGER_EASE,
    tumble: 0,
    vx: 0,
    vy: Math.sqrt(2 * GRAVITY * KNOCK_HOP * Math.min(1.3, Math.max(0.3, reach / PUNCH_THROW))),
    vz: 0,
  } satisfies Partial<Car>);
  car.locks.set(lockOf(hit), HIT_LOCK_SAME);

  return reach;
};

export const giveItem = (car: Car, kind: ItemKind) => {
  if (kind === "mega" || kind === "spring") {
    car.bumper = kind;
    car.bumperUses = ITEM_PUNCHES;
  } else {
    car.mod = kind;
    car.modT = ITEM_SECONDS;
  }
};

/** The item a car shows on the HUD: its bumper mod first, then whatever the car itself wears. */
export const heldItem: (car: Car) => ItemKind | "" = (car) =>
  car.bumper === "plain" ? car.mod : car.bumper;

const stepTimers = (car: Car, dt: number) => {
  car.buffer = Math.max(0, car.buffer - dt);
  car.cooldown = Math.max(0, car.cooldown - dt);
  car.lockAny = Math.max(0, car.lockAny - dt);
  car.lastByT += dt;
  car.dentT += dt;

  if (car.dent > 0 && car.dentT >= DENT_HEAL) {
    car.dent -= 1;
    car.dentT = 0;
  }

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

const stepPunch = (car: Car, input: CarInput, dt: number, events: CarEvents) => {
  if (input.punch) {
    car.buffer = PUNCH_BUFFER;
  }

  if (car.phase === "idle") {
    if (car.buffer > 0 && car.cooldown <= 0 && car.stagger <= STAGGER_EASE) {
      Object.assign(car, { buffer: 0, landed: false, phase: "windup", phaseT: 0, safe: 0 });
      car.struck.clear();
    }

    return;
  }

  car.phaseT += dt;

  if (car.phase === "windup" && car.phaseT >= windupOf(car)) {
    Object.assign(car, {
      cooldown: PUNCH_COOLDOWN,
      cooldownOf: PUNCH_COOLDOWN,
      phase: "strike",
      phaseT: 0,
      punches: car.punches + 1,
    });
    events.struck = true;

    if (car.boosting) {
      nudge(car, Math.cos(car.a), Math.sin(car.a), PUNCH_LUNGE);
    }
  } else if (car.phase === "strike" && car.phaseT >= PUNCH_STRIKE) {
    car.phase = "hold";
    car.phaseT = 0;

    if (!car.landed) {
      car.cooldown += PUNCH_WHIFF_COOLDOWN - PUNCH_COOLDOWN;
      car.cooldownOf = PUNCH_WHIFF_COOLDOWN;
      events.whiffed = true;
    }
  } else if (car.phase === "hold" && car.phaseT >= PUNCH_HOLD) {
    car.phase = "retract";
    car.phaseT = 0;
  } else if (car.phase === "retract" && car.phaseT >= PUNCH_RETRACT) {
    car.phase = "idle";
    car.phaseT = 0;

    if (car.bumper !== "plain") {
      car.bumperUses -= 1;

      if (car.bumperUses <= 0) {
        car.bumper = "plain";
      }
    }
  }
};

const stepBoost = (car: Car, input: CarInput, moving: boolean, dt: number) => {
  const turbo = car.mod === "turbo";
  const want = input.boost && moving && car.stagger <= 0;
  car.boosting = want && (car.boosting ? car.meter > 0 : car.meter >= BOOST_MIN);

  if (car.boosting) {
    car.meter = turbo ? 1 : Math.max(0, car.meter - dt / BOOST_SECONDS);
    car.rest = BOOST_REST;
  } else {
    car.rest = Math.max(0, car.rest - dt);

    if (car.rest <= 0) {
      car.meter = Math.min(1, car.meter + (dt / BOOST_REFILL) * (turbo ? 4 : 1));
    }
  }
};

const controlOf = (car: Car) => {
  if (car.stagger > STAGGER_EASE) {
    return 0;
  }

  return car.stagger > 0 ? 0.4 + 0.6 * (1 - car.stagger / STAGGER_EASE) : 1;
};

const stepDrive = (car: Car, input: CarInput, dt: number) => {
  const size = Math.min(1, Math.hypot(input.mx, input.mz));
  const moving = size > 0.15;

  const control = controlOf(car);

  stepBoost(car, input, moving, dt);
  let aim = 1;
  let swing = 0;

  if (moving && control > 0) {
    const off = wrapAngle(Math.atan2(input.mz, input.mx) - car.a);
    const committed = car.phase === "windup" || car.phase === "strike" || car.phase === "hold";
    const most = TURN_RATE * control * (committed ? 0.3 : 1) * dt;
    const turn = Math.min(most, Math.max(-most, off));
    car.a = wrapAngle(car.a + turn);
    aim = Math.max(0, Math.cos(off));
    swing = Math.min(1, Math.max(-1, off / 0.6));
  }

  car.steer += (swing - car.steer) * Math.min(1, dt * 12);
  const cos = Math.cos(car.a);
  const sin = Math.sin(car.a);
  let forward = car.vx * cos + car.vz * sin;
  let side = -car.vx * sin + car.vz * cos;
  side *= Math.exp(-GRIP * dt);

  if (moving && control > 0) {
    const top = (car.boosting ? BOOST_SPEED : MAX_SPEED) * (car.mod === "giant" ? GIANT_SLOW : 1);
    const target = top * size * (0.25 + 0.75 * aim);
    const rate = (car.boosting ? BOOST_ACCEL : ACCEL) * control * dt;
    forward += Math.min(rate, Math.max(-rate * 1.5, target - forward));
  } else if (control > 0) {
    forward *= Math.exp(-COAST_DRAG * dt);
    forward -= Math.sign(forward) * Math.min(Math.abs(forward), 5 * dt);
  }

  car.vx = cos * forward - sin * side;
  car.vz = sin * forward + cos * side;
};

/** Advance one car by `dt`. `late` is the board with its ends gone. */
export const stepCar = (car: Car, input: CarInput, arena: Arena, late: boolean, dt: number) => {
  const events: CarEvents = {
    fell: false,
    landed: false,
    out: false,
    struck: false,
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
  car.safe = Math.max(0, car.safe - dt);
  car.stagger = Math.max(0, car.stagger - dt);
  stepPunch(car, input, dt, events);
  stepDrive(car, input, dt);
  car.x += (car.vx + car.kx) * dt;
  car.z += (car.vz + car.kz) * dt;
  const fade = Math.exp(-dt / KNOCK_TAU);
  car.kx *= fade;
  car.kz *= fade;

  if (car.y > 0 || car.vy > 0) {
    car.vy -= GRAVITY * dt;
    car.y += car.vy * dt;
    car.tumble += dt * 13;

    if (car.y <= 0) {
      Object.assign(car, { tumble: 0, vy: 0, y: 0 });
      events.landed = true;
    }
  }

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
