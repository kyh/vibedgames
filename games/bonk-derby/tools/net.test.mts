import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue } from "@vibedgames/multiplayer";

import { encodeHit, readHit } from "../src/net/blow.ts";
import { HOWS, adoptCar, encodeCar, ghostOf, readPose, shotOf, viewOf } from "../src/net/pose.ts";
import { STEP } from "../src/shared/constants.ts";
import { ARENAS, buildArena } from "../src/sim/arena.ts";
import { NO_INPUT, dropCar, gridCar, makeCar } from "../src/sim/car.ts";
import type { CarInput, Hit } from "../src/sim/car.ts";
import { deliver, makeField } from "../src/sim/field.ts";
import type { Field, FieldEvent } from "../src/sim/field.ts";
import { KINDS } from "../src/sim/kinds.ts";
import type { CarKind } from "../src/sim/kinds.ts";
import { moveShot } from "../src/sim/shots.ts";
import { MAGNET_RADIUS, MAGNET_STOP, ZAP_DAMAGE, ZAP_STUN } from "../src/sim/specials.ts";
import { stepField } from "../src/sim/step.ts";

const [first] = ARENAS;

assert.ok(first);

const OPEN = buildArena({ ...first, hazards: [], holes: [] });
const ATTACK: CarInput = { ...NO_INPUT, attack: true };
const SPECIAL: CarInput = { ...NO_INPUT, special: true };

const place = (
  field: Field,
  key: string,
  x: number,
  z: number,
  a: number,
  kind: CarKind = "bumper",
) => {
  const car = makeCar(key, false, kind);
  gridCar(car, { a, x, z });
  field.cars.set(key, car);

  return car;
};

const run = (field: Field, seconds: number, inputs: Record<string, CarInput> = {}) => {
  const events: FieldEvent[] = [];
  const map = new Map(Object.entries(inputs));

  for (let t = 0; t < seconds - STEP / 2; t += STEP) {
    stepField(field, map, STEP);
    events.push(...field.events);
    field.events.length = 0;
  }

  return events;
};

const overWire = (row: JsonValue) => readPose(structuredClone(row));

const sendsTo = (events: readonly FieldEvent[], key: string) => {
  const out: Hit[] = [];

  for (const event of events) {
    if (event.kind === "send" && event.to === key) {
      out.push(event.hit);
    }
  }

  return out;
};

test("a car survives the wire with its kind, colour, damage and special", () => {
  const field = makeField(OPEN);
  const car = place(field, "p1", 4.25, -3.5, 1.2, "scoop");
  place(field, "p2", 4.25 + Math.cos(1.2) * 3, -3.5 + Math.sin(1.2) * 3, 0);
  Object.assign(car, { damage: 87.4, special: "giant" });
  run(field, STEP, { p1: SPECIAL });
  car.special = "seeker";
  run(field, 0.3, { p1: { ...NO_INPUT, attack: true, boost: true, gas: 1, steer: 0.4 } });
  const report = overWire(encodeCar(car, 1234.4, 7, 5, field.shots));
  const view = viewOf(car);
  assert.ok(report);
  assert.equal(report.t, 1234);
  assert.equal(report.round, 7);
  assert.equal(report.colour, 5);
  assert.equal(report.kind, "scoop");
  assert.equal(report.special, "seeker");
  assert.equal(report.mod, "giant");
  assert.equal(report.usedKind, "giant");
  assert.equal(report.uses, 1);
  assert.equal(report.damage, 87);

  for (const key of ["mode", "attacks", "launches", "falls", "hitHow", "boosting"] as const) {
    assert.equal(report[key], view[key], key);
  }

  for (const key of ["x", "y", "z", "a", "vx", "vz", "meter", "cooldown"] as const) {
    assert.ok(Math.abs(report[key] - view[key]) < 0.06, `${key}: ${report[key]} / ${view[key]}`);
  }

  assert.equal(report.ready, false);
  assert.deepEqual(report.shots, []);
});

test("junk rows are refused, and a bare one reads as an ordinary car", () => {
  assert.equal(overWire({}), null);
  assert.equal(overWire(null), null);
  assert.equal(overWire({ a: 0, t: "now", x: 1, z: 2 }), null);
  assert.equal(overWire({ a: 0, t: 5, x: 1 }), null);
  const bare = overWire({ a: 0, t: 5, x: 1, z: 2 });
  assert.ok(bare);
  assert.equal(bare.mode, "drive");
  assert.equal(bare.kind, "bumper");
  assert.equal(bare.special, "");
  assert.equal(bare.hitId, "");
  const odd = overWire({ a: 0, co: -3, d: -20, i: 99, q: 99, sh: "x", t: 5, x: 1, z: 2 });
  assert.ok(odd);
  assert.equal(odd.kind, "bumper");
  assert.equal(odd.special, "");
  assert.equal(odd.colour, 0);
  assert.equal(odd.damage, 0);
  assert.deepEqual(odd.shots, []);
});

