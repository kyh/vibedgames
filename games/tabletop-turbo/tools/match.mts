import { ROUND_MS, STEP } from "../src/shared/constants.ts";
import { arenaFor } from "../src/sim/arena.ts";
import type { Arena } from "../src/sim/arena.ts";
import { botInput, makeBrain, makeDirector } from "../src/sim/bot.ts";
import type { BotView } from "../src/sim/bot.ts";
import { gridCar, makeCar } from "../src/sim/car.ts";
import type { CarInput } from "../src/sim/car.ts";
import { grant, makeField, reward, stepField } from "../src/sim/field.ts";
import type { Field, FieldEvent } from "../src/sim/field.ts";
import { crateAt } from "../src/sim/items.ts";

export interface MatchLog {
  falls: Map<string, number>;
  scores: Map<string, number>;
  events: FieldEvent[];
  causes: Map<string, number>;
}

const bump = (tally: Map<string, number>, key: string, by: number) => {
  tally.set(key, Math.max(0, (tally.get(key) ?? 0) + by));
};

const settle = (field: Field, log: MatchLog, event: FieldEvent) => {
  log.events.push(event);

  if (event.kind === "reach") {
    grant(field, event.key, event.crate, event.item);
  }

  if (event.kind !== "out") {
    return;
  }

  bump(log.falls, event.key, 1);
  const car = field.cars.get(event.key);

  if (event.by === "") {
    bump(log.causes, `self:${car?.hitHow ?? ""}`, 1);
    bump(log.scores, event.key, -1);
  } else {
    bump(log.causes, "car", 1);
    bump(log.scores, event.by, 1);
    reward(field, event.by);
  }
};

/** A whole round of bots only, with no page: the host's sim and nothing else. */
export const playMatch: (round: number, count?: number, arena?: Arena) => MatchLog = (
  round,
  count = 8,
  arena = arenaFor(0),
) => {
  const field = makeField(arena);
  field.round = round;
  field.time = -1;
  const brains = new Map<string, ReturnType<typeof makeBrain>>();
  const director = makeDirector();

  for (let i = 0; i < count; i += 1) {
    const car = makeCar(`b${i}`, true);
    const spawn = arena.def.grid[i];

    if (spawn) {
      gridCar(car, spawn);
      field.cars.set(car.key, car);
      brains.set(car.key, makeBrain(i + round * 11));
    }
  }

  const log: MatchLog = { causes: new Map(), events: [], falls: new Map(), scores: new Map() };
  const inputs = new Map<string, CarInput>();

  while (field.time * 1000 < ROUND_MS) {
    const views: BotView[] = [...field.cars.values()].map((car) => ({
      alive: car.mode === "drive",
      human: false,
      key: car.key,
      safe: car.safe > 0,
      vx: car.vx,
      vz: car.vz,
      x: car.x,
      z: car.z,
    }));

    const crate = crateAt(arena, round, field.time);
    const open = crate && !field.taken.has(crate.index) ? crate : null;

    for (const car of field.cars.values()) {
      const brain = brains.get(car.key);

      if (brain) {
        inputs.set(car.key, botInput(brain, car, arena, field.time, views, open, director, STEP));
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
