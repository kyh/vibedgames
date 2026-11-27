import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue } from "@vibedgames/multiplayer";

import { adoptCar, encodeCar, ghostOf, readPose, viewOf } from "../src/net/pose.ts";
import { PUNCH_THROW, STEP } from "../src/shared/constants.ts";
import { ARENAS, buildArena } from "../src/sim/arena.ts";
import { giveItem, gridCar, makeCar } from "../src/sim/car.ts";
import type { CarInput, Hit } from "../src/sim/car.ts";
import { deliver, makeField, stepField } from "../src/sim/field.ts";
import type { Field, FieldEvent } from "../src/sim/field.ts";

const [first] = ARENAS;

assert.ok(first);

const OPEN = buildArena({ ...first, hazards: [], holes: [] });
const PUNCH: CarInput = { boost: false, mx: 0, mz: 0, punch: true };

const place = (field: Field, key: string, x: number, z: number, a: number) => {
  const car = makeCar(key, false);
  gridCar(car, { a, x, z });
  field.cars.set(key, car);

  return car;
};

const run = (field: Field, seconds: number, inputs: Record<string, CarInput> = {}) => {
  const events: FieldEvent[] = [];
  const map = new Map(Object.entries(inputs));

  for (let t = 0; t < seconds; t += STEP) {
    stepField(field, map, STEP);
    events.push(...field.events);
    field.events.length = 0;
  }

  return events;
};

const overWire = (row: JsonValue) => readPose(structuredClone(row));

test("a car survives the wire, and junk rows are refused", () => {
  const field = makeField(OPEN);
  const car = place(field, "p1", 4.25, -3.5, 1.2);
  place(field, "p2", 4.25 + Math.cos(1.2) * 3, -3.5 + Math.sin(1.2) * 3, 0);
  giveItem(car, "mega");
  giveItem(car, "turbo");
  run(field, 0.3, { p1: { boost: true, mx: 0.4, mz: 1, punch: true } });
  const report = overWire(encodeCar(car, 1234.4, 7));
  const view = viewOf(car);
  assert.ok(report);
  assert.equal(report.t, 1234);
  assert.equal(report.round, 7);

  for (const key of ["mode", "bumper", "mod", "punches", "launches", "falls", "dent"] as const) {
    assert.equal(report[key], view[key], key);
  }

  for (const key of ["x", "y", "z", "a", "vx", "vz", "meter", "cooldown"] as const) {
    assert.ok(Math.abs(report[key] - view[key]) < 0.06, `${key}: ${report[key]} / ${view[key]}`);
  }

  assert.equal(report.boosting, view.boosting);
  assert.equal(report.ready, false);
  assert.equal(report.bumper, "mega");
  assert.equal(report.mod, "turbo");
  assert.equal(overWire({}), null);
  assert.equal(overWire(null), null);
  assert.equal(overWire({ a: 0, t: "now", x: 1, z: 2 }), null);
  assert.equal(overWire({ a: 0, t: 5, x: 1 }), null);
  const bare = overWire({ a: 0, t: 5, x: 1, z: 2 });
  assert.ok(bare);
  assert.equal(bare.mode, "drive");
  assert.equal(bare.hitId, "");
});

test("a punch on somebody else's car is sent, and lands on the client that owns it", () => {
  const mine = makeField(OPEN);
  const theirs = makeField(OPEN);
  place(mine, "p1", 0, 0, 0);
  const target = place(theirs, "p2", 3, 0, 0);
  mine.ghosts.set("p2", ghostOf("p2", viewOf(target)));
  const events = run(mine, 0.3, { p1: PUNCH });
  const send = events.find((event) => event.kind === "send");
  assert.ok(send && send.kind === "send");
  assert.equal(send.to, "p2");
  assert.equal(events.filter((event) => event.kind === "send").length, 1);
  const hit: Hit = structuredClone(send.hit);
  assert.equal(deliver(theirs, target, hit), true);
  assert.equal(target.hitId, hit.id);
  assert.equal(target.lastBy, "p1");
  assert.equal(target.launches, 1);
  assert.equal(deliver(theirs, target, hit), false, "the same blow twice lands once");
  run(theirs, 1.5);
  assert.ok(Math.abs(target.x - 3 - PUNCH_THROW) < PUNCH_THROW * 0.2);
  const view = viewOf(target);
  assert.equal(view.hitId, hit.id);
});

test("a ghost that is shielded or off the board is not punched", () => {
  for (const patch of [{ safe: 1 }, { mode: "out" as const }]) {
    const mine = makeField(OPEN);
    place(mine, "p1", 0, 0, 0);
    const target = makeCar("p2", false);
    gridCar(target, { a: 0, x: 3, z: 0 });
    Object.assign(target, patch);
    mine.ghosts.set("p2", ghostOf("p2", viewOf(target)));
    const events = run(mine, 0.3, { p1: PUNCH });
    assert.equal(
      events.some((event) => event.kind === "send"),
      false,
    );
  }
});

test("a new host picks a bot up where its last report left it", () => {
  const field = makeField(OPEN);
  const bot = place(field, "b0", -6, 2, 0.4);
  giveItem(bot, "giant");
  run(field, 0.5, { b0: { boost: false, mx: 1, mz: 0.3, punch: true } });
  Object.assign(bot, { falls: 2, lastBy: "p1" });
  const report = overWire(encodeCar(bot, 900, 3));
  assert.ok(report);
  const heir = makeCar("b0", true);
  adoptCar(heir, report);
  assert.equal(heir.mode, "drive");
  assert.equal(heir.falls, 2);
  assert.equal(heir.punches, bot.punches);
  assert.equal(heir.mod, "giant");
  assert.ok(heir.cooldown > 0);
  assert.ok(Math.hypot(heir.x - bot.x, heir.z - bot.z) < 0.02);
  const next = makeField(OPEN);
  next.cars.set("b0", heir);
  run(next, 0.5, { b0: { boost: false, mx: 1, mz: 0.3, punch: false } });
  assert.ok(heir.x > bot.x + 3, "drives on");
});