test("what a car has let go rides its row, and flies the same on the far side", () => {
  const field = makeField(OPEN);
  const car = place(field, "p1", 0, 0, 0.3);
  place(field, "p2", 20, 30, 0);
  car.special = "rocket";
  run(field, STEP, { p1: SPECIAL });
  run(field, 0.1);
  car.special = "seeker";
  run(field, STEP, { p1: SPECIAL });
  run(field, 0.2);
  car.special = "mine";
  run(field, STEP, { p1: SPECIAL });
  assert.equal(field.shots.length, 3);
  const report = overWire(encodeCar(car, 500, 2, 0, field.shots));
  assert.ok(report);
  assert.equal(report.shots.length, 3);
  assert.deepEqual(
    report.shots.map((row) => row.kind),
    ["rocket", "seeker", "mine"],
  );

  for (const [index, row] of report.shots.entries()) {
    const mine = field.shots[index];
    assert.ok(mine);
    const theirs = shotOf("p1", 2, row);
    assert.equal(theirs.id.startsWith("p1:2:"), true);
    assert.equal(theirs.own, false);
    moveShot(theirs, field.time - STEP, 0, null);
    assert.ok(Math.hypot(theirs.x - mine.x, theirs.z - mine.z) < 0.05, `${row.kind} is in step`);
  }

  assert.equal(report.shots[1]?.target, "p2");
  const other = overWire(encodeCar(makeCar("p9", false), 500, 2, 0, field.shots));
  assert.deepEqual(other?.shots, [], "only its own");
});

test("a blow survives the wire, and one no car could deal is cut down or refused", () => {
  const hit: Hit = {
    by: "p1",
    damage: 15,
    dx: -0.6,
    dz: 0.8,
    how: "scoop",
    id: "p1:3:9",
    lift: 1.7,
    reach: 10.45,
    stun: 0,
  };

  assert.deepEqual(readHit(structuredClone(encodeHit(hit))), hit);
  const wild = readHit({ ...encodeHit(hit), d: 9000, l: 50, r: 900, s: 60, x: 30, z: 40 });
  assert.ok(wild);
  assert.ok(wild.damage <= 40 && wild.lift <= 2 && wild.reach <= 26 && wild.stun <= 2);
  assert.ok(Math.abs(Math.hypot(wild.dx, wild.dz) - 1) < 1e-9);
  const low = readHit({ ...encodeHit(hit), d: -5, r: -3 });
  assert.ok(low && low.damage === 0 && low.reach === 0);

  for (const how of ["bumper", "sweeper", "piston", "oil"] as const) {
    assert.equal(readHit(encodeHit({ ...hit, how })), null, `${how} is the board's own`);
  }

  const forged = { ...encodeHit(hit), d: 9000, l: 50, r: 900, s: 60 };
  const zap = readHit({ ...forged, n: HOWS.indexOf("zap") });
  assert.ok(zap && zap.reach === 0 && zap.stun <= ZAP_STUN && zap.damage <= ZAP_DAMAGE * 1.1);
  const land = readHit({ ...forged, n: HOWS.indexOf("land") });
  assert.ok(land && land.damage === 0 && land.reach < 3 && land.stun === 0);
  const pull = readHit({ ...forged, n: HOWS.indexOf("magnet") });
  assert.ok(pull && pull.reach < MAGNET_RADIUS + MAGNET_STOP + 1 && pull.stun === 0);
  const punch = readHit({ ...forged, n: HOWS.indexOf("punch") });
  assert.ok(punch && punch.reach < wild.reach && punch.lift === 1, "a punch is no flip");

  assert.equal(readHit(null), null);
  assert.equal(readHit({}), null);
  assert.equal(readHit({ ...encodeHit(hit), i: 7 }), null);
  assert.equal(readHit({ ...encodeHit(hit), n: 99 }), null);
  assert.equal(readHit({ ...encodeHit(hit), x: "east" }), null);
});

test("an attack on somebody else's car is sent, and lands on the client that owns it", () => {
  for (const kind of ["bumper", "scoop", "brick", "twister", "dart"] as const) {
    const mine = makeField(OPEN);
    const theirs = makeField(OPEN);
    place(mine, "p1", 0, 0, 0, kind);
    const target = place(theirs, "p2", 3, 0, 0);
    mine.ghosts.set("p2", ghostOf("p2", viewOf(target)));
    const events = run(mine, 0.8, { p1: ATTACK });
    const sends = sendsTo(events, "p2");
    assert.equal(sends.length, 1, `${kind} sends once`);
    const [sent] = sends;
    assert.ok(sent);
    const hit = readHit(structuredClone(encodeHit(sent)));
    assert.ok(hit);
    assert.equal(hit.how, KINDS[kind].attack);
    assert.equal(deliver(theirs, target, hit), true);
    assert.equal(target.hitId, hit.id);
    assert.equal(target.lastBy, "p1");
    assert.equal(target.launches, 1);
    assert.equal(target.damage, KINDS[kind].damage);
    assert.equal(deliver(theirs, target, hit), false, "the same blow twice lands once");
    run(theirs, 1.8);
    const moved = Math.hypot(target.x - 3, target.z);
    assert.ok(Math.abs(moved - sent.reach) < sent.reach * 0.2, `${kind} threw it ${moved}`);
  }
});

