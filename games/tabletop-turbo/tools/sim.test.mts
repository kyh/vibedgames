import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOOST_SECONDS,
  BOOST_SPEED,
  CRATE_BEAM,
  CRATE_EVERY,
  CREDIT_SECONDS,
  DENT_GAIN,
  DENT_HEAL,
  ITEMS_AT,
  ITEM_PUNCHES,
  ITEM_SECONDS,
  MAX_SPEED,
  MEGA_FORCE,
  PISTON_WARN,
  PUNCH_COOLDOWN,
  PUNCH_REACH,
  PUNCH_THROW,
  PUNCH_WHIFF_COOLDOWN,
  RAM_MIN,
  RESPAWN_SECONDS,
  ROUND_MS,
  SAFE_SECONDS,
  SHRINK_MS,
  SHRINK_WARN_MS,
  SPRING_FORCE,
  SPRING_REACH,
  STEP,
} from "../src/shared/constants.ts";
import { ARENAS, arenaFor, buildArena, edgeDistance, onBoard } from "../src/sim/arena.ts";
import { makeBrain } from "../src/sim/bot.ts";
import { carRadius, giveItem, gridCar, heldItem, makeCar, punchReady } from "../src/sim/car.ts";
import type { Car, CarInput, Hit } from "../src/sim/car.ts";
import { deliver, grant, makeField, stepField } from "../src/sim/field.ts";
import type { Field, FieldEvent } from "../src/sim/field.ts";
import { hazardHit, pistonAt, shrinkAt, sweeperAngle } from "../src/sim/hazards.ts";
import { crateAt, crateOf } from "../src/sim/items.ts";
import { playMatch } from "./match.mts";

const [first] = ARENAS;

assert.ok(first);

const OPEN = buildArena({ ...first, hazards: [], holes: [] });
const PINBALL = arenaFor(0);
const EAST: CarInput = { boost: false, mx: 1, mz: 0, punch: false };
const IDLE: CarInput = { boost: false, mx: 0, mz: 0, punch: false };
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

const duel = (gap = 3) => {
  const field = makeField(OPEN);
  const striker = place(field, "p1", 0, 0, 0);
  const target = place(field, "p2", gap, 0, 0);

  return { field, striker, target };
};

const thrown = (field: Field, striker: Car, target: Car) => {
  const from = target.x;
  striker.cooldown = 0;
  run(field, STEP * 2, { p1: PUNCH });
  run(field, 1.6);

  return target.x - from;
};

const punchFrom = (by: string) =>
  ({ by, dx: 1, dz: 0, how: "punch", id: `${by}:0:1`, reach: PUNCH_THROW }) satisfies Hit;

test("the board holds every start, drop and crate, and the drops survive the shrink", () => {
  for (const def of ARENAS) {
    const arena = buildArena(def);

    for (const spot of def.grid) {
      assert.ok(edgeDistance(arena, spot.x, spot.z) > 2, `${def.id} grid on the board`);
    }

    for (const spot of def.spawns) {
      assert.ok(edgeDistance(arena, spot.x, spot.z, true) > 2, `${def.id} drop on the core`);
    }

    for (const [x, z] of [...def.knockerPads, ...def.carPads]) {
      assert.ok(edgeDistance(arena, x, z) > 2, `${def.id} pad on the board`);
    }

    for (const [x, z] of def.carPads) {
      assert.ok(edgeDistance(arena, x, z, true) > 2, `${def.id} late pad on the core`);
    }

    for (const [x, z] of def.knockerPads) {
      assert.ok(!onBoard(arena, x, z, true), `${def.id} end pad drops with its end`);
    }

    assert.ok(def.grid.length >= 8);
  }
});

