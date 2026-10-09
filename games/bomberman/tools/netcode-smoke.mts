import assert from "node:assert/strict";
import { test } from "node:test";
import type { StickState } from "@vibedgames/gamepad";
import { diffState } from "@vibedgames/multiplayer";
import { DirInput, stickDirs } from "../src/input/dir-input";
import {
  BombPrediction,
  fuseStart,
  MAX_PRESS_AGE_MS,
  PREDICTION_TIMEOUT_MS,
} from "../src/net/bomb-prediction";
import { createArena } from "../src/shared/arena";
import {
  baseStats,
  COLORS,
  GRID_COLS,
  HOST_STEP_MS,
  MIN_MOVE_MS,
  newGrid,
  PLAYER_LIMITS,
  SPAWN_POINTS,
} from "../src/shared/constants";
import type { Cell, Dir, SharedState } from "../src/shared/constants";
import { FixedStep } from "../src/sim/fixed-step";
import { bombId, grantPowerup, placeBomb } from "../src/sim/host-sim";
import { seededRandom } from "../src/util/seeded-random";

const open =
  (...dirs: Dir[]) =>
  (dir: Dir): boolean =>
    dirs.includes(dir);

// ---- input -------------------------------------------------------------------

test("direction stack: the newest held key wins, and a blocked one yields to the next held", () => {
  const input = new DirInput();
  input.press("right");
  input.press("up");
  assert.equal(input.choose(open("up", "right", "left")), "up", "newest press first");
  assert.equal(input.choose(open("right", "left")), "right", "up walled: right still held");
  input.press("left");
  input.sync((dir) => dir === "left" || dir === "right");
  assert.equal(input.choose(open("up", "left", "right")), "left", "released up is gone");
  input.sync((dir) => dir === "right");
  assert.equal(input.choose(open("up", "left", "right")), "right");
  input.sync(() => false);
  assert.equal(input.choose(open("up", "left", "right")), null, "nothing held, nothing buffered");
  assert.equal(input.choose(open("down"), ["down"]), "down", "a stick fills in last");
});

test("a turn tapped before a junction survives one step and is taken there", () => {
  const input = new DirInput();
  input.press("right");
  // Up is tapped and released mid-step, a tile before the opening.
  input.press("up");
  input.sync((dir) => dir === "right");
  assert.equal(input.choose(open("right")), "right", "walled: keep walking");
  assert.equal(input.choose(open("up", "right")), "up", "the opening takes the buffered turn");
  assert.equal(input.choose(open("up", "right")), "right", "spent once taken");

  input.press("up");
  input.sync((dir) => dir === "right");
  input.choose(open("right"));
  input.choose(open("right"));
  assert.equal(input.choose(open("up", "right")), "right", "two blocked steps: dropped");

  input.press("up");
  input.sync(() => false);
  assert.equal(input.choose(open("right")), null, "blocked standing still");
  assert.equal(input.choose(open("up")), null, "and not replayed later");
});

const stick = (degrees: number): StickState => ({
  active: true,
  anchorX: 0,
  anchorY: 0,
  angle: (degrees * Math.PI) / 180,
  curX: 0,
  curY: 0,
  distance: 40,
  dx: 0,
  dy: 0,
  inDeadZone: false,
  magnitude: 1,
});

test("a stick pushed towards a diagonal offers the other axis as a fallback", () => {
  assert.deepEqual(stickDirs(stick(5)), ["right"]);
  assert.deepEqual(stickDirs(stick(30)), ["right", "down"]);
  assert.deepEqual(stickDirs(stick(-120)), ["up", "left"]);
  assert.deepEqual(stickDirs({ ...stick(30), inDeadZone: true }), []);
});

// ---- the host step -----------------------------------------------------------

test("fixed host step: an exact 50 ms grid at any frame rate, a bounded catch-up after a stall", () => {
  for (const fps of [30, 60, 75, 144]) {
    const step = new FixedStep(HOST_STEP_MS, 250);
    const ticks: number[] = [];
    for (let t = 0; t <= 2000; t += 1000 / fps) {
      ticks.push(...step.due(10_000 + Math.floor(t)));
    }
    assert.ok(Math.abs(ticks.length - 41) <= 1, `${fps} fps ran ${ticks.length} steps`);
    for (let i = 1; i < ticks.length; i += 1) {
      assert.equal((ticks[i] ?? 0) - (ticks[i - 1] ?? 0), HOST_STEP_MS, `${fps} fps`);
    }
  }
  const step = new FixedStep(HOST_STEP_MS, 250);
  assert.deepEqual(step.due(0), [0], "the first call steps at once");
  assert.equal(step.due(3000).length, 5, "a 3 s stall replays 250 ms, not 3 s");
  assert.deepEqual(step.due(3010), [], "and the grid holds");
  step.reset();
  assert.deepEqual(step.due(5000), [5000]);
  // A frame may stop early (the host stops at a bot turn): what it left stays due.
  assert.equal(step.next(5200), 5050);
  assert.equal(step.next(5200), 5100);
  assert.deepEqual(step.due(5210), [5150, 5200], "taken by the next frame");
});

// ---- bombs ------------------------------------------------------------------

const openWorld = (patch: Partial<SharedState> = {}): SharedState => ({
  blasts: {},
  bombs: {},
  bots: {},
  deaths: {},
  grid: newGrid().map((cells) =>
    cells.map((cell): Cell => (cell.kind === "crate" ? { kind: "empty" } : cell)),
  ),
  powerups: {},
  startedAt: 1,
  stats: {},
  winner: null,
  ...patch,
});

