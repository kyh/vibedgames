import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOOST_SECONDS,
  BOOST_SPEED,
  CREDIT_SECONDS,
  CUBES_AT,
  CUBE_BEAM,
  CUBE_EVERY,
  DAMAGE_GAIN,
  DAMAGE_MAX,
  MAX_SPEED,
  PISTON_WARN,
  RAM_THROW,
  RESPAWN_SECONDS,
  REVERSE,
  ROUND_MS,
  SAFE_SECONDS,
  SHRINK_MS,
  SHRINK_WARN_MS,
  SPECIAL_BUFFER,
  STAGGER_EASE,
  STEP,
  TURN_RATE,
} from "../src/shared/constants.ts";
import { ARENAS, arenaFor, buildArena, edgeDistance, onBoard } from "../src/sim/arena.ts";
import {
  NO_INPUT,
  carRadius,
  carWeight,
  gridCar,
  launchOf,
  makeCar,
  stickInput,
} from "../src/sim/car.ts";
import type { CarInput, Hit } from "../src/sim/car.ts";
import { cubesAt } from "../src/sim/cubes.ts";
import { deliver, makeField } from "../src/sim/field.ts";
import type { Field, FieldEvent } from "../src/sim/field.ts";
import { hazardGone, hazardHit, pistonAt, shrinkAt, sweeperAngle } from "../src/sim/hazards.ts";
import { CAR_KINDS, DASH_REACH, KINDS, PUCK_RANGE, SLAM_RADIUS } from "../src/sim/kinds.ts";
import type { CarKind } from "../src/sim/kinds.ts";
import {
  GIANT_RADIUS,
  GIANT_WEIGHT,
  MAGNET_LOCK,
  MAGNET_STOP,
  MOD_SECONDS,
  OIL_DAMAGE,
  ROCKET_THROW,
  SPECIALS,
  SPRING_HEIGHT,
  ZAP_DAMAGE,
  ZAP_STUN,
  specialFor,
} from "../src/sim/specials.ts";
import type { SpecialKind } from "../src/sim/specials.ts";
import { grant, stepField } from "../src/sim/step.ts";
import { playMatch } from "./match.mts";

const [first] = ARENAS;

assert.ok(first);

const OPEN = buildArena({ ...first, hazards: [], holes: [] });
const PINBALL = arenaFor(0);
const AHEAD: CarInput = { ...NO_INPUT, gas: 1 };
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

const run = (field: Field, seconds: number, inputs: Record<string, CarInput> = {}, held = "") => {
  const events: FieldEvent[] = [];
  const map = new Map(Object.entries(inputs));

  for (let t = 0; t < seconds - STEP / 2; t += STEP) {
    stepField(field, map, STEP, held);
    events.push(...field.events);
    field.events.length = 0;
  }

  return events;
};

const tap = (field: Field, key: string, input: CarInput) => run(field, STEP, { [key]: input });

const duel = (kind: CarKind = "bumper", gap = 3) => {
  const field = makeField(OPEN);
  const striker = place(field, "p1", 0, 0, 0, kind);
  const target = place(field, "p2", gap, 0, 0);

  return { field, striker, target };
};

const hitsOn = (events: readonly FieldEvent[], key: string) => {
  const out: Hit[] = [];

  for (const event of events) {
    if (event.kind === "hit" && event.to === key) {
      out.push(event.hit);
    }
  }

  return out;
};

const armed = (kind: SpecialKind, other: readonly [number, number] = [6, 0]) => {
  const field = makeField(OPEN);
  const car = place(field, "p1", 0, 0, 0);
  const target = place(field, "p2", other[0], other[1], 0);
  car.special = kind;

  return { car, field, target };
};

const punchFrom = (by: string, reach = 5) =>
  ({
    by,
    damage: 14,
    dx: 1,
    dz: 0,
    how: "punch",
    id: `${by}:0:1`,
    lift: 1,
    reach,
    stun: 0,
  }) satisfies Hit;

test("the board holds every start, drop and pad, and the drops survive the shrink", () => {
  for (const def of ARENAS) {
    const arena = buildArena(def);

    for (const spot of def.grid) {
      assert.ok(edgeDistance(arena, spot.x, spot.z) > 2, `${def.id} grid on the board`);
    }

    for (const spot of def.spawns) {
      assert.ok(edgeDistance(arena, spot.x, spot.z, true) > 2, `${def.id} drop on the core`);
    }

    for (const [x, z] of def.pads) {
      assert.ok(edgeDistance(arena, x, z) > 2, `${def.id} pad on the board`);
    }

    const late = def.pads.filter(([x, z]) => onBoard(arena, x, z, true));
    assert.ok(late.length >= 6, `${def.id} keeps pads once the rim is gone`);
    assert.ok(def.grid.length >= 8);
    assert.ok(def.pads.length >= 12);
    assert.ok(arena.halfX > 45 && arena.halfZ > 28, "a board a car has to drive across");
  }
});

test("every car reaches its own top speed, and stops when the pedal lets go", () => {
  for (const kind of CAR_KINDS) {
    const field = makeField(OPEN);
    const car = place(field, "p1", -30, 0, 0, kind);
    run(field, 1.5, { p1: AHEAD });
    const top = MAX_SPEED * KINDS[kind].speed;
    const speed = Math.hypot(car.vx, car.vz);
    assert.ok(speed > top * 0.97 && speed <= top + 0.01, `${kind} top speed, got ${speed}`);
    const from = car.x;
    run(field, 1);
    assert.ok(Math.hypot(car.vx, car.vz) < 0.2, `${kind} stopped`);
    assert.ok(car.x - from < 4.5, `${kind} short stop, rolled ${car.x - from}`);
  }
});