test("a car gets to top speed, holds it, and stops when the stick lets go", () => {
  const field = makeField(OPEN);
  const car = place(field, "p1", -10, 0, 0);
  run(field, 1, { p1: EAST });
  const speed = Math.hypot(car.vx, car.vz);
  assert.ok(speed > MAX_SPEED * 0.97 && speed <= MAX_SPEED + 0.01, `top speed, got ${speed}`);
  const from = car.x;
  run(field, 1, { p1: IDLE });
  assert.ok(Math.hypot(car.vx, car.vz) < 0.2, "stopped");
  assert.ok(car.x - from < 4, `short stop, rolled ${car.x - from}`);
});

test("the stick points the car: it turns to face where it is pushed", () => {
  const field = makeField(OPEN);
  const car = place(field, "p1", 0, 0, 0);
  run(field, 0.8, { p1: { boost: false, mx: 0, mz: 1, punch: false } });
  assert.ok(Math.abs(car.a - Math.PI / 2) < 0.05, `faces south, got ${car.a}`);
  assert.ok(car.vz > MAX_SPEED * 0.8);
});

test("boost is faster, runs dry in a second, and comes back", () => {
  const field = makeField(OPEN);
  const car = place(field, "p1", -20, 0, 0);
  const boost = { ...EAST, boost: true };
  run(field, 0.6, { p1: boost });
  assert.ok(Math.hypot(car.vx, car.vz) > BOOST_SPEED * 0.95);
  run(field, BOOST_SECONDS, { p1: boost });
  assert.equal(car.boosting, false);
  assert.ok(car.meter < 0.05);
  run(field, 7, { p1: IDLE });
  assert.equal(car.meter, 1);
});

test("a punch throws the car in front about the same distance every time", () => {
  const { field, striker, target } = duel();
  const events = run(field, STEP * 2, { p1: PUNCH });
  run(field, 0.2);
  assert.ok(target.launches === 1 && target.lastBy === "p1");
  assert.equal(striker.punches, 1);
  events.push(...run(field, 1.4));
  const distance = target.x - 3;
  assert.ok(
    Math.abs(distance - PUNCH_THROW) < PUNCH_THROW * 0.2,
    `thrown ${distance}, wanted about ${PUNCH_THROW}`,
  );
  assert.ok(Math.hypot(target.vx, target.vz) < 0.5, "at rest again");
});

test("each punch that lands dents the car and the next one throws it further", () => {
  const { field, striker, target } = duel();
  const one = thrown(field, striker, target);
  assert.equal(target.dent, 1);
  striker.x = target.x - 3;
  const two = thrown(field, striker, target);
  assert.equal(target.dent, 2);
  striker.x = target.x - 3;
  const three = thrown(field, striker, target);
  assert.equal(target.dent, 2);
  assert.ok(two > one * 1.2, `second ${two} beats first ${one}`);
  assert.ok(three > two * 1.1, `third ${three} beats second ${two}`);
  assert.ok(Math.abs(three / one - (DENT_GAIN[2] ?? 0)) < 0.25);
  run(field, DENT_HEAL * 2 + 0.5);
  assert.equal(target.dent, 0);
});

test("a punch that lands cools down faster than one that misses", () => {
  const hit = duel();
  run(hit.field, 0.6, { p1: PUNCH });
  const miss = duel(12);
  const events = run(miss.field, 0.6, { p1: PUNCH });
  assert.ok(events.some((event) => event.kind === "whiff"));
  assert.equal(miss.target.launches, 0);
  assert.ok(miss.striker.cooldown > hit.striker.cooldown + 0.5);
  assert.ok(Math.abs(hit.striker.cooldown + 0.6 - PUNCH_COOLDOWN) < 0.1);
  assert.ok(Math.abs(miss.striker.cooldown + 0.6 - PUNCH_WHIFF_COOLDOWN) < 0.1);
  assert.ok(punchReady(miss.striker) < punchReady(hit.striker));
});

