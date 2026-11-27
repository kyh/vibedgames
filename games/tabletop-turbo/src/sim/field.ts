import {
  BOOST_REWARD,
  CREDIT_SECONDS,
  GIANT_SCALE,
  PICKUP_RADIUS,
  PUNCH_RECOIL,
  RAM_MIN,
  RAM_THROW,
  RESPAWN_SECONDS,
  ROUND_MS,
} from "../shared/constants";
import type { ItemKind } from "../shared/constants";
import type { Arena } from "./arena";
import {
  NO_INPUT,
  canHit,
  carRadius,
  clash,
  dropCar,
  giveItem,
  inPunch,
  nudge,
  punchHit,
  stepCar,
  takeHit,
  wouldClash,
} from "./car";
import type { Car, CarEvents, CarInput, Hit } from "./car";
import { hazardHit, shrinkAt } from "./hazards";
import { crateAt } from "./items";
import type { Crate } from "./items";

/** A car somebody else simulates: all this client knows is where it is. */
export interface Ghost {
  key: string;
  x: number;
  y: number;
  z: number;
  a: number;
  vx: number;
  vz: number;
  radius: number;
  /** On the board and able to be hit. */
  alive: boolean;
  safe: boolean;
  boosting: boolean;
}

/**
 * What a step did. `hit` landed on a car simulated here and throws it `reach`;
 * `send` is a blow on somebody else's car, theirs to accept and ours to send.
 */
export type FieldEvent =
  | { kind: "hit"; to: string; hit: Hit; reach: number; x: number; z: number }
  | { kind: "send"; to: string; hit: Hit; x: number; z: number }
  | { kind: "clash"; a: string; b: string; x: number; z: number; remote: boolean }
  | { kind: "punch"; key: string }
  | { kind: "whiff"; key: string }
  | { kind: "land"; key: string; drop: boolean }
  | { kind: "fall"; key: string }
  | { kind: "out"; key: string; by: string }
  | { kind: "reach"; key: string; crate: number; item: ItemKind };

export interface Field {
  arena: Arena;
  round: number;
  /** Seconds into the round: negative under the countdown. */
  time: number;
  /** Cars simulated here: this player's, and the bots' on the host. */
  cars: Map<string, Car>;
  ghosts: Map<string, Ghost>;
  /** Crates of this round already taken. */
  taken: Set<number>;
  events: FieldEvent[];
  seq: number;
}

export const makeField: (arena: Arena) => Field = (arena) => ({
  arena,
  cars: new Map<string, Car>(),
  events: [],
  ghosts: new Map<string, Ghost>(),
  round: 0,
  seq: 0,
  taken: new Set<number>(),
  time: 0,
});

interface Body {
  key: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  radius: number;
  alive: boolean;
  safe: boolean;
  car: Car | null;
}

const bodies = (field: Field) => {
  const out: Body[] = [];

  for (const car of field.cars.values()) {
    out.push({
      alive: car.mode === "drive",
      car,
      key: car.key,
      radius: carRadius(car),
      safe: car.safe > 0,
      vx: car.vx,
      vz: car.vz,
      x: car.x,
      y: car.y,
      z: car.z,
    });
  }

  for (const ghost of field.ghosts.values()) {
    if (!field.cars.has(ghost.key)) {
      out.push({ ...ghost, car: null });
    }
  }

  return out;
};

const nextId = (field: Field, by: string) => {
  field.seq += 1;

  return `${by}:${field.round}:${field.seq}`;
};

/** Deliver a blow to a car simulated here. True if it landed. */
export const deliver = (field: Field, car: Car, hit: Hit) => {
  const attacker = field.cars.get(hit.by);

  if (canHit(car, hit) && wouldClash(car, hit)) {
    clash(car, hit.dx, hit.dz);
    car.hitId = hit.id;

    if (attacker) {
      clash(attacker, -hit.dx, -hit.dz);
    }

    field.events.push({
      a: hit.by,
      b: car.key,
      kind: "clash",
      remote: !attacker,
      x: (car.x + (attacker?.x ?? car.x - hit.dx * 3)) / 2,
      z: (car.z + (attacker?.z ?? car.z - hit.dz * 3)) / 2,
    });

    return false;
  }

  const reach = takeHit(car, hit);

  if (reach <= 0) {
    return false;
  }

  field.events.push({ hit, kind: "hit", reach, to: car.key, x: car.x, z: car.z });

  return true;
};