test("the wheel turns the nose, and the pedal backs the car up", () => {
  const field = makeField(OPEN);
  const car = place(field, "p1", 0, 0, 0);
  run(field, 0.5, { p1: { ...AHEAD, steer: 1 } });
  assert.ok(Math.abs(car.a - TURN_RATE * 0.5) < 0.05, `turned ${car.a}`);
  car.a = 0;
  Object.assign(car, { vx: 0, vz: 0 });
  run(field, 1.2, { p1: { ...NO_INPUT, gas: -1 } });
  assert.ok(Math.abs(car.vx + MAX_SPEED * REVERSE) < 0.2, `reverse ${car.vx}`);
  const quick = place(field, "p2", 0, 20, 0, "twister");
  const slow = place(field, "p3", 0, -20, 0, "brick");
  run(field, 0.4, { p2: { ...AHEAD, steer: 1 }, p3: { ...AHEAD, steer: 1 } });
  assert.ok(quick.a > slow.a + 0.2, "a twister out-turns a brick");
});

test("a stick drives by the screen: up is the pedal, across is the wheel", () => {
  assert.deepEqual(stickInput(0, 0.1), { gas: 0, steer: 0 });
  assert.deepEqual(stickInput(0, 1), { gas: 1, steer: 0 });
  const right = stickInput(1, 0);
  assert.ok(right.steer === 1 && right.gas > 0.2 && right.gas < 0.4);
  assert.ok(stickInput(-1, 0).steer === -1);
  const back = stickInput(0, -1);
  assert.ok(back.gas === -1 && Math.abs(back.steer) < 0.01);
  const backRight = stickInput(0.5, -0.9);
  assert.ok(backRight.gas < -0.9 && backRight.steer < -0.5, "backing up swings the tail");
  const soft = stickInput(0, 0.5);
  assert.ok(soft.gas === 0.5);
});

test("boost is faster, runs dry in a second, and comes back", () => {
  const field = makeField(OPEN);
  const car = place(field, "p1", -40, 0, 0);
  const boost = { ...AHEAD, boost: true };
  run(field, 0.6, { p1: boost });
  assert.ok(Math.hypot(car.vx, car.vz) > BOOST_SPEED * 0.95);
  run(field, BOOST_SECONDS, { p1: boost });
  assert.equal(car.boosting, false);
  assert.ok(car.meter < 0.05);
  run(field, 7);
  assert.equal(car.meter, 1);
});

test("a punch throws the car in front its own distance, and nobody beside or behind", () => {
  const { field, striker, target } = duel();
  const beside = place(field, "p3", 0, 5, 0);
  const behind = place(field, "p4", -4, 0, 0);
  const events = [...tap(field, "p1", ATTACK), ...run(field, 1.6)];
  assert.equal(striker.attacks, 1);
  assert.equal(target.launches, 1);
  assert.equal(target.lastBy, "p1");
  assert.equal(target.hitHow, "punch");
  assert.equal(target.damage, KINDS.bumper.damage);
  assert.ok(Math.abs(target.x - 3 - KINDS.bumper.throw) < 0.6, `thrown to ${target.x}`);
  assert.ok(Math.abs(target.z) < 0.5);
  assert.equal(beside.launches + behind.launches, 0);
  assert.ok(striker.x < -0.5, "the punch kicks back");
  assert.equal(events.filter((event) => event.kind === "attack").length, 1);
  assert.equal(events.filter((event) => event.kind === "hit").length, 1);
  assert.equal(
    events.some((event) => event.kind === "whiff"),
    false,
  );
});

test("a dash carries the dart through whoever is ahead", () => {
  const { field, striker, target } = duel("dart", 5);
  const events = [...tap(field, "p1", ATTACK), ...run(field, 1.4)];
  const [hit] = hitsOn(events, "p2");
  assert.ok(hit);
  assert.equal(hit.how, "dash");
  assert.ok(hit.dx > 0.9);
  assert.ok(striker.x > 3.5, `the dart went ${striker.x}`);
  assert.ok(target.x > 8, `the target went ${target.x}`);
  const alone = makeField(OPEN);
  const dart = place(alone, "p1", 0, 0, 0, "dart");
  tap(alone, "p1", ATTACK);
  run(alone, 1);
  assert.ok(Math.abs(dart.x - DASH_REACH) < 0.8, `a clear dash goes ${dart.x}`);
});

test("a slam throws everyone round the brick outwards, the near ones furthest", () => {
  const field = makeField(OPEN);
  const brick = place(field, "p1", 0, 0, 0, "brick");
  const near = place(field, "p2", 2.8, 0, 0);
  const back = place(field, "p3", -3.8, 0, 0);
  const far = place(field, "p4", 0, SLAM_RADIUS + 2, 0);
  const events = [...tap(field, "p1", ATTACK)];
  run(field, 0.1);
  assert.ok(brick.y > 0.2, `it hops first, got ${brick.y}`);
  events.push(...run(field, 1.6));
  const [hitNear] = hitsOn(events, "p2");
  const [hitBack] = hitsOn(events, "p3");
  assert.ok(hitNear && hitBack);
  assert.equal(hitNear.how, "slam");
  assert.ok(hitNear.dx > 0.95 && hitBack.dx < -0.95);
  assert.ok(hitNear.reach > hitBack.reach);
  assert.ok(near.x > 6 && back.x < -6.5, `near ${near.x}, back ${back.x}`);
  assert.equal(far.launches, 0);
});