test("two bumpers that meet clash: both bounce back and neither is thrown", () => {
  const field = makeField(OPEN);
  const left = place(field, "p1", 0, 0, 0);
  const right = place(field, "p2", 3.2, 0, Math.PI);
  const events = run(field, 0.5, { p1: PUNCH, p2: PUNCH });
  assert.ok(events.some((event) => event.kind === "clash"));
  assert.equal(left.launches + right.launches, 0);
  assert.ok(left.x < 0 && right.x > 3.2, "pushed apart");
});

test("the mega bumper hits harder and the long spring reaches further", () => {
  const plain = duel();
  const base = thrown(plain.field, plain.striker, plain.target);
  const mega = duel();
  giveItem(mega.striker, "mega");
  const far = thrown(mega.field, mega.striker, mega.target);
  assert.ok(Math.abs(far / base - MEGA_FORCE) < 0.2, `mega ${far} against ${base}`);
  const sprung = duel();
  giveItem(sprung.striker, "spring");
  const flung = thrown(sprung.field, sprung.striker, sprung.target);
  assert.ok(Math.abs(flung / base - SPRING_FORCE) < 0.15, `spring ${flung} against ${base}`);
  const gap = 1.3 + PUNCH_REACH * SPRING_REACH;
  const short = duel(gap);
  run(short.field, 0.5, { p1: PUNCH });
  assert.equal(short.target.launches, 0);
  const long = duel(gap);
  giveItem(long.striker, "spring");
  run(long.field, 0.5, { p1: PUNCH });
  assert.equal(long.target.launches, 1);
});

test("a bumper item lasts two punches, a car item a few seconds", () => {
  const { field, striker } = duel(12);
  giveItem(striker, "spring");
  assert.equal(heldItem(striker), "spring");

  for (let i = 0; i < ITEM_PUNCHES; i += 1) {
    assert.equal(striker.bumper, "spring");
    striker.cooldown = 0;
    run(field, 0.8, { p1: PUNCH });
  }

  assert.equal(striker.bumper, "plain");
  giveItem(striker, "giant");
  run(field, ITEM_SECONDS - 0.5);
  assert.equal(striker.mod, "giant");
  run(field, 1);
  assert.equal(striker.mod, "");
});

test("only a boosted car rams, and a ram never eats the punch behind it", () => {
  const slow = duel(8);
  run(slow.field, 1.2, { p1: EAST });
  assert.ok(MAX_SPEED < RAM_MIN && BOOST_SPEED > RAM_MIN);
  assert.equal(slow.target.launches, 0, "top speed only pushes");
  assert.ok(slow.target.x > 8, "pushed along");
  const fast = duel(10);
  const events: FieldEvent[] = [];

  for (let t = 0; t < 1.2 && fast.target.launches === 0; t += STEP) {
    events.push(...run(fast.field, STEP, { p1: { ...EAST, boost: true } }));
  }

  const rammed = events.find((event) => event.kind === "hit");
  assert.ok(rammed && rammed.kind === "hit");
  assert.equal(rammed.hit.how, "ram");
  assert.equal(fast.target.dent, 0, "a ram never dents");
  assert.equal(fast.target.lastBy, "p1");
  assert.equal(
    deliver(fast.field, fast.target, punchFrom("p3")),
    true,
    "a punch lands on a rammed car",
  );
  assert.equal(fast.target.dent, 1);
  assert.equal(
    deliver(fast.field, fast.target, punchFrom("p4")),
    false,
    "but not a second one at once",
  );
});

test("a shield drops when its car drives into another", () => {
  const { field, striker, target } = duel(4);
  striker.safe = SAFE_SECONDS;
  run(field, 0.1, { p1: EAST });
  assert.ok(striker.safe > 0, "still shielded before it touches");
  run(field, 0.6, { p1: EAST });
  assert.equal(striker.safe, 0);
  striker.cooldown = 0;
  Object.assign(target, { a: Math.PI, cooldown: 0 });
  run(field, 0.4, { p2: PUNCH });
  assert.equal(striker.launches, 1, "and it can be hit again");
});