const punches = (field: Field, all: readonly Body[]) => {
  for (const car of field.cars.values()) {
    if (car.mode === "drive" && car.phase === "strike") {
      for (const body of all) {
        const open = body.key !== car.key && body.alive && !body.safe && !car.struck.has(body.key);

        if (open && body.y < 2.2 && inPunch(car, body.x, body.z, body.radius)) {
          car.struck.add(body.key);
          const hit = punchHit(car, body.x, body.z, nextId(field, car.key));
          const landed = body.car ? deliver(field, body.car, hit) : true;

          if (!body.car) {
            field.events.push({ hit, kind: "send", to: body.key, x: body.x, z: body.z });
          }

          if (landed && !car.landed) {
            car.landed = true;
            nudge(car, -Math.cos(car.a), -Math.sin(car.a), PUNCH_RECOIL);
          }
        }
      }
    }
  }
};

const ram = (field: Field, car: Car, body: Body, nx: number, nz: number, closing: number) => {
  const hit: Hit = {
    by: car.key,
    dx: -nx,
    dz: -nz,
    how: "ram",
    id: nextId(field, car.key),
    reach: RAM_THROW,
  };

  const landed = body.car ? deliver(field, body.car, hit) : !body.safe;

  if (!body.car && landed) {
    field.events.push({ hit, kind: "send", to: body.key, x: body.x, z: body.z });
  }

  if (landed) {
    car.vx += nx * closing * 1.5;
    car.vz += nz * closing * 1.5;
    car.locks.set(`ram:${body.key}`, 1);
  }
};

const touch = (field: Field, car: Car, body: Body, gap: number, reach: number) => {
  const stacked = gap <= 0.001;
  const side = car.key < body.key ? 1 : -1;
  const nx = stacked ? side : (car.x - body.x) / gap;
  const nz = stacked ? 0 : (car.z - body.z) / gap;
  const heavy = car.mod === "giant" ? 0.25 : 0.5;
  const share = body.car?.mod === "giant" && car.mod !== "giant" ? 0.75 : heavy;
  car.x += nx * (reach - gap) * share;
  car.z += nz * (reach - gap) * share;
  const closing = -(car.vx * nx + car.vz * nz);
  const theirs = body.vx * nx + body.vz * nz;
  const free = car.stagger <= 0 && (car.locks.get(`ram:${body.key}`) ?? 0) <= 0;

  if (car.safe > 0 && closing > 3) {
    car.safe = 0;
  } else if (closing >= RAM_MIN && closing > theirs && free && !body.safe) {
    ram(field, car, body, nx, nz, closing);
  } else if (theirs > 3 && !body.safe && (car.lastBy === "" || car.lastBy === body.key)) {
    car.lastBy = body.key;
    car.lastByT = Math.min(car.lastByT, CREDIT_SECONDS - 1);
  }
};

const contacts = (field: Field, all: readonly Body[]) => {
  for (const car of field.cars.values()) {
    const radius = carRadius(car);
    const low = car.mode === "drive" && car.y < 0.7;

    for (const body of low ? all : []) {
      const gap = Math.hypot(car.x - body.x, car.z - body.z);
      const reach = radius + body.radius;

      if (body.key !== car.key && body.alive && body.y < 0.7 && gap < reach) {
        touch(field, car, body, gap, reach);
      }
    }
  }
};

const spawnFor = (field: Field, car: Car, all: readonly Body[]) => {
  let best = field.arena.def.spawns[0] ?? { a: 0, x: 0, z: 0 };
  let bestGap = -1;

  for (const spawn of field.arena.def.spawns) {
    let gap = Number.POSITIVE_INFINITY;

    for (const body of all) {
      if (body.key !== car.key && (body.alive || body.y > 0.5)) {
        gap = Math.min(gap, Math.hypot(body.x - spawn.x, body.z - spawn.z));
      }
    }

    if (gap > bestGap) {
      bestGap = gap;
      best = spawn;
    }
  }

  return best;
};

