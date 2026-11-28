import {
  BOOST_REWARD,
  CREDIT_SECONDS,
  PICKUP_RADIUS,
  PUNCH_RECOIL,
  RAM_DAMAGE,
  RAM_MIN,
  RAM_THROW,
  RESPAWN_SECONDS,
  ROUND_MS,
} from "../shared/constants";
import { fire, spawnShot, stepShots, stomp } from "./arsenal";
import { NO_INPUT, attackHit, carRadius, carScale, dropCar, inFront, nudge, stepCar } from "./car";
import type { Car, CarEvents, CarInput, Hit } from "./car";
import { cubesAt } from "./cubes";
import type { Cube } from "./cubes";
import { blow, bodies, deliver, nextId } from "./field";
import type { Body, Field } from "./field";
import { hazardHit, shrinkAt } from "./hazards";
import { DASH_CATCH, KINDS, SLAM_RADIUS, SPIN_RADIUS } from "./kinds";
import type { AttackKind } from "./kinds";
import type { SpecialKind } from "./specials";

const inReach = (car: Car, attack: AttackKind, body: Body) => {
  if (attack === "punch" || attack === "scoop") {
    return inFront(car, body.x, body.z, body.radius);
  }

  const gap = Math.hypot(body.x - car.x, body.z - car.z);

  if (attack === "dash") {
    const along = (body.x - car.x) * Math.cos(car.a) + (body.z - car.z) * Math.sin(car.a);

    return along > -0.4 && gap < carRadius(car) + body.radius + DASH_CATCH;
  }

  const radius = attack === "slam" ? SLAM_RADIUS : SPIN_RADIUS;

  return gap < radius * carScale(car) + body.radius * 0.5;
};

const attacks = (field: Field, all: readonly Body[]) => {
  for (const car of field.cars.values()) {
    const { attack } = KINDS[car.kind];
    const out = car.mode === "drive" && car.phase === "strike" && attack !== "shot";

    for (const body of out ? all : []) {
      const open = body.key !== car.key && body.alive && !body.safe && !car.struck.has(body.key);

      if (open && body.y < 2.2 && inReach(car, attack, body)) {
        car.struck.add(body.key);
        const hit = attackHit(car, body.x, body.z, nextId(field, car.key));

        if (blow(field, body, hit) && !car.landed) {
          car.landed = true;

          if (attack === "punch") {
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
    damage: RAM_DAMAGE,
    dx: -nx,
    dz: -nz,
    how: "ram",
    id: nextId(field, car.key),
    lift: 1,
    reach: RAM_THROW,
    stun: 0,
  };

  if (blow(field, body, hit)) {
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
      blow(field, body, {
        by: "",
        damage: 0,
        dx: gap > 0.001 ? dx / gap : 1,
        dz: gap > 0.001 ? dz / gap : 0,
        how: "land",
        id: nextId(field, car.key),
        lift: 1,
        reach: 2.6,
        stun: 0,
      });
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

/** Hand a cube's special to a car simulated here: it keeps the one it has if it has one. */
export const grant = (field: Field, key: string, cube: number, special: SpecialKind) => {
  field.taken.add(cube);
  const car = field.cars.get(key);

  if (car && car.special === "") {
    car.special = special;
  }
};

const report = (field: Field, car: Car, events: CarEvents) => {
  if (events.struck) {
    field.events.push({ key: car.key, kind: "attack" });
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

const hazards = (field: Field, late: boolean) => {
  for (const car of field.cars.values()) {
    if (car.mode === "drive" && car.y < 1.2) {
      const hit = hazardHit(field.arena, field.time, car.x, car.z, carRadius(car), late);

      if (hit) {
        deliver(field, car, hit);
      }
    }
  }
};

const reaches = (field: Field, car: Car, cubes: readonly Cube[]) => {
  if (car.mode !== "drive" || car.special !== "" || car.y > 1) {
    return;
  }

  for (const cube of cubes) {
    const near = Math.hypot(car.x - cube.x, car.z - cube.z) < PICKUP_RADIUS * carScale(car);

    if (near && field.time >= cube.landAt && !field.taken.has(cube.id)) {
      field.events.push({ cube: cube.id, key: car.key, kind: "reach" });

      return;
    }
  }
};

const respawn = (field: Field, car: Car, all: readonly Body[]) => {
  dropCar(car, spawnFor(field, car, all));
  const body = all.find((other) => other.key === car.key);

  if (body) {
    Object.assign(body, { x: car.x, y: car.y, z: car.z });
  }
};

interface Acts {
  dropped: Car[];
  stomped: Car[];
  fired: Car[];
  used: [Car, SpecialKind][];
}

const act = (acts: Acts, car: Car, events: CarEvents) => {
  if (events.landed && car.safe > 0) {
    acts.dropped.push(car);
  }

  if (events.stomped) {
    acts.stomped.push(car);
  }

  if (events.struck && KINDS[car.kind].attack === "shot") {
    acts.fired.push(car);
  }

  if (events.used !== "") {
    acts.used.push([car, events.used]);
  }
};

const settle = (field: Field, acts: Acts, all: readonly Body[], late: boolean, dt: number) => {
  hazards(field, late);
  attacks(field, all);

  for (const car of acts.fired) {
    spawnShot(field, car, "puck", all);
  }

  for (const [car, special] of acts.used) {
    fire(field, car, special, all);
  }

  for (const car of acts.stomped) {
    stomp(field, car, all);
  }

  stepShots(field, all, dt);
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
  const acts: Acts = { dropped: [], fired: [], stomped: [], used: [] };

  for (const car of field.cars.values()) {
    if (car.key !== held) {
      const input = live ? (inputs.get(car.key) ?? NO_INPUT) : NO_INPUT;
      const events = stepCar(car, input, arena, late, dt);
      report(field, car, events);
      act(acts, car, events);
    }
  }

  const all = bodies(field);

  for (const car of acts.dropped) {
    shove(field, car, all);
  }

  if (live) {
    settle(field, acts, all, late, dt);
  }

  contacts(field, all);
  const cubes = live ? cubesAt(arena, field.time, late) : [];

  for (const car of field.cars.values()) {
    if (car.mode === "out" && car.modeT >= RESPAWN_SECONDS && live) {
      respawn(field, car, all);
    }

    reaches(field, car, cubes);
  }

  field.time += dt;
};