test("two cars on the same spot come apart", () => {
  const field = makeField(OPEN);
  const one = place(field, "p1", 2, 1, 0);
  const two = place(field, "p2", 2, 1, 0);
  run(field, 0.3);
  const gap = Math.hypot(one.x - two.x, one.z - two.z);
  assert.ok(Number.isFinite(gap));
  assert.ok(gap >= carRadius(one) + carRadius(two) - 0.01, `apart by ${gap}`);
});

test("a held car stands still for the step, and can still be hit", () => {
  const field = makeField(OPEN);
  const held = place(field, "p1", 3, 0, 0);
  place(field, "p2", 0, 0, 0);

  const inputs = new Map([
    ["p1", EAST],
    ["p2", PUNCH],
  ]);

  for (let t = 0; t < 0.15; t += STEP) {
    stepField(field, inputs, STEP, "p1");
  }

  assert.equal(held.launches, 1);
  assert.equal(held.x, 3);
  assert.equal(held.vx, 0);
  run(field, 1, { p1: IDLE });
  assert.ok(held.x > 3 + PUNCH_THROW * 0.8, "thrown once it is let go");
});

test("a bot starts thinking at once however old the room is", () => {
  for (const round of [1, 40, 4000]) {
    for (let slot = 0; slot < 8; slot += 1) {
      assert.equal(makeBrain(slot, round).thinkT, makeBrain(slot, 1).thinkT);
      assert.ok(makeBrain(slot, round).thinkT < 0.5);
    }
  }

  assert.notEqual(makeBrain(2, 1).seed, makeBrain(2, 2).seed);
});

test("a car knocked over the edge falls, scores for whoever hit it, and drops back in shielded", () => {
  const field = makeField(OPEN);
  const edge = OPEN.halfX;
  const striker = place(field, "p1", edge - 5, 0, 0);
  const target = place(field, "p2", edge - 2, 0, 0);
  giveItem(target, "mega");
  giveItem(target, "giant");
  const events = run(field, 1.5, { p1: PUNCH });
  const out = events.find((event) => event.kind === "out");
  assert.ok(events.some((event) => event.kind === "fall" && event.key === "p2"));
  assert.deepEqual(out, { by: "p1", key: "p2", kind: "out" });
  assert.equal(target.falls, 1);
  assert.equal(target.mode, "out");
  assert.equal(target.outBy, "p1");
  assert.equal(striker.mode, "drive");
  run(field, RESPAWN_SECONDS + 0.1);
  assert.equal(target.mode, "drop");
  assert.equal(target.lastBy, "");
  assert.equal(target.outBy, "p1", "who knocked it off outlives the fall");
  assert.equal(target.bumper, "mega", "a bumper item is kept through a fall");
  assert.equal(target.mod, "");
  const landing = run(field, 1.2);
  assert.ok(landing.some((event) => event.kind === "land" && event.drop));
  assert.equal(target.mode, "drive");
  assert.ok(target.safe > 0 && target.safe <= SAFE_SECONDS);
  assert.ok(edgeDistance(OPEN, target.x, target.z, true) > 2, "dropped on the core");
  Object.assign(striker, { a: 0, cooldown: 0, x: target.x - 3, z: target.z });
  run(field, 0.4, { p1: PUNCH });
  assert.equal(target.launches, 1, "shielded cars cannot be hit");
});

test("driving off on your own is nobody's point, and credit for a hit runs out", () => {
  const field = makeField(OPEN);
  const striker = place(field, "p1", 0, 0, 0);
  const target = place(field, "p2", 3, 0, 0);
  run(field, 0.4, { p1: PUNCH });
  assert.equal(target.lastBy, "p1");
  striker.x = -15;
  run(field, CREDIT_SECONDS + 0.2);
  assert.equal(target.lastBy, "");
  const events = run(field, 4, { p2: EAST });
  assert.deepEqual(
    events.find((event) => event.kind === "out"),
    { by: "", key: "p2", kind: "out" },
  );
});