test("a guest's bomb shows on the press under the id the host gives it, and is adopted silently", () => {
  const state = openWorld();
  const prediction = new BombPrediction();
  const view = (): SharedState => ({ ...state, bombs: prediction.visible(state.bombs) });
  const ghost = placeBomb(view(), "g", 1, 1, 1000, 7)?.[bombId("g", 7)];
  assert.ok(ghost, "the guest runs the host's rule on its own view");
  prediction.add(ghost, 0);
  assert.equal(
    placeBomb(view(), "g", 2, 1, 1010, 8),
    null,
    "its stock counts the unconfirmed bomb",
  );
  assert.equal(placeBomb(view(), "h", 1, 1, 1010), null, "and the tile is solid");
  // A trip later the host places the same press under the same id, its fuse
  // started at the press: the two copies burn down together.
  const hosted = placeBomb(state, "g", 1, 1, fuseStart(1000, 1060), 7);
  assert.ok(hosted);
  assert.deepEqual(Object.keys(hosted), [ghost.id], "one bomb, one id: the sprite carries over");
  assert.equal(prediction.visible(hosted)[ghost.id]?.placedAt, 1000, "the fuse carries over");
  assert.notEqual(prediction.visible(hosted)[ghost.id], ghost, "the host's copy wins");
  assert.equal(prediction.settle(hosted, 140), false, "adopted, not refused");
  assert.deepEqual(prediction.visible({}), {}, "and retired");
  // A replayed press never overwrites the bomb it placed.
  const stocked = openWorld({ bombs: hosted, stats: { g: { bombs: 3, range: 2, speed: 175 } } });
  assert.equal(placeBomb(stocked, "g", 3, 1, 1300, 7), null);
  // Scoring and the bot soak read a blast's owner off the id prefix.
  assert.ok(`x-${bombId("g", 7)}`.startsWith("x-b-g-"));
});

test("the host starts a guest's fuse at the press, never further back than a slow trip", () => {
  assert.equal(fuseStart(9900, 10_000), 9900, "the press, on the clock both share");
  const stale = 10_000 - MAX_PRESS_AGE_MS - 500;
  assert.equal(fuseStart(stale, 10_000), 10_000 - MAX_PRESS_AGE_MS, "a forged or stale stamp");
  assert.equal(fuseStart(10_050, 10_000), 10_000, "never in the future");
});

test("a prediction the host refuses comes off the board after the timeout", () => {
  const prediction = new BombPrediction();
  const ghost = placeBomb(openWorld(), "g", 1, 1, 1000, 1)?.[bombId("g", 1)];
  assert.ok(ghost);
  prediction.add(ghost, 0);
  assert.equal(prediction.settle({}, PREDICTION_TIMEOUT_MS - 1), false);
  assert.ok(prediction.visible({})[ghost.id], "still waiting on the host");
  assert.equal(prediction.settle({}, PREDICTION_TIMEOUT_MS), true, "refused");
  assert.deepEqual(prediction.visible({}), {});
  // On a route whose confirmations take 450 ms, a prediction gets twice that.
  const slow = placeBomb(openWorld(), "g", 1, 1, 2000, 2)?.[bombId("g", 2)];
  assert.ok(slow);
  prediction.add(slow, 1000);
  assert.equal(prediction.settle({ [slow.id]: slow }, 1450), false);
  assert.equal(prediction.timeoutMs, 900);
  prediction.add({ ...slow, id: bombId("g", 3) }, 2000);
  assert.equal(prediction.settle({}, 2000 + PREDICTION_TIMEOUT_MS), false, "still in time");
  assert.equal(prediction.settle({}, 2900), true);
});

// ---- wire -------------------------------------------------------------------

test("the board on the wire: each opened crate is one cell, an unchanged clock nothing", () => {
  const clock = { kind: "running", offset: 0 } as const;
  const before = { clock, grid: createArena("classic", seededRandom(3)) };
  const grid = before.grid.map((cells) => [...cells]);
  const opened: [row: number, col: number][] = [];
  for (const [row, cells] of grid.entries()) {
    for (const [col, cell] of cells.entries()) {
      if (cell.kind === "crate" && (row + col) % 3 === 0) {
        cells[col] = { kind: "empty" };
        opened.push([row, col]);
      }
    }
  }
  assert.ok(opened.length > 10);
  // The host writes the whole board and its clock; the SDK sends the leaves that changed.
  const ops = diffState(before, { clock: { ...clock }, grid }, ["clock", "grid"]);
  assert.deepEqual(
    ops,
    opened.map(([row, col]) => [["grid", row, col, "kind"], "empty"]),
  );
  assert.ok(JSON.stringify(before.grid).length > 4000, "what a whole board would resend");
});

/** Whether the party server would pass a player-state patch under the game's limits. */
const insideLimits = (patch: Record<string, number>): boolean =>
  Object.entries(PLAYER_LIMITS).every(([key, { min, max }]) => {
    const value = patch[key];
    return value === undefined || (value >= min && value <= max);
  });

test("player-state limits admit every spawn and stride a client publishes, and nothing off the board", () => {
  for (const [idx, spawn] of SPAWN_POINTS.entries()) {
    assert.ok(insideLimits({ ...spawn, colorIdx: idx % COLORS.length, s: 0 }), `spawn ${idx}`);
  }
  // Every stride from the base down to the fastest that speed power-ups reach.
  let stats = baseStats();
  for (let pickups = 0; pickups < 8; pickups += 1) {
    assert.ok(insideLimits({ s: stats.speed }), `stride ${stats.speed}`);
    stats = grantPowerup(stats, "speed");
  }
  assert.equal(stats.speed, MIN_MOVE_MS);
  assert.ok(!insideLimits({ col: GRID_COLS }), "off the board");
  assert.ok(!insideLimits({ colorIdx: COLORS.length }), "off the palette");
});