test("a shot and a special reach somebody else's car as blows too", () => {
  const mine = makeField(OPEN);
  place(mine, "p1", 0, 0, 0, "popper");
  const far = makeCar("p2", false);
  gridCar(far, { a: 0, x: 10, z: 0 });
  mine.ghosts.set("p2", ghostOf("p2", viewOf(far)));
  const [puck] = sendsTo(run(mine, 0.6, { p1: ATTACK }), "p2");
  assert.ok(puck);
  assert.equal(puck.how, "shot");
  const shocker = mine.cars.get("p1");
  assert.ok(shocker);
  shocker.special = "shock";
  far.x = 5;
  mine.ghosts.set("p2", ghostOf("p2", viewOf(far)));
  const [shock] = sendsTo(run(mine, STEP, { p1: SPECIAL }), "p2");
  assert.ok(shock);
  assert.equal(shock.how, "shock");
  assert.ok(shock.dx > 0.9);
});

test("a ghost that is just back or off the board is not hit", () => {
  for (const patch of [{ safe: 1 }, { mode: "out" as const }]) {
    const mine = makeField(OPEN);
    const car = place(mine, "p1", 0, 0, 0);
    const target = makeCar("p2", false);
    gridCar(target, { a: 0, x: 3, z: 0 });
    Object.assign(target, patch);
    mine.ghosts.set("p2", ghostOf("p2", viewOf(target)));
    car.special = "shock";
    const events = run(mine, 0.3, { p1: { ...ATTACK, special: true } });
    assert.equal(
      events.some((event) => event.kind === "send"),
      false,
    );
  }
});

test("a car that drops in shoves somebody else's car out of the way", () => {
  const mine = makeField(OPEN);
  const car = place(mine, "p1", 0, 0, 0);
  const near = makeCar("p2", false);
  gridCar(near, { a: 0, x: 2, z: 0 });
  mine.ghosts.set("p2", ghostOf("p2", viewOf(near)));
  dropCar(car, { a: 0, x: 0, z: 0 });
  const sends = sendsTo(run(mine, 1.5), "p2");
  assert.equal(sends.length, 1);
  const [send] = sends;
  assert.ok(send);
  assert.equal(send.how, "land");
  assert.equal(send.by, "");
  assert.ok(send.dx > 0.9);
  const theirs = makeField(OPEN);
  theirs.cars.set("p2", near);
  near.damage = 200;
  const hit = readHit(structuredClone(encodeHit(send)));
  assert.ok(hit);
  assert.equal(deliver(theirs, near, hit), true);
  assert.equal(near.lastBy, "", "nobody's point");
  assert.equal(near.damage, 200, "and no damage");
  run(theirs, 1);
  assert.ok(near.x - 2 < 3.2, "a shove, however hurt the car is");
});

test("a new host picks a bot up where its last report left it", () => {
  const field = makeField(OPEN);
  const bot = place(field, "b0", -6, 2, 0.4, "twister");
  bot.special = "giant";
  run(field, STEP, { b0: SPECIAL });
  run(field, 0.5, { b0: { ...NO_INPUT, attack: true, gas: 1, steer: 0.3 } });
  Object.assign(bot, { damage: 64, falls: 2, lastBy: "p1", outBy: "p3", special: "mine" });
  const report = overWire(encodeCar(bot, 900, 3, 4, field.shots));
  assert.ok(report);
  const heir = makeCar("b0", true);
  adoptCar(heir, report);
  assert.equal(heir.kind, "twister");
  assert.equal(heir.mode, "drive");
  assert.equal(heir.falls, 2);
  assert.equal(heir.outBy, "p3");
  assert.equal(heir.attacks, bot.attacks);
  assert.equal(heir.mod, "giant");
  assert.equal(heir.special, "mine");
  assert.equal(heir.damage, 64);
  assert.ok(heir.cooldown > 0);
  assert.ok(Math.hypot(heir.x - bot.x, heir.z - bot.z) < 0.02);
  const next = makeField(OPEN);
  next.cars.set("b0", heir);
  const from = heir.x;
  run(next, 0.5, { b0: { ...NO_INPUT, gas: 1 } });
  assert.ok(Math.hypot(heir.x - from, heir.z - bot.z) > 3, "drives on");
});