test("nothing is hit before GO or after the horn", () => {
  const before = duel();
  before.field.time = -2;
  run(before.field, 1, { p1: PUNCH });
  assert.equal(before.striker.punches, 0);
  const after = duel();
  after.field.time = ROUND_MS / 1000 + 0.1;
  run(after.field, 1, { p1: PUNCH });
  assert.equal(after.target.launches, 0);
});

test("the sweeper bats cars the way its arm is turning", () => {
  const sweeper = PINBALL.def.hazards.find((hazard) => hazard.kind === "sweeper");
  assert.ok(sweeper);
  const time = 3;
  const angle = sweeperAngle(sweeper, time);
  const reach = sweeper.length * 0.7;
  const ahead = angle + 0.12 * Math.sign(sweeper.rate);
  const x = sweeper.x + Math.cos(ahead) * reach;
  const z = sweeper.z + Math.sin(ahead) * reach;
  const hit = hazardHit(PINBALL, time, x, z, 1.2);
  assert.ok(hit);
  assert.equal(hit.how, "sweeper");
  assert.equal(hit.by, "");
  const spin = Math.sign(sweeper.rate);
  const along = -Math.sin(angle) * spin * hit.dx + Math.cos(angle) * spin * hit.dz;
  assert.ok(along > 0.5, `thrown with the arm, got ${along}`);
  const clear = angle + Math.PI / 2;

  const far = hazardHit(
    PINBALL,
    time,
    sweeper.x + Math.cos(clear) * reach,
    sweeper.z + Math.sin(clear) * reach,
    1.2,
  );

  assert.equal(far, null);
});

test("a piston warns before it fires and hits only while it shoots", () => {
  const piston = PINBALL.def.hazards.find((hazard) => hazard.kind === "piston");
  assert.ok(piston);
  const fireAt = piston.period - piston.phase;
  const before = pistonAt(piston, fireAt - PISTON_WARN / 2);
  assert.ok(!before.firing && before.warn > 0.3 && before.out === 0);
  assert.equal(pistonAt(piston, fireAt - PISTON_WARN - 0.5).warn, 0);
  const during = pistonAt(piston, fireAt + 0.03);
  assert.ok(during.firing && during.out > 0);
  const lane = piston.reach * 0.5;
  const x = piston.x + Math.cos(piston.a) * lane;
  const z = piston.z + Math.sin(piston.a) * lane;
  assert.equal(hazardHit(PINBALL, fireAt - 0.3, x, z, 1.2), null);
  let hit = null;

  for (let t = fireAt; t < fireAt + 0.3 && !hit; t += STEP) {
    hit = hazardHit(PINBALL, t, x, z, 1.2);
  }

  assert.ok(hit);
  assert.equal(hit.how, "piston");
  assert.ok(hit.dx * Math.cos(piston.a) + hit.dz * Math.sin(piston.a) > 0.8);
});

test("pop bumpers kick cars straight back out", () => {
  const bumper = PINBALL.def.hazards.find((hazard) => hazard.kind === "bumper");
  assert.ok(bumper);
  const hit = hazardHit(PINBALL, 5, bumper.x + bumper.r + 1, bumper.z, 1.2);
  assert.ok(hit);
  assert.equal(hit.how, "bumper");
  assert.ok(hit.dx > 0.9);
});

test("the ends blink, then drop, for the last stretch of the round", () => {
  const start = ROUND_MS - SHRINK_MS;
  assert.deepEqual(shrinkAt(start - 100), { drop: 0, late: false, warn: false });
  assert.equal(shrinkAt(start + 100).warn, true);
  assert.equal(shrinkAt(start + 100).late, false);
  const gone = shrinkAt(start + SHRINK_WARN_MS + 500);
  assert.ok(gone.late && !gone.warn && gone.drop > 0);
  const end = PINBALL.halfX - 3;
  assert.ok(onBoard(PINBALL, end, 0));
  assert.ok(!onBoard(PINBALL, end, 0, true));
  const field = makeField(PINBALL);
  field.time = (start + SHRINK_WARN_MS) / 1000 - 0.2;
  const car = place(field, "p1", end, 0, 0);
  const events = run(field, 1.5);
  assert.ok(events.some((event) => event.kind === "out" && event.by === ""));
  assert.equal(car.falls, 1);
});