test("a pop shot flies down the board and stops at its range", () => {
  const { field, target } = duel("popper", 12);
  const beyond = place(field, "p3", 0, PUCK_RANGE + 6, 0);
  const events = [...tap(field, "p1", ATTACK), ...run(field, 1.2)];
  const [hit] = hitsOn(events, "p2");
  assert.ok(hit);
  assert.equal(hit.how, "shot");
  assert.equal(hit.by, "p1");
  assert.ok(hit.dx > 0.95);
  assert.ok(Math.abs(target.x - 12 - KINDS.popper.throw * KINDS.popper.power) < 0.7);
  assert.equal(field.shots.length, 0);
  const popper = field.cars.get("p1");
  assert.ok(popper);
  Object.assign(popper, { a: Math.PI / 2, cooldown: 0 });
  const second = [...tap(field, "p1", ATTACK), ...run(field, 1.2)];
  assert.equal(beyond.launches, 0);
  assert.ok(second.some((event) => event.kind === "pop" && !event.burst));
});

test("a scoop tosses the car in front over its own roof", () => {
  const { field, striker, target } = duel("scoop");
  const events = [...tap(field, "p1", ATTACK), ...run(field, 0.3)];
  assert.ok(target.y > 1.5, `tossed high, got ${target.y}`);
  events.push(...run(field, 1.8));
  const [hit] = hitsOn(events, "p2");
  assert.ok(hit);
  assert.equal(hit.how, "scoop");
  assert.ok(hit.dx < -0.95);
  assert.ok(target.x < striker.x - 3, `lands behind, at ${target.x}`);
});

test("a whirl bats away everything close, round and outwards", () => {
  const field = makeField(OPEN);
  place(field, "p1", 0, 0, 0, "twister");
  const east = place(field, "p2", 2.8, 0, 0);
  const north = place(field, "p3", 0, -2.8, 0);
  const far = place(field, "p4", 6, 0, 0);
  const events = [...tap(field, "p1", ATTACK), ...run(field, 1.4)];
  const [hit] = hitsOn(events, "p2");
  assert.ok(hit);
  assert.equal(hit.how, "spin");
  assert.ok(hit.dx > 0.6 && Math.abs(hit.dz) > 0.3, "out and round");
  assert.equal(east.launches, 1);
  assert.equal(north.launches, 1);
  assert.equal(far.launches, 0);
});

test("a damaged car flies further, and a heavy one less far", () => {
  assert.equal(launchOf(5, 0, 1), 5);
  assert.ok(Math.abs(launchOf(5, 100, 1) - 5 * (1 + 100 * DAMAGE_GAIN)) < 1e-9);
  assert.ok(launchOf(5, 100, 1) > 10, "twice as far at 100");
  const fresh = duel();
  tap(fresh.field, "p1", ATTACK);
  run(fresh.field, 2);
  const hurt = duel();
  hurt.target.damage = 100;
  tap(hurt.field, "p1", ATTACK);
  run(hurt.field, 2);
  const ratio = (hurt.target.x - 3) / (fresh.target.x - 3);
  assert.ok(Math.abs(ratio - (1 + 100 * DAMAGE_GAIN)) < 0.15, `ratio ${ratio}`);
  const reach: number[] = [];

  for (const kind of ["dart", "bumper", "brick"] as const) {
    const field = makeField(OPEN);
    place(field, "p1", 0, 0, 0);
    const target = place(field, "p2", 3, 0, 0, kind);
    tap(field, "p1", ATTACK);
    run(field, 2);
    reach.push(target.x - 3);
    assert.ok(Math.abs(target.x - 3 - KINDS.bumper.throw / KINDS[kind].weight) < 0.6, kind);
  }

  assert.ok((reach[0] ?? 0) > (reach[1] ?? 0) && (reach[1] ?? 0) > (reach[2] ?? 0));
});

test("damage adds up blow by blow, stops at its cap and is gone after a fall", () => {
  const field = makeField(OPEN);
  const car = place(field, "p1", 0, 0, 0);
  deliver(field, car, { ...punchFrom("p8", 0.5), id: "a" });
  run(field, 0.6);
  deliver(field, car, { ...punchFrom("p9", 0.5), id: "b" });
  assert.equal(car.damage, 28);
  run(field, 0.6);
  car.damage = DAMAGE_MAX - 5;
  deliver(field, car, { ...punchFrom("p8", 0.5), id: "c" });
  assert.equal(car.damage, DAMAGE_MAX);
  Object.assign(car, { x: OPEN.halfX + 3 });
  run(field, RESPAWN_SECONDS + 2.5);
  assert.equal(car.falls, 1);
  assert.equal(car.mode, "drive");
  assert.equal(car.damage, 0);
});

test("an attack that lands is ready sooner than one that hits nothing", () => {
  const { field, striker } = duel();
  tap(field, "p1", ATTACK);
  run(field, 0.5);
  assert.equal(striker.cooldownOf, KINDS.bumper.cooldown);
  run(field, 0.5, { p1: ATTACK });
  assert.equal(striker.attacks, 1, "not while it cools");
  run(field, KINDS.bumper.cooldown);
  tap(field, "p1", ATTACK);
  run(field, 0.3);
  assert.equal(striker.attacks, 2);
  const alone = makeField(OPEN);
  const lone = place(alone, "p1", 0, 0, 0);
  const events = [...tap(alone, "p1", ATTACK), ...run(alone, 0.5)];
  assert.equal(lone.cooldownOf, KINDS.bumper.whiff);
  assert.ok(events.some((event) => event.kind === "whiff"));
  assert.ok(lone.cooldown > KINDS.bumper.cooldown);
});

