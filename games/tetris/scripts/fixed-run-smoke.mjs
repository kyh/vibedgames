import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Engine } from "../src/game/engine.ts";
import {
  FIXED_RUN_BEST_KEY,
  createFixedRandom,
  parseFixedBest,
  readFixedBest,
  storeFixedBest,
} from "../src/game/fixed-run.ts";

function snapshot(engine) {
  const cubes = [];
  engine.board.forEachCube((x, y, z, color, id) => cubes.push([x, y, z, color, id]));
  return {
    active: engine.activePieceIndex(),
    cells: engine.activeCells(),
    next: engine.nextIndex,
    hold: engine.holdIndex,
    score: engine.state.score,
    lines: engine.state.lines,
    phase: engine.state.status,
    charge: engine.charge,
    cycle: engine.cycleTimeMs,
    cubes,
  };
}

function ordinaryTrace(Core) {
  const original = Math.random;
  let word = 7123;
  let draws = 0;
  Math.random = () => {
    draws++;
    word = (Math.imul(word, 1664525) + 1013904223) >>> 0;
    return word / 4294967296;
  };
  try {
    const engine = new Core();
    const trace = [{ queued: engine.nextIndex, draws }];
    engine.startGame();
    for (let turn = 0; turn < 42; turn++) {
      if (turn === 21) engine.startGame();
      const held = turn % 5 === 0 ? [engine.hold(), engine.hold()] : [];
      const moved = engine.move((turn % 3) - 1, turn % 2);
      const rotated = turn % 2 === 0 ? engine.rotate() : false;
      engine.setSoftDrop(turn % 3 === 0);
      engine.tick(30, false);
      engine.tick(5000, true);
      const lock = engine.hardDrop();
      trace.push({ held, moved, rotated, lock, ...snapshot(engine), draws });
      engine.board.reset();
    }
    engine.reset();
    trace.push({ reset: snapshot(engine), draws });
    return { trace, draws };
  } finally {
    Math.random = original;
  }
}

function fixedTrace(cosmeticDraws, engine = new Engine()) {
  engine.startGame(createFixedRandom());
  const trace = [];
  for (let turn = 0; turn < 35; turn++) {
    for (let i = 0; i < cosmeticDraws; i++) Math.random();
    if (turn % 6 === 0) {
      assert.equal(engine.hold(), true);
      assert.equal(engine.hold(), false);
    }
    engine.move((turn % 3) - 1, turn % 2);
    if (turn % 2 === 0) engine.rotate();
    if (turn % 7 === 0) {
      // Leave exactly the real landing footprint empty; the accepted drop clears this layer.
      const landing = engine.ghostCells();
      const fill = [];
      for (let x = 0; x < engine.board.width; x++)
        for (let z = 0; z < engine.board.depth; z++)
          if (!landing.some((cell) => cell.x === x && cell.z === z)) fill.push({ x, y: 0, z });
      engine.board.lock(fill, 1);
    }
    engine.setSoftDrop(turn % 3 === 0);
    engine.tick(35, false);
    const paused = snapshot(engine);
    assert.equal(engine.tick(10000, true), null);
    assert.deepEqual(snapshot(engine), paused);
    const lock = engine.hardDrop();
    assert.ok(lock);
    if (turn % 7 === 0) assert.equal(lock.clear.cubes, 64);
    if (engine.canPower()) {
      engine.board.lock([{ x: 0, y: 3, z: 0 }], 1);
      assert.equal(engine.power(), 1);
    }
    engine.board.reset();
    let rescued = false;
    if (turn % 9 === 0) {
      engine.board.lock(
        [
          { x: 0, y: 8, z: 0 },
          { x: 0, y: 11, z: 0 },
        ],
        2,
      );
      engine.state.status = "collapsing";
      rescued = !engine.resumeAfterCatch();
      assert.equal(rescued, true);
    }
    trace.push({ lock, rescued, ...snapshot(engine) });
    engine.board.reset();
  }
  return trace;
}

test("normal Engine bags/actions retain the original trace and random draw count", async () => {
  const actual = ordinaryTrace(Engine);
  if (process.env.TETRIS_ENGINE_BASELINE) {
    const original = await import(pathToFileURL(process.env.TETRIS_ENGINE_BASELINE).href);
    assert.deepEqual(actual, ordinaryTrace(original.Engine));
  }
  assert.equal(actual.draws, 60);
  assert.equal(
    createHash("sha256").update(JSON.stringify(actual)).digest("hex"),
    "e13c4ff1c2df70c9f8e7ef56a27c4a1fd840129190ca99f0aa96a38745db8b8a",
  );
});

test("fixed retry repeats real holds, clears, powers and catches despite unrelated random draws", () => {
  const engine = new Engine();
  const first = fixedTrace(0, engine);
  assert.deepEqual(fixedTrace(19, engine), first);
  assert.deepEqual(fixedTrace(3, engine), first);
});

test("every fixed bag contains all seven pieces and normal start relinquishes the seeded supplier", () => {
  const engine = new Engine();
  engine.startGame(createFixedRandom());
  const pieces = [];
  for (let i = 0; i < 70; i++) {
    pieces.push(engine.activePieceIndex());
    engine.hardDrop();
    engine.board.reset();
  }
  for (let i = 0; i < pieces.length; i += 7)
    assert.deepEqual(pieces.slice(i, i + 7).toSorted(), [0, 1, 2, 3, 4, 5, 6]);
  const original = Math.random;
  let draws = 0;
  Math.random = () => {
    draws++;
    return 0.5;
  };
  try {
    engine.startGame();
    assert.equal(draws, 6);
    engine.reset();
    assert.equal(draws, 12);
  } finally {
    Math.random = original;
  }
});

test("fixed best has a separate strict key and blocked storage cannot break result/retry", () => {
  assert.notEqual(FIXED_RUN_BEST_KEY, "tetris-best-score");
  for (const value of [
    null,
    "",
    " 12",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "1e2",
    "01",
    "9007199254740992",
  ])
    assert.equal(parseFixedBest(value), 0);
  assert.equal(parseFixedBest("12345"), 12345);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
    });
    storeFixedBest(120);
    assert.equal(readFixedBest(), 120);
    assert.deepEqual([...values], [[FIXED_RUN_BEST_KEY, "120"]]);
    storeFixedBest(NaN);
    storeFixedBest(-1);
    assert.equal(readFixedBest(), 120);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    assert.equal(readFixedBest(), 0);
    assert.doesNotThrow(() => storeFixedBest(200));
    const engine = new Engine();
    engine.startGame(createFixedRandom());
    assert.equal(engine.state.status, "playing");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});