test("crates come on a clock every client can work out, one at a time", () => {
  assert.equal(crateAt(PINBALL, 3, ITEMS_AT - CRATE_BEAM - 0.1), null);
  const firstCrate = crateAt(PINBALL, 3, ITEMS_AT - CRATE_BEAM + 0.1);
  assert.ok(firstCrate);
  assert.equal(firstCrate.index, 0);
  assert.equal(firstCrate.landAt, ITEMS_AT);
  assert.deepEqual(crateAt(PINBALL, 3, ITEMS_AT + 1), firstCrate);
  assert.equal(crateAt(PINBALL, 3, ITEMS_AT + CRATE_EVERY)?.index, 1);
  assert.equal(crateAt(PINBALL, 3, ROUND_MS / 1000 + 1), null);
  const end = ROUND_MS / 1000;
  const last = Math.ceil((end - ITEMS_AT) / CRATE_EVERY) - 1;
  assert.ok(ITEMS_AT + (last + 1) * CRATE_EVERY - CRATE_BEAM < end, "a beam would show");
  assert.equal(crateAt(PINBALL, 3, end - 0.5)?.index, last, "no crate is called it cannot land");
  const kinds = new Set<string>();

  for (let round = 0; round < 12; round += 1) {
    for (let index = 0; index < 9; index += 1) {
      const crate = crateOf(PINBALL, round, index);
      kinds.add(crate.kind);
      const bumper = crate.kind === "mega" || crate.kind === "spring";
      assert.equal(bumper, index % 2 === 0);
      assert.ok(onBoard(PINBALL, crate.x, crate.z));
      const { late } = shrinkAt((crate.landAt + CRATE_EVERY) * 1000);
      assert.ok(!late || onBoard(PINBALL, crate.x, crate.z, true), "never on a dropped end");
    }
  }

  assert.equal(kinds.size, 4);
});

test("a car that reaches a landed crate is offered it, and takes it once granted", () => {
  const field = makeField(PINBALL);
  const crate = crateOf(PINBALL, 0, 0);
  field.time = crate.landAt - 0.5;
  const car = place(field, "p1", crate.x, crate.z, 0);
  assert.deepEqual(run(field, 0.3), []);
  const events = run(field, 0.4);
  const reach = events.find((event) => event.kind === "reach");
  assert.ok(reach && reach.kind === "reach");
  assert.equal(reach.crate, 0);
  grant(field, "p1", reach.crate, reach.item);
  assert.equal(heldItem(car), crate.kind);
  assert.deepEqual(run(field, 0.3), []);
});

test("a full round of bots is a fight: punches land, cars fall, crates go, nobody breaks", () => {
  for (const round of [1, 2, 4000]) {
    const log = playMatch(round);

    const count = (kind: FieldEvent["kind"]) =>
      log.events.filter((event) => event.kind === kind).length;

    const falls = [...log.falls.values()].reduce((sum, n) => sum + n, 0);
    const byCar = log.causes.get("car") ?? 0;
    assert.ok(count("punch") > 40, `punches: ${count("punch")}`);
    assert.ok(count("whiff") < count("punch") * 0.5, "most punches land");
    assert.ok(falls >= 12 && falls <= 64, `falls: ${falls}`);
    assert.ok(byCar > falls * 0.6, `${byCar} of ${falls} falls were somebody's doing`);
    assert.ok(count("reach") >= 4, `pickups: ${count("reach")}`);
    assert.ok(Math.max(...log.scores.values()) >= 3);

    for (const event of log.events) {
      if (event.kind === "hit") {
        assert.ok(Number.isFinite(event.x + event.z + event.reach));
      }
    }
  }
});