test("two bumpers that meet head on bounce off, and nobody is thrown", () => {
  const field = makeField(OPEN);
  const left = place(field, "p1", 0, 0, 0);
  const right = place(field, "p2", 3.2, 0, Math.PI);
  const events = run(field, 0.4, { p1: ATTACK, p2: ATTACK });
  assert.equal(events.filter((event) => event.kind === "clash").length, 1);
  assert.equal(left.launches + right.launches, 0);
  assert.equal(left.damage + right.damage, 0);
  run(field, 0.6);
  assert.ok(left.x < -1 && right.x > 4.2, "both thrown back");
});

test("a car holds one special, and a cube it cannot take is still gone", () => {
  const { car, field } = armed("rocket");
  const [pad] = OPEN.def.pads;
  assert.ok(pad);
  Object.assign(car, { x: pad[0], z: pad[1] });
  field.time = CUBES_AT + CUBE_EVERY;
  const events = run(field, 0.3);
  assert.equal(
    events.some((event) => event.kind === "reach"),
    false,
    "a full car is not offered a cube",
  );
  grant(field, "p1", 0, "mine");
  assert.equal(car.special, "rocket");
  assert.ok(field.taken.has(0));
  car.stagger = 1;
  tap(field, "p1", SPECIAL);
  assert.equal(car.special, "rocket", "not while it is being thrown");
  car.stagger = 0;
  const used = tap(field, "p1", SPECIAL);
  assert.equal(car.special, "");
  assert.equal(car.uses, 1);
  assert.equal(car.usedKind, "rocket");
  assert.ok(used.some((event) => event.kind === "use" && event.special === "rocket"));
});

test("a rocket bursts on the first car down its line and splashes the one beside it", () => {
  const { field, target } = armed("rocket", [20, 0]);
  const beside = place(field, "p3", 20, 2.8, 0);
  const events = [...tap(field, "p1", SPECIAL), ...run(field, 1.6)];
  const [direct] = hitsOn(events, "p2");
  const [splash] = hitsOn(events, "p3");
  assert.ok(direct && splash);
  assert.equal(direct.how, "rocket");
  assert.equal(direct.by, "p1");
  assert.equal(direct.reach, ROCKET_THROW);
  assert.ok(splash.reach < direct.reach && splash.dz > 0.5);
  assert.ok(target.x > 25);
  assert.ok(beside.z > 4);
  assert.ok(events.some((event) => event.kind === "pop" && event.burst));
  assert.equal(field.shots.length, 0);
});

test("a seeker turns after a car that is not straight ahead", () => {
  const { field, target } = armed("seeker", [10, 12]);
  const events = [...tap(field, "p1", SPECIAL)];
  const [shot] = field.shots;
  assert.ok(shot);
  assert.equal(shot.target, "p2");
  events.push(...run(field, 3));
  const [hit] = hitsOn(events, "p2");
  assert.ok(hit, "it got there");
  assert.equal(hit.how, "seeker");
  assert.equal(target.launches, 1);
});

test("a mine waits behind the car, arms, and goes off under the next one", () => {
  const { car, field, target } = armed("mine", [-3.4, 0.3]);
  tap(field, "p1", SPECIAL);
  const [mine] = field.shots;
  assert.ok(mine && mine.x < -2.5, "dropped behind");
  assert.equal(hitsOn(run(field, 0.5), "p2").length, 0, "not armed yet");
  const [hit] = hitsOn(run(field, 0.5), "p2");
  assert.ok(hit);
  assert.equal(hit.how, "mine");
  assert.equal(hit.by, "p1");
  assert.equal(car.launches, 0, "never its owner");
  assert.equal(target.launches, 1);
  assert.equal(field.shots.length, 0);
});

test("oil takes the wheel away from whoever crosses it, and the slick is its owner's", () => {
  const { field } = armed("oil", [30, 0]);
  tap(field, "p1", SPECIAL);
  const [slick] = field.shots;
  assert.ok(slick);
  const victim = place(field, "p3", slick.x - 6, slick.z, 0);
  const events = run(field, 0.7, { p3: AHEAD });
  assert.ok(events.some((event) => event.kind === "slip" && event.key === "p3"));
  assert.ok(victim.slip > 0);
  assert.equal(victim.damage, OIL_DAMAGE);
  assert.equal(victim.lastBy, "p1");
  const heading = victim.a;
  run(field, 0.2, { p3: { ...AHEAD, steer: 1 } });
  assert.equal(victim.a, heading, "no steering on oil");
  run(field, 2, { p3: AHEAD });
  assert.equal(victim.slip, 0);
  const owner = field.cars.get("p1");
  assert.ok(owner);
  Object.assign(owner, { x: slick.x, z: slick.z });
  run(field, 0.3);
  assert.equal(owner.slip, 0, "never its owner");
  assert.equal(owner.damage, 0);
});

