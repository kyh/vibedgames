import { ROUND_MS, SHRINK_MS, SQUEEZE_POINTS, STEP } from "../src/shared/constants.ts";
import { arenaFor } from "../src/sim/arena.ts";
import type { Arena } from "../src/sim/arena.ts";
import { botInput, makeBrain, makeDirector } from "../src/sim/bot.ts";
import type { BotView } from "../src/sim/bot.ts";
import { gridCar, makeCar } from "../src/sim/car.ts";
import type { CarInput } from "../src/sim/car.ts";
import { cubesAt } from "../src/sim/cubes.ts";
import { makeField } from "../src/sim/field.ts";
import type { Field, FieldEvent } from "../src/sim/field.ts";
import { shrinkAt } from "../src/sim/hazards.ts";
import { CAR_KINDS } from "../src/sim/kinds.ts";
import type { CarKind } from "../src/sim/kinds.ts";
import { specialFor } from "../src/sim/specials.ts";
import { grant, reward, stepField } from "../src/sim/step.ts";

export interface MatchLog {
  falls: Map<string, number>;
  scores: Map<string, number>;
  kinds: Map<string, CarKind>;
  events: FieldEvent[];
  causes: Map<string, number>;
  /** Every fall: who, who is credited, and the blow that did it. */
  outs: { key: string; by: string; how: string }[];
}

const bump = (tally: Map<string, number>, key: string, by: number) => {
  tally.set(key, Math.max(0, (tally.get(key) ?? 0) + by));
};

const placeOf = (log: MatchLog, key: string) => {
  const mine = log.scores.get(key) ?? 0;
  let place = 1;

  for (const [other, score] of log.scores) {
    if (other !== key && score > mine) {
      place += 1;
    }
  }

  return place;
};

const settle = (field: Field, log: MatchLog, event: FieldEvent) => {
  log.events.push(event);

  if (event.kind === "reach") {
    const special = specialFor(field.round, event.cube, placeOf(log, event.key), field.cars.size);
    grant(field, event.key, event.cube, special);
  }

  if (event.kind !== "out") {
    return;
  }

  bump(log.falls, event.key, 1);
  const car = field.cars.get(event.key);
  log.outs.push({ by: event.by, how: car?.hitHow ?? "", key: event.key });

  if (event.by === "") {
    bump(log.causes, `self:${car?.hitHow ?? ""}`, 1);
    bump(log.scores, event.key, -1);
  } else {
    bump(log.causes, `car:${car?.hitHow ?? ""}`, 1);
    bump(log.scores, event.by, field.time * 1000 >= ROUND_MS - SHRINK_MS ? SQUEEZE_POINTS : 1);
    reward(field, event.by);
  }
};

/** The kind seat `seat` drives in `round`: every kind takes every seat in turn. */
export const kindFor = (seat: number, round: number) =>
  CAR_KINDS[(seat + round) % CAR_KINDS.length] ?? "bumper";

/** A whole round of bots only, with no page: the host's sim and nothing else. */
export const playMatch: (
  round: number,
  count?: number,
  arena?: Arena,
  kinds?: (seat: number) => CarKind,
) => MatchLog = (round, count = 8, arena = arenaFor(0), kinds = (seat) => kindFor(seat, round)) => {
  const field = makeField(arena);
  field.round = round;
  field.time = -1;
  const brains = new Map<string, ReturnType<typeof makeBrain>>();
  const director = makeDirector();

  const log: MatchLog = {
    causes: new Map(),
    events: [],
    falls: new Map(),
    kinds: new Map(),
    outs: [],
    scores: new Map(),
  };

  for (let i = 0; i < count; i += 1) {
    const car = makeCar(`b${i}`, true, kinds(i));
    const spawn = arena.def.grid[i];

    if (spawn) {
      gridCar(car, spawn);
      field.cars.set(car.key, car);
      brains.set(car.key, makeBrain(i, round));
      log.kinds.set(car.key, car.kind);
      log.scores.set(car.key, 0);
    }
  }

  const inputs = new Map<string, CarInput>();

  while (field.time * 1000 < ROUND_MS) {
    const views: BotView[] = [...field.cars.values()].map((car) => ({
      alive: car.mode === "drive",
      damage: car.damage,
      human: false,
      key: car.key,
      safe: car.safe > 0,
      vx: car.vx,
      vz: car.vz,
      x: car.x,
      z: car.z,
    }));

    const { late } = shrinkAt(field.time * 1000);
    const cubes = cubesAt(arena, field.time, late).filter((cube) => !field.taken.has(cube.id));

    for (const car of field.cars.values()) {
      const brain = brains.get(car.key);

      if (brain) {
        inputs.set(car.key, botInput(brain, car, arena, field.time, views, cubes, director, STEP));
      }
    }

    stepField(field, inputs, STEP);

    for (const event of field.events) {
      settle(field, log, event);
    }

    field.events.length = 0;
  }

  return log;
};