const shove = (field: Field, car: Car, all: readonly Body[]) => {
  for (const body of all) {
    const dx = body.x - car.x;
    const dz = body.z - car.z;
    const gap = Math.hypot(dx, dz);

    if (body.key !== car.key && body.alive && !body.safe && gap < 3.4) {
      const hit: Hit = {
        by: "",
        dx: gap > 0.001 ? dx / gap : 1,
        dz: gap > 0.001 ? dz / gap : 0,
        how: "land",
        id: nextId(field, car.key),
        reach: 2.6,
      };

      if (body.car) {
        deliver(field, body.car, hit);
      } else {
        field.events.push({ hit, kind: "send", to: body.key, x: body.x, z: body.z });
      }
    }
  }
};

/** Give `key` the knock-off's reward: half a boost meter back. */
export const reward = (field: Field, key: string) => {
  const car = field.cars.get(key);

  if (car) {
    car.meter = Math.min(1, car.meter + BOOST_REWARD);
  }
};

/** Hand a crate to a car simulated here. */
export const grant = (field: Field, key: string, crate: number, item: ItemKind) => {
  field.taken.add(crate);
  const car = field.cars.get(key);

  if (car) {
    giveItem(car, item);
  }
};

const report = (field: Field, car: Car, events: CarEvents) => {
  if (events.struck) {
    field.events.push({ key: car.key, kind: "punch" });
  }

  if (events.whiffed) {
    field.events.push({ key: car.key, kind: "whiff" });
  }

  if (events.landed) {
    field.events.push({ drop: car.safe > 0, key: car.key, kind: "land" });
  }

  if (events.fell) {
    field.events.push({ key: car.key, kind: "fall" });
  }

  if (events.out) {
    field.events.push({ by: car.lastBy, key: car.key, kind: "out" });
  }
};

const hazards = (field: Field) => {
  for (const car of field.cars.values()) {
    if (car.mode === "drive" && car.y < 1.2) {
      const hit = hazardHit(field.arena, field.time, car.x, car.z, carRadius(car));

      if (hit) {
        deliver(field, car, hit);
      }
    }
  }
};

const reaches = (field: Field, car: Car, crate: Crate | null) => {
  const near =
    crate !== null &&
    !field.taken.has(crate.index) &&
    field.time >= crate.landAt &&
    car.mode === "drive" &&
    Math.hypot(car.x - crate.x, car.z - crate.z) <
      PICKUP_RADIUS * (car.mod === "giant" ? GIANT_SCALE : 1);

  if (near) {
    field.events.push({ crate: crate.index, item: crate.kind, key: car.key, kind: "reach" });
  }
};

const respawn = (field: Field, car: Car, all: readonly Body[]) => {
  dropCar(car, spawnFor(field, car, all));
  const body = all.find((other) => other.key === car.key);

  if (body) {
    Object.assign(body, { x: car.x, y: car.y, z: car.z });
  }
};

/**
 * Advance every car simulated here by `dt`, and settle what they did to each
 * other, to the ghosts and to the board. `inputs` is by car key. A car named
 * by `held` stands still for the step (its owner is in a hit-stop) but can
 * still be hit.
 */
export const stepField = (
  field: Field,
  inputs: ReadonlyMap<string, CarInput>,
  dt: number,
  held = "",
) => {
  const { arena } = field;
  const live = field.time >= 0 && field.time * 1000 < ROUND_MS;
  const { late } = shrinkAt(field.time * 1000);
  const dropped: Car[] = [];

  for (const car of field.cars.values()) {
    if (car.key !== held) {
      const input = live ? (inputs.get(car.key) ?? NO_INPUT) : NO_INPUT;
      const events = stepCar(car, input, arena, late, dt);
      report(field, car, events);

      if (events.landed && car.safe > 0) {
        dropped.push(car);
      }
    }
  }

  const all = bodies(field);

  for (const car of dropped) {
    shove(field, car, all);
  }

  if (live) {
    hazards(field);
    punches(field, all);
  }

  contacts(field, all);
  const crate = crateAt(arena, field.round, field.time);

  for (const car of field.cars.values()) {
    if (car.mode === "out" && car.modeT >= RESPAWN_SECONDS && live) {
      respawn(field, car, all);
    }

    reaches(field, car, crate);
  }

  field.time += dt;
};