test("a shock throws everyone in reach outwards", () => {
  const { field, target } = armed("shock", [5, 0]);
  const north = place(field, "p3", 0, -6, 0);
  const far = place(field, "p4", 12, 0, 0);
  const events = [...tap(field, "p1", SPECIAL), ...run(field, 1.5)];
  const [hit] = hitsOn(events, "p2");
  assert.ok(hit);
  assert.equal(hit.how, "shock");
  assert.ok(target.x > 8 && north.z < -8.5);
  assert.equal(far.launches, 0);
});

test("a magnet yanks cars to the nose without sending them flying", () => {
  const { car, field, target } = armed("magnet", [7, 3]);
  target.damage = 150;
  tap(field, "p1", SPECIAL);
  run(field, 1.5);
  assert.equal(target.hitHow, "magnet");
  assert.ok(
    Math.hypot(target.x - MAGNET_STOP, target.z) < 1.2,
    `pulled to ${target.x}, ${target.z}`,
  );
  assert.equal(car.launches, 0);
  const again = armed("magnet", [7, 0]);
  tap(again.field, "p1", SPECIAL);
  const events = [...tap(again.field, "p1", ATTACK), ...run(again.field, MAGNET_LOCK - 0.1)];
  assert.equal(again.car.attacks, 1);
  assert.deepEqual(hitsOn(events, "p2"), [], "the pull is not a free punch");
});

test("a special pressed a moment too early still goes off", () => {
  const { car, field } = armed("shock", [30, 0]);
  car.stagger = STAGGER_EASE + SPECIAL_BUFFER - 0.1;
  assert.deepEqual(tap(field, "p1", SPECIAL), []);
  assert.equal(car.special, "shock");
  const events = run(field, SPECIAL_BUFFER);
  assert.ok(events.some((event) => event.kind === "use" && event.special === "shock"));
  const late = armed("shock", [30, 0]);
  late.car.stagger = STAGGER_EASE + SPECIAL_BUFFER + 0.2;
  tap(late.field, "p1", SPECIAL);
  run(late.field, 1);
  assert.equal(late.car.special, "shock", "a press too far ahead is forgotten");
});

test("a puck the clock carries past a car still hits it", () => {
  const { field, target } = duel("popper", 9);
  tap(field, "p1", ATTACK);

  for (let i = 0; i < 30 && field.shots.length === 0; i += 1) {
    run(field, STEP);
  }

  assert.equal(field.shots.length, 1);
  field.time += 0.3;
  const [hit] = hitsOn(run(field, STEP), "p2");
  assert.ok(hit, "swept along the way it came");
  assert.equal(hit.how, "shot");
  assert.ok(hit.dx > 0.9);
  assert.equal(target.launches, 1);
});

test("a zap stalls everyone in reach where they stand", () => {
  const { field, target } = armed("zap", [6, 0]);
  tap(field, "p1", SPECIAL);
  assert.ok(target.stagger >= ZAP_STUN - STEP);
  assert.equal(target.damage, ZAP_DAMAGE);
  const from = target.x;
  run(field, ZAP_STUN - 0.25, { p2: AHEAD });
  assert.ok(Math.abs(target.x - from) < 0.3, "it goes nowhere");
  run(field, 1.2, { p2: AHEAD });
  assert.ok(target.x > from + 4, "then drives off");
});

test("a shield takes one blow and is gone", () => {
  const { car, field } = armed("shield", [-3, 0]);
  tap(field, "p1", SPECIAL);
  assert.equal(car.mod, "shield");
  const blocked = [...tap(field, "p2", ATTACK), ...run(field, 0.5)];
  assert.ok(blocked.some((event) => event.kind === "block" && event.key === "p1"));
  assert.equal(car.launches, 0);
  assert.equal(car.damage, 0);
  assert.equal(car.mod, "");
  const striker = field.cars.get("p2");
  assert.ok(striker);
  assert.equal(striker.cooldownOf, KINDS.bumper.whiff, "a blocked punch is a miss");
  run(field, KINDS.bumper.whiff);
  tap(field, "p2", ATTACK);
  run(field, 0.5);
  assert.equal(car.launches, 1);
});

test("a giant is bigger and far harder to throw, for a while", () => {
  const { car, field } = armed("giant", [30, 0]);
  tap(field, "p1", SPECIAL);
  assert.equal(car.mod, "giant");
  assert.ok(Math.abs(carRadius(car) / carRadius(makeCar("x", false)) - GIANT_RADIUS) < 1e-9);
  assert.ok(Math.abs(carWeight(car) - GIANT_WEIGHT) < 1e-9);
  run(field, MOD_SECONDS.giant + 0.1);
  assert.equal(car.mod, "");
});

test("turbo is a free boost for as long as it lasts", () => {
  const { car, field } = armed("turbo", [0, 30]);
  Object.assign(car, { meter: 0, x: -45 });
  tap(field, "p1", SPECIAL);
  run(field, 1, { p1: AHEAD });
  assert.ok(Math.hypot(car.vx, car.vz) > BOOST_SPEED, `turbo speed ${car.vx}`);
  run(field, MOD_SECONDS.turbo, { p1: { ...AHEAD, steer: 1 } });
  assert.equal(car.mod, "");
});

test("a wrench mends all the damage", () => {
  const { car, field } = armed("wrench");
  car.damage = 137;
  tap(field, "p1", SPECIAL);
  assert.equal(car.damage, 0);
});

