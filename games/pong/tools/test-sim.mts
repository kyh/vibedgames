// The lockstep sim: a pure function of its seed and per-tick inputs, built
// only from arithmetic every JavaScript engine rounds the same way.

import assert from "node:assert/strict";
import { test } from "node:test";

import { flyTick } from "../src/shared/ball.ts";
import type { Ball } from "../src/shared/ball.ts";
import {
  GOAL_Y,
  MIN_VY_FRAC,
  PADDLE_Y,
  RALLY_SPEED_BASE,
  WIN_SCORE,
} from "../src/shared/constants.ts";
import { exactCos, exactExp, exactSin } from "../src/shared/exact-math.ts";
import { INPUT_COUNTER, bump, encodeInput, paddleStep, readInput } from "../src/shared/input.ts";
import type { SlotInput } from "../src/shared/input.ts";
import { SERVE_DELAY_TICKS, cloneSim, newMatch, simChecksum, stepSim } from "../src/shared/sim.ts";
import type { HitEvent, SimEvent, SimState, Slot } from "../src/shared/sim.ts";
import { SPIN_RATE, SPIN_TICKS, curveTick } from "../src/shared/spin.ts";

/** The test's own randomness: Park–Miller, so the scripts replay exactly. */
const generator = (seed: number) => {
  let state = seed;
  return (): number => {
    state = (state * 48_271) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

/** Every Math function ECMAScript lets an engine approximate. */
const APPROXIMATED = [
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atan2",
  "atanh",
  "cbrt",
  "cos",
  "cosh",
  "exp",
  "expm1",
  "hypot",
  "log",
  "log10",
  "log1p",
  "log2",
  "pow",
  "random",
  "sin",
  "sinh",
  "tan",
  "tanh",
] as const;

/** Run `body` with Math.random and the approximated functions throwing. */
const withoutApproximations = (body: () => void): void => {
  const saved = APPROXIMATED.map((name) => [name, Math[name]] as const);
  for (const name of APPROXIMATED) {
    Object.defineProperty(Math, name, {
      configurable: true,
      value: () => {
        throw new Error(`the sim called Math.${name}`);
      },
    });
  }
  try {
    body();
  } finally {
    for (const [name, fn] of saved) {
      Object.defineProperty(Math, name, { configurable: true, value: fn });
    }
  }
};

interface Pilot {
  c: number;
  k: number;
  aim: number;
}

/**
 * A scripted player for `slot`: follows the ball with a wandering offset (so
 * returns go off at angles and points get scored), serves and rematches,
 * arms a ready charge and now and then cancels it.
 */
const pilotInput = (s: SimState, slot: Slot, pilot: Pilot, roll: () => number): SlotInput => {
  const paddle = slot === 0 ? s.a : s.b;
  if (roll() < 0.02) {
    pilot.aim = (roll() * 2 - 1) * 0.9;
  }
  if (s.phase !== "rally" && roll() < 0.05) {
    pilot.c = bump(pilot.c);
  }
  if (s.phase === "rally" && paddle.charge.kind === "ready" && roll() < 0.1) {
    pilot.c = bump(pilot.c);
  }
  if (paddle.charge.kind === "armed" && roll() < 0.01) {
    pilot.k = bump(pilot.k);
  }
  return { c: pilot.c, k: pilot.k, x: paddleStep(s.ball.x + pilot.aim) };
};

interface Script {
  inputs: [SlotInput | null, SlotInput | null][];
  events: SimEvent[];
  final: SimState;
}

/** Play `ticks` ticks from `seed`, slot B absent (AI) for a stretch. */
const playScript = (seed: number, ticks: number): Script => {
  const roll = generator(seed + 7);
  const s = newMatch({ autoServe: true, scoreA: 0, scoreB: 0, seed, tick: 99 });
  const pilots: [Pilot, Pilot] = [
    { aim: 0.4, c: 0, k: 0 },
    { aim: -0.4, c: 3, k: 5 },
  ];
  const inputs: Script["inputs"] = [];
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i += 1) {
    const a = pilotInput(s, 0, pilots[0], roll);
    const away = i > ticks / 3 && i < ticks / 2;
    const b = away ? null : pilotInput(s, 1, pilots[1], roll);
    inputs.push([a, b]);
    stepSim(s, a, b);
    events.push(...s.events);
  }
  return { events, final: s, inputs };
};

/** Within a few ulps. */
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-15 * Math.max(1, Math.abs(b));

/** The first serve's lateral speed from a seed. */
const firstServe = (seed: number): number => {
  const s = newMatch({ autoServe: true, scoreA: 0, scoreB: 0, seed, tick: 0 });
  while (s.phase !== "rally") {
    stepSim(s, null, null);
  }
  return s.ball.vx;
};

test("exact math tracks Math over the ranges the sim uses", () => {
  for (let i = -50; i <= 50; i += 1) {
    const x = i / 100;
    assert.ok(near(exactSin(x), Math.sin(x)), `sin ${x}`);
    assert.ok(near(exactCos(x), Math.cos(x)), `cos ${x}`);
    assert.ok(near(exactExp(2 * x), Math.exp(2 * x)), `exp ${2 * x}`);
  }
});

test("the sim never reaches for Math.random or an approximated Math function", () => {
  withoutApproximations(() => {
    const { events, final } = playScript(12_345, 20_000);
    assert.ok(events.some((e) => e.kind === "point"));
    assert.equal(final.tick, 99 + 20_000);
  });
});

test("one seed and one input stream give one match, however it is cloned and replayed", () => {
  const { inputs, final } = playScript(777, 12_000);
  // Replay the recorded inputs into a fresh match, cloning every tick the
  // way rollback does, and restoring from a mid-match snapshot.
  const fresh = newMatch({ autoServe: true, scoreA: 0, scoreB: 0, seed: 777, tick: 99 });
  let copy = fresh;
  let snapshot: SimState | null = null;
  const half = inputs.length / 2;
  for (const [i, [a, b]] of inputs.entries()) {
    copy = cloneSim(copy);
    stepSim(copy, a, b);
    if (i === half) {
      snapshot = cloneSim(copy);
    }
  }
  assert.equal(JSON.stringify(copy), JSON.stringify(final));
  assert.ok(snapshot !== null);
  const resumed = snapshot;
  for (const [a, b] of inputs.slice(half + 1)) {
    stepSim(resumed, a, b);
  }
  assert.equal(simChecksum(resumed), simChecksum(final));
});

test("a long scripted match exercises every rule", () => {
  const { events, final } = playScript(2024, 60_000);
  const kinds = new Set(events.map((e) => e.kind));
  for (const kind of ["serve", "hit", "wall", "land", "point"]) {
    assert.ok(kinds.has(kind), `no ${kind} event`);
  }
  const hits = events.filter((e): e is HitEvent => e.kind === "hit");
  assert.ok(
    hits.some((e) => e.powered),
    "no power shot",
  );
  assert.ok(
    hits.some((e) => e.shot === "slice"),
    "no slice",
  );
  assert.ok(hits.some((e) => e.slot === 0) && hits.some((e) => e.slot === 1));
  assert.ok(
    events.some((e) => e.kind === "point" && e.won),
    "no match won",
  );
  assert.ok(final.longest >= 3);
  // Every event key is unique within the match: a key names one happening.
  const keys = events.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("seeds pick the serves", () => {
  assert.equal(firstServe(5), firstServe(5));
  assert.notEqual(firstServe(5), firstServe(6));
});

test("a slice keeps the speed and the forward floor, and turns as far as the continuous curve", () => {
  for (const forward of [-1, 1]) {
    for (const lateral of [-1, 0, 1]) {
      for (const direction of [-1, 1]) {
        const ball: Ball = {
          spin: direction,
          spinAge: 0,
          vx: lateral * 12,
          vy: forward * 5,
          x: 0,
          y: 0,
        };
        const speed = Math.hypot(ball.vx, ball.vy);
        for (let i = 0; i < SPIN_TICKS; i += 1) {
          curveTick(ball);
          assert.ok(Math.abs(Math.hypot(ball.vx, ball.vy) - speed) < 1e-9);
          assert.ok(forward * ball.vy >= speed * MIN_VY_FRAC - 1e-9);
        }
        assert.equal(ball.spin, 0);
      }
    }
  }
  // Unclamped, the per-tick turns add up to the continuous curve's integral.
  const ball: Ball = { spin: 0.8, spinAge: 0, vx: 0, vy: 7, x: 0, y: 0 };
  for (let i = 0; i < SPIN_TICKS; i += 1) {
    curveTick(ball);
  }
  const integral = (0.8 * SPIN_RATE * (1 - Math.exp(-3.5 * 0.5))) / 3.5;
  assert.ok(Math.abs(Math.atan2(ball.vx, ball.vy) - integral) < 1e-12);
});

test("a bank reflects the overshoot and ends the slice", () => {
  const ball: Ball = { spin: 0.8, spinAge: 3, vx: 6, vy: 6, x: 4.85, y: 0 };
  assert.equal(flyTick(ball), true);
  assert.ok(ball.vx < 0 && ball.x < 4.9);
  assert.equal(ball.spin, 0);
});

test("inputs round-trip; anything else reads as no input", () => {
  const input: SlotInput = { c: 3, k: INPUT_COUNTER - 1, x: paddleStep(-2.2) };
  assert.deepEqual(readInput(encodeInput(input)), input);
  assert.equal(paddleStep(99), paddleStep(4.5));
  for (const wire of [
    null,
    false,
    3,
    "x",
    [],
    [1, 2],
    [1, 2, 3, 4],
    [1.5, 0, 0],
    [0, 16, 0],
    [0, 0, -1],
    [999, 0, 0],
    ["1", 0, 0],
  ]) {
    assert.equal(readInput(wire), null, JSON.stringify(wire));
  }
});

test("a press is a change of the counter: held, first seen or returning, it is not", () => {
  const s = newMatch({ autoServe: false, scoreA: 0, scoreB: 0, seed: 1, tick: 0 });
  const held: SlotInput = { c: 5, k: 0, x: 0 };
  for (let i = 0; i < 10; i += 1) {
    stepSim(s, held, null);
  }
  assert.equal(s.phase, "serving");
  // Gone and back with the same counter: still no press.
  stepSim(s, null, null);
  stepSim(s, held, null);
  assert.equal(s.phase, "serving");
  stepSim(s, { ...held, c: bump(held.c) }, null);
  assert.equal(s.phase, "rally");
  assert.equal(s.events[0]?.kind, "serve");
});

test("a power shot arms on a press, cancels on a cancel, and fires on the next return", () => {
  const s = newMatch({ autoServe: false, scoreA: 0, scoreB: 0, seed: 1, tick: 0 });
  let input: SlotInput = { c: 0, k: 0, x: 0 };
  stepSim(s, input, null);
  input = { ...input, c: bump(input.c) };
  stepSim(s, input, null);
  assert.equal(s.phase, "rally");
  s.a.charge = { kind: "ready" };
  input = { ...input, c: bump(input.c) };
  stepSim(s, input, null);
  assert.equal(s.a.charge.kind, "armed");
  input = { ...input, k: bump(input.k) };
  stepSim(s, input, null);
  assert.equal(s.a.charge.kind, "ready");
  input = { ...input, c: bump(input.c) };
  stepSim(s, input, null);
  assert.equal(s.a.charge.kind, "armed");
  // Steer under the ball until slot A returns it.
  let hit: SimEvent | undefined;
  for (let i = 0; i < 400 && hit === undefined; i += 1) {
    stepSim(s, { ...input, x: paddleStep(s.ball.x) }, null);
    hit = s.events.find((e) => e.kind === "hit" && e.slot === 0);
  }
  assert.ok(hit?.kind === "hit" && hit.powered);
  assert.deepEqual(s.a.charge, { hits: 0, kind: "charging" });
  assert.ok(s.speed > RALLY_SPEED_BASE);
});

test("nobody at a paddle: the AI holds it", () => {
  const s = newMatch({ autoServe: true, scoreA: 0, scoreB: 0, seed: 9, tick: 0 });
  while (s.phase !== "rally") {
    stepSim(s, { c: 0, k: 0, x: 0 }, null);
  }
  s.ball.x = 3;
  s.ball.vx = 0;
  const before = s.b.x;
  stepSim(s, { c: 0, k: 0, x: 0 }, null);
  assert.equal(s.b.human, false);
  assert.ok(s.b.x > before);
  stepSim(s, { c: 0, k: 0, x: 0 }, { c: 0, k: 0, x: paddleStep(-1) });
  assert.equal(s.b.human, true);
  assert.equal(s.b.x, -1);
});

test("a point parks the ball on its line through the goal beat, then the countdown serves the conceder", () => {
  const s = newMatch({ autoServe: true, scoreA: 0, scoreB: 0, seed: 3, tick: 0 });
  while (s.phase !== "rally") {
    stepSim(s, null, null);
  }
  // Slot B's paddle is far away; the ball is a step from B's goal line.
  Object.assign(s.ball, { vx: 0, vy: 9, x: -3, y: GOAL_Y - 0.05 });
  const far = { c: 0, k: 0, x: paddleStep(4.5) };
  stepSim(s, null, far);
  const scored = s.events.find((e) => e.kind === "point");
  assert.ok(scored?.kind === "point" && scored.scorer === 0 && !scored.won);
  assert.equal(s.scoreA, 1);
  assert.equal(s.ball.y, GOAL_Y);
  const pointTick = s.tick;
  while (s.freeze > 0) {
    assert.equal(s.ball.y, GOAL_Y);
    stepSim(s, null, far);
  }
  assert.deepEqual([s.ball.x, s.ball.y, s.phase], [0, 0, "serving"]);
  while (s.phase === "serving") {
    stepSim(s, null, far);
  }
  assert.equal(s.tick, pointTick + SERVE_DELAY_TICKS);
  const served = s.events.find((e) => e.kind === "serve");
  assert.ok(served?.kind === "serve" && served.receiver === 1);
  assert.ok(s.ball.vy > 0);
});

test("the last point wins the match; either player's confirm rematches from 0–0", () => {
  const s = newMatch({ autoServe: true, scoreA: WIN_SCORE - 1, scoreB: 2, seed: 4, tick: 0 });
  while (s.phase !== "rally") {
    stepSim(s, null, null);
  }
  Object.assign(s.ball, { vx: 0, vy: 9, x: 2, y: GOAL_Y - 0.05 });
  const a: SlotInput = { c: 0, k: 0, x: 0 };
  const b: SlotInput = { c: 7, k: 0, x: paddleStep(-4.5) };
  stepSim(s, a, b);
  const won = s.events.find((e) => e.kind === "point");
  assert.ok(won?.kind === "point" && won.won);
  assert.deepEqual([s.phase, s.scoreA, s.serveAt], ["won", WIN_SCORE, null]);
  for (let i = 0; i < 200; i += 1) {
    stepSim(s, a, b);
  }
  assert.equal(s.phase, "won");
  stepSim(s, a, { ...b, c: bump(b.c) });
  assert.deepEqual([s.phase, s.scoreA, s.scoreB, s.receiver], ["rally", 0, 0, 0]);
  assert.ok(s.ball.vy < 0 && Math.abs(s.ball.y) < PADDLE_Y);
});