test("a spring hops the car clear, and it stomps where it lands", () => {
  const { car, field, target } = armed("spring", [3.5, 0]);
  tap(field, "p1", SPECIAL);
  let top = 0;

  for (let t = 0; t < 0.4; t += STEP) {
    run(field, STEP);
    top = Math.max(top, car.y);
  }

  assert.ok(Math.abs(top - SPRING_HEIGHT) < 0.3, `peak ${top}`);
  const striker = place(field, "p3", -3, 0, 0);
  tap(field, "p3", ATTACK);
  run(field, 0.2);
  assert.equal(striker.attacks, 1);
  assert.equal(car.launches, 0, "a punch passes under it");
  const events = run(field, 0.8);
  const [hit] = hitsOn(events, "p2");
  assert.ok(hit);
  assert.equal(hit.how, "stomp");
  assert.ok(hit.dx > 0.9);
  assert.equal(target.launches, 1);
  assert.equal(car.y, 0);
});

test("a boosted car rams; a car at its own speed only shoves", () => {
  const field = makeField(OPEN);
  place(field, "p1", -14, 0, 0);
  const target = place(field, "p2", 0, 0, 0);
  const events = run(field, 1, { p1: { ...AHEAD, boost: true } });
  const [hit] = hitsOn(events, "p2");
  assert.ok(hit);
  assert.equal(hit.how, "ram");
  assert.equal(hit.reach, RAM_THROW);
  assert.equal(target.lastBy, "p1");
  const slow = makeField(OPEN);
  place(slow, "p1", -14, 0, 0);
  const other = place(slow, "p2", 0, 0, 0);
  const none = run(slow, 1.2, { p1: AHEAD });
  assert.equal(hitsOn(none, "p2").length, 0);
  assert.ok(other.x > 0.5, "pushed along all the same");
});

test("two cars on one spot come apart", () => {
  const field = makeField(OPEN);
  const one = place(field, "p1", 4, 4, 0);
  const two = place(field, "p2", 4, 4, 0);
  run(field, 0.2);
  assert.ok(Math.hypot(one.x - two.x, one.z - two.z) > carRadius(one) * 1.9);
});

test("a car held in a hit-stop stands still but can still be hit", () => {
  const { field, striker, target } = duel();
  run(field, 0.2, { p2: AHEAD }, "p2");
  assert.equal(target.x, 3);
  tap(field, "p1", ATTACK);
  run(field, 0.3, {}, "p2");
  assert.equal(target.launches, 1);
  assert.equal(striker.attacks, 1);
  assert.equal(target.x, 3);
  run(field, 1);
  assert.ok(target.x > 6);
});

test("a car thrown off the edge is its thrower's point, and comes back untouchable", () => {
  const field = makeField(OPEN);
  const edge = OPEN.halfX;
  place(field, "p1", edge - 5.5, 0, 0);
  const target = place(field, "p2", edge - 2.5, 0, 0);
  target.damage = 60;
  const events = [...tap(field, "p1", ATTACK), ...run(field, 1.4)];
  assert.ok(events.some((event) => event.kind === "fall" && event.key === "p2"));
  const out = events.find((event) => event.kind === "out");
  assert.ok(out && out.kind === "out");
  assert.equal(out.by, "p1");
  assert.equal(target.outBy, "p1");
  assert.equal(target.falls, 1);
  run(field, RESPAWN_SECONDS);
  assert.equal(target.mode, "drop");
  run(field, 1);
  assert.equal(target.mode, "drive");
  assert.ok(target.safe > 0 && target.safe <= SAFE_SECONDS);
  assert.ok(OPEN.def.spawns.some((spot) => Math.hypot(spot.x - target.x, spot.z - target.z) < 0.1));
  assert.equal(deliver(field, target, { ...punchFrom("p1"), id: "late" }), false);
  run(field, SAFE_SECONDS);
  assert.equal(deliver(field, target, { ...punchFrom("p1"), id: "later" }), true);
});

test("a car that drives off alone is nobody's point, and a hit stops counting", () => {
  const field = makeField(OPEN);
  const car = place(field, "p1", OPEN.halfX - 4, 0, 0);
  const events = run(field, 2, { p1: AHEAD });
  const out = events.find((event) => event.kind === "out");
  assert.ok(out && out.kind === "out");
  assert.equal(out.by, "");
  const later = makeField(OPEN);
  const hit = place(later, "p1", 0, 0, 0);
  deliver(later, hit, punchFrom("p9", 1));
  assert.equal(hit.lastBy, "p9");
  run(later, CREDIT_SECONDS + 0.1);
  assert.equal(hit.lastBy, "");
  assert.equal(car.falls, 1);
});

test("nothing lands before GO or after the horn", () => {
  for (const time of [-1, ROUND_MS / 1000 + 0.1]) {
    const { field, striker, target } = duel();
    field.time = time;
    striker.special = "shock";
    const events = run(field, 0.5, { p1: { ...ATTACK, gas: 1, special: true } });
    assert.deepEqual(events, []);
    assert.equal(striker.attacks, 0);
    assert.equal(striker.special, "shock");
    assert.equal(target.launches, 0);
    assert.ok(Math.abs(striker.x) < 0.01);
  }
});

test("the sweeper, the pistons and the pop bumpers all throw cars", () => {
  const sweeper = PINBALL.def.hazards.find((hazard) => hazard.kind === "sweeper");
  const piston = PINBALL.def.hazards.find((hazard) => hazard.kind === "piston");
  const bumper = PINBALL.def.hazards.find((hazard) => hazard.kind === "bumper");
  assert.ok(sweeper && piston && bumper);
  const angle = sweeperAngle(sweeper, 3);
  const swept = hazardHit(PINBALL, 3, Math.cos(angle) * 4, Math.sin(angle) * 4, 1.2);
  assert.ok(swept);
  assert.equal(swept.how, "sweeper");
  assert.equal(swept.by, "");
  assert.equal(
    hazardHit(PINBALL, 3, Math.cos(angle + 1.5) * 4, Math.sin(angle + 1.5) * 4, 1.2),
    null,
  );
  const fires = piston.period - piston.phase;
  assert.ok(pistonAt(piston, fires - PISTON_WARN / 2).warn > 0.4);
  assert.equal(pistonAt(piston, fires + 0.05).firing, true);
  const laneX = piston.x + Math.cos(piston.a) * 3;
  const laneZ = piston.z + Math.sin(piston.a) * 3;
  assert.equal(hazardHit(PINBALL, fires - 0.5, laneX, laneZ, 1.2), null);
  const shot = hazardHit(PINBALL, fires + 0.1, laneX, laneZ, 1.2);
  assert.ok(shot);
  assert.equal(shot.how, "piston");
  assert.ok(shot.dx * Math.cos(piston.a) + shot.dz * Math.sin(piston.a) > 0.8);
  assert.equal(hazardHit(PINBALL, fires + 0.4, laneX, laneZ, 1.2), null);
  assert.equal(hazardHit(PINBALL, fires + 0.4, laneX, laneZ, 1.2, false, 0.35)?.how, "piston");
  const jumped = makeField(PINBALL);
  jumped.time = fires - 0.05;
  const stood = place(jumped, "p1", laneX, laneZ, 0);
  run(jumped, STEP);
  jumped.time = fires + 0.3;
  assert.equal(hitsOn(run(jumped, STEP), "p1")[0]?.how, "piston", "a jump of the clock");
  assert.equal(stood.launches, 1);
  const popped = hazardHit(PINBALL, 5, bumper.x + bumper.r + 1, bumper.z, 1.2);
  assert.ok(popped);
  assert.equal(popped.how, "bumper");
  assert.ok(popped.dx > 0.9);
  const field = makeField(PINBALL);
  const ahead = sweeperAngle(sweeper, 0) + 0.5 * Math.sign(sweeper.rate);
  const car = place(field, "p1", Math.cos(ahead) * 4, Math.sin(ahead) * 4, 0);
  const events = run(field, 1.5);
  assert.equal(hitsOn(events, "p1")[0]?.how, "sweeper");
  assert.equal(car.launches, 1);
  assert.ok(car.damage > 0);
});

test("the rim blinks, then drops, and takes its cars, toys and pads with it", () => {
  const start = ROUND_MS - SHRINK_MS;
  assert.deepEqual(shrinkAt(start - 100), { drop: 0, late: false, warn: false });
  assert.equal(shrinkAt(start + 100).warn, true);
  assert.equal(shrinkAt(start + 100).late, false);
  const gone = shrinkAt(start + SHRINK_WARN_MS + 500);
  assert.ok(gone.late && !gone.warn && gone.drop > 0);
  const end = PINBALL.halfX - 3;
  assert.ok(onBoard(PINBALL, end, 12));
  assert.ok(!onBoard(PINBALL, end, 12, true));
  const field = makeField(PINBALL);
  field.time = (start + SHRINK_WARN_MS) / 1000 - 0.2;
  const car = place(field, "p1", end, 12, 0);
  const events = run(field, 1.5);
  assert.ok(events.some((event) => event.kind === "out" && event.by === ""));
  assert.equal(car.falls, 1);
  const rimToys = PINBALL.def.hazards.filter((hazard) => hazardGone(PINBALL, hazard, true));
  assert.ok(rimToys.length >= 4, "the pistons go with the rim");
  assert.ok(rimToys.every((hazard) => !hazardGone(PINBALL, hazard, false)));
  const sweeper = PINBALL.def.hazards.find((hazard) => hazard.kind === "sweeper");
  assert.ok(sweeper && !hazardGone(PINBALL, sweeper, true));
  const before = cubesAt(PINBALL, 30, false);
  const after = cubesAt(PINBALL, 30, true);
  assert.equal(before.length, PINBALL.def.pads.length);
  assert.ok(after.length >= 6 && after.length < before.length);
  assert.ok(after.every((cube) => onBoard(PINBALL, cube.x, cube.z, true)));
});

test("a mine or a slick left on the rim goes with it", () => {
  const drops = (ROUND_MS - SHRINK_MS + SHRINK_WARN_MS) / 1000;

  for (const kind of ["mine", "oil"] as const) {
    const field = makeField(PINBALL);
    field.time = drops - 1;
    const car = place(field, "p1", PINBALL.halfX - 3, 12, Math.PI / 2);
    car.special = kind;
    tap(field, "p1", SPECIAL);
    const [laid] = field.shots;
    assert.ok(laid && onBoard(PINBALL, laid.x, laid.z));
    assert.ok(!onBoard(PINBALL, laid.x, laid.z, true), "on the rim");
    const events = run(field, 1.2);
    assert.ok(
      events.some((event) => event.kind === "pop" && !event.burst),
      `${kind} is gone`,
    );
    assert.equal(field.shots.length, 0);
  }
});

test("every start has a clear road: a car that only holds the pedal is not hit or dropped", () => {
  for (const spot of PINBALL.def.grid) {
    const field = makeField(PINBALL);
    const car = place(field, "p1", spot.x, spot.z, spot.a);
    const events = run(field, 2.4, { p1: AHEAD });
    assert.deepEqual(hitsOn(events, "p1"), [], `from ${spot.x}, ${spot.z}`);
    assert.equal(car.falls, 0);
    assert.equal(car.mode, "drive");
  }
});

test("cubes come on a clock every client can work out, one a pad", () => {
  const onPad = (time: number) => cubesAt(PINBALL, time, false).find((cube) => cube.id < 100);
  assert.equal(onPad(CUBES_AT - CUBE_BEAM - 0.1), undefined);
  const firstCube = onPad(CUBES_AT - CUBE_BEAM + 0.1);
  assert.ok(firstCube);
  assert.equal(firstCube.id, 0);
  assert.equal(firstCube.landAt, CUBES_AT);
  assert.deepEqual(onPad(CUBES_AT + 1), firstCube);
  assert.equal(onPad(CUBES_AT + CUBE_EVERY)?.id, 1);
  assert.deepEqual(cubesAt(PINBALL, ROUND_MS / 1000 + 1, false), []);
  const all = cubesAt(PINBALL, 40, false);
  assert.equal(new Set(all.map((cube) => cube.id)).size, all.length);
  const lands = new Set(all.map((cube) => Math.round((cube.landAt % CUBE_EVERY) * 10)));
  assert.ok(lands.size > PINBALL.def.pads.length / 2, "the pads do not all land together");
});

test("a car that reaches a landed cube is offered it, and takes it once granted", () => {
  const field = makeField(PINBALL);
  const [pad] = PINBALL.def.pads;
  assert.ok(pad);
  field.time = CUBES_AT - 0.5;
  const car = place(field, "p1", pad[0], pad[1], 0);
  assert.deepEqual(run(field, 0.3), []);
  const events = run(field, 0.4);
  const reach = events.find((event) => event.kind === "reach");
  assert.ok(reach && reach.kind === "reach");
  assert.equal(reach.cube, 0);
  grant(field, "p1", reach.cube, "spring");
  assert.equal(car.special, "spring");
  assert.deepEqual(run(field, 0.3), []);
  car.x = pad[0] + 8;
  place(field, "p2", pad[0], pad[1], 0);
  assert.equal(
    run(field, 0.3).some((event) => event.kind === "reach"),
    false,
    "a taken cube is gone",
  );
});

test("what a cube holds is the same everywhere, and kinder to the back of the field", () => {
  const seen = new Set<SpecialKind>();
  let frontHeavy = 0;
  let backHeavy = 0;

  for (let round = 1; round <= 40; round += 1) {
    for (let cube = 0; cube < 60; cube += 1) {
      const front = specialFor(round, cube, 1, 8);
      const back = specialFor(round, cube, 8, 8);
      assert.equal(front, specialFor(round, cube, 1, 8));
      seen.add(front);
      frontHeavy += front === "seeker" || front === "zap" || front === "giant" ? 1 : 0;
      backHeavy += back === "seeker" || back === "zap" || back === "giant" ? 1 : 0;
    }
  }

  assert.equal(seen.size, SPECIALS.length);
  assert.ok(backHeavy > frontHeavy * 1.5, `${backHeavy} against ${frontHeavy}`);
});

test("a full round of bots is a fight: every attack and special is used, and nobody breaks", () => {
  const attacks = new Set<string>();
  const specials = new Set<string>();

  for (const round of [1, 2, 4000]) {
    const log = playMatch(round);

    const count = (kind: FieldEvent["kind"]) =>
      log.events.filter((event) => event.kind === kind).length;

    const falls = log.outs.length;
    const byCar = log.outs.filter((out) => out.by !== "").length;
    assert.ok(count("attack") > 60, `attacks: ${count("attack")}`);
    assert.ok(falls >= 16 && falls <= 60, `falls: ${falls}`);
    assert.ok(byCar > falls * 0.7, `${byCar} of ${falls} falls were somebody's doing`);
    assert.ok(count("use") >= 20, `specials: ${count("use")}`);
    assert.ok(Math.max(...log.scores.values()) >= 4);

    for (const event of log.events) {
      if (event.kind === "hit") {
        assert.ok(Number.isFinite(event.x + event.z + event.reach));
        attacks.add(event.hit.how);
      } else if (event.kind === "use") {
        specials.add(event.special);
      }
    }
  }

  for (const kind of CAR_KINDS) {
    assert.ok(attacks.has(KINDS[kind].attack), `${kind} landed its attack`);
  }

  assert.equal(specials.size, SPECIALS.length);
});

test("no car is a must-pick: over a dozen bot rounds every kind scores in one band", () => {
  const score = new Map<CarKind, number>();
  const seats = new Map<CarKind, number>();

  for (let round = 1; round <= 12; round += 1) {
    const log = playMatch(round);

    for (const [key, kind] of log.kinds) {
      score.set(kind, (score.get(kind) ?? 0) + (log.scores.get(key) ?? 0));
      seats.set(kind, (seats.get(kind) ?? 0) + 1);
    }
  }

  const each = CAR_KINDS.map((kind) => (score.get(kind) ?? 0) / (seats.get(kind) ?? 1));
  const mean = each.reduce((sum, value) => sum + value, 0) / each.length;

  for (const [index, value] of each.entries()) {
    assert.ok(
      value > mean * 0.6 && value < mean * 1.4,
      `${CAR_KINDS[index]} scores ${value.toFixed(2)} against a mean of ${mean.toFixed(2)}`,
    );
  }
});
