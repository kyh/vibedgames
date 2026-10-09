import assert from "node:assert/strict";
import { test } from "node:test";

import { applyPatch, cloneJson, diffState, readPatch } from "../src/patch.js";
import type { PatchOp, PatchSegment } from "../src/patch.js";
import type { JsonRecord, JsonValue } from "../src/types.js";
import { findStructuralIssue, MAX_STATE_DEPTH } from "../src/validation.js";

/** Deterministic pseudo-random numbers in [0, 1), so a failure replays. */
const random = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

const pick = <T>(roll: () => number, items: readonly T[]): T => {
  const item = items[Math.floor(roll() * items.length)];
  if (item === undefined) {
    throw new Error("pick from an empty list");
  }
  return item;
};

/** A random JSON value, a few levels deep. */
const randomValue = (roll: () => number, depth: number): JsonValue => {
  const kind =
    depth <= 0
      ? pick(roll, ["num", "str", "bool", "null"])
      : pick(roll, ["num", "str", "obj", "arr", "obj"]);
  switch (kind) {
    case "num": {
      return Math.round(roll() * 100);
    }
    case "str": {
      return pick(roll, ["a", "b", "c"]);
    }
    case "bool": {
      return roll() < 0.5;
    }
    case "arr": {
      return Array.from({ length: Math.floor(roll() * 4) }, () => randomValue(roll, depth - 1));
    }
    case "obj": {
      const record: JsonRecord = {};
      for (let i = Math.floor(roll() * 4); i > 0; i -= 1) {
        record[pick(roll, ["k", "l", "m", "n"])] = randomValue(roll, depth - 1);
      }
      return record;
    }
    default: {
      return null;
    }
  }
};

/** `value` with a few random edits, leaving `value` itself untouched. */
const mutate = (roll: () => number, value: JsonValue, depth: number): JsonValue => {
  const odds = roll();
  if (odds < 0.15 || !(value instanceof Object)) {
    return odds < 0.5 ? randomValue(roll, depth) : value;
  }
  if (Array.isArray(value)) {
    if (roll() < 0.2) {
      return [...value, randomValue(roll, depth - 1)];
    }
    return value.map((item) => (roll() < 0.4 ? mutate(roll, item, depth - 1) : item));
  }
  const copy: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    const fate = roll();
    if (fate < 0.15) {
      continue;
    }
    copy[key] = fate < 0.55 ? mutate(roll, child, depth - 1) : child;
  }
  if (roll() < 0.3) {
    copy[pick(roll, ["p", "q", "r"])] = randomValue(roll, depth - 1);
  }
  return copy;
};

const asRecord = (value: JsonValue): JsonRecord =>
  value instanceof Object && !Array.isArray(value) ? value : { value };

test("a diff applied to the old state gives the new one, for any edit", () => {
  const roll = random(7);
  for (let round = 0; round < 500; round += 1) {
    const prev = asRecord(randomValue(roll, 4));
    const after = asRecord(mutate(roll, prev, 4));
    const prevJson = JSON.stringify(prev);
    const afterJson = JSON.stringify(after);
    const ops = diffState(prev, after);
    const applied = applyPatch(prev, ops);
    assert.deepEqual(applied, after, `round ${round}: ${JSON.stringify(ops)}`);
    assert.equal(JSON.stringify(prev), prevJson, "the old state is not modified");
    assert.equal(JSON.stringify(after), afterJson, "the new state is not modified");
    // Over the wire too: ops survive JSON.
    const raw = JSON.stringify(ops);
    const wire: PatchOp[] = JSON.parse(raw);
    assert.deepEqual(applyPatch(asRecord(cloneJson(prev)), wire), after);
  }
});

test("a diff names only the leaves that changed", () => {
  const prev: JsonRecord = {
    grid: [0, 0, 0, 0],
    round: 3,
    units: { a: { hp: 9, x: 1, y: 1 }, b: { hp: 4, x: 2, y: 2 } },
  };
  const moved = { ...prev, units: { a: { hp: 9, x: 5, y: 1 }, b: { hp: 4, x: 2, y: 2 } } };
  assert.deepEqual(diffState(prev, moved), [[["units", "a", "x"], 5]]);

  const dug = { ...prev, grid: [0, 0, 1, 0] };
  assert.deepEqual(
    diffState(prev, dug),
    [[["grid", 2], 1]],
    "an array of the same length diffs by index",
  );

  const grown = { ...prev, grid: [0, 0, 0, 0, 1] };
  assert.deepEqual(
    diffState(prev, grown),
    [[["grid"], [0, 0, 0, 0, 1]]],
    "a resized array is replaced",
  );

  const died = { ...prev, units: { a: { hp: 9, x: 1, y: 1 } } };
  assert.deepEqual(diffState(prev, died), [[["units", "b"]]], "a removed key is deleted");

  // A game can hand over a key holding undefined at runtime, which the types forbid.
  const unset: JsonRecord = { ...prev };
  Object.defineProperty(unset, "round", { enumerable: true, value: undefined });
  assert.deepEqual(
    diffState(prev, unset),
    [[["round"]]],
    "undefined is absent, as JSON carries it",
  );

  assert.deepEqual(diffState(prev, { ...prev }), [], "nothing changed, nothing sent");
});

test("a container that mostly changed goes whole, when that is shorter", () => {
  const prev: JsonRecord = {
    grid: [1, 2, 3, 4, 5, 6, 7, 8],
    units: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } },
  };
  const scrambled = { ...prev, grid: [9, 9, 9, 9, 9, 9, 9, 9] };
  assert.deepEqual(diffState(prev, scrambled), [[["grid"], [9, 9, 9, 9, 9, 9, 9, 9]]]);
  const moved = { ...prev, units: { a: { x: 5, y: 6 }, b: { x: 7, y: 8 } } };
  assert.deepEqual(diffState(prev, moved), [[["units"], { a: { x: 5, y: 6 }, b: { x: 7, y: 8 } }]]);
  const reset: JsonRecord = { grid: [0], units: {} };
  assert.deepEqual(diffState(prev, reset), [[[], reset]], "the whole state, from the root");
  const nudged = { ...prev, grid: [1, 2, 3, 4, 5, 6, 7, 0] };
  assert.deepEqual(diffState(prev, nudged), [[["grid", 7], 0]], "one change stays one op");
});

test("a diff of named keys looks at those keys alone", () => {
  const prev: JsonRecord = { a: 1, b: 2, c: 3 };
  const next: JsonRecord = { a: 5, b: 9 };
  assert.deepEqual(diffState(prev, next, ["a"]), [[["a"], 5]]);
  assert.deepEqual(
    diffState(prev, next, ["c"]),
    [[["c"]]],
    "a named key the state lacks is deleted",
  );
});

test("applying copies what it writes through and shares the rest", () => {
  const state: JsonRecord = {
    course: { seed: 4 },
    units: { a: { x: 1 }, b: { x: 2 } },
  };
  const after = applyPatch(state, [[["units", "a", "x"], 7]]);
  assert.notEqual(after, state, "a new root");
  assert.equal(after.course, state.course, "an untouched subtree keeps its identity");
  assert.notEqual(after.units, state.units, "every object on the path is new");
  assert.deepEqual(
    state,
    { course: { seed: 4 }, units: { a: { x: 1 }, b: { x: 2 } } },
    "the input is unchanged",
  );
  assert.deepEqual(after, { course: { seed: 4 }, units: { a: { x: 7 }, b: { x: 2 } } });

  const replaced = applyPatch(state, [[[], { fresh: true }]]);
  assert.deepEqual(replaced, { fresh: true }, "an empty path replaces the whole state");
});

test("an op that does not fit the state changes nothing", () => {
  const state: JsonRecord = { grid: [1, 2], name: "x" };
  assert.deepEqual(applyPatch(state, [[["grid", 5], 9]]), state, "no write past an array's end");
  assert.deepEqual(applyPatch(state, [[["grid", "k"], 9]]), state, "no key into an array");
  assert.deepEqual(applyPatch(state, [[["missing", "deep"]]]), state, "no delete through nothing");
  assert.deepEqual(applyPatch(state, [[["__proto__", "polluted"], true]]), state);
  assert.deepEqual(
    applyPatch(state, [[["made", "deep"], 1]]),
    { ...state, made: { deep: 1 } },
    "a set makes missing objects",
  );
});

test("readPatch reads ops and refuses anything else", () => {
  const ops: PatchOp[] = [[["a", 0, "b"], { c: [1] }], [["gone"]], [[], { whole: 1 }]];
  assert.deepEqual(readPatch(ops), ops);
  assert.deepEqual(readPatch([]), [], "no ops is a patch that changes nothing");
  const refused: JsonValue[] = [
    { a: 1 },
    "ops",
    [["a", 1]],
    [[["a"], 1, 2]],
    [[[{ k: 1 }], 1]],
    [[[-1], 1]],
    [[[1.5], 1]],
    [[["__proto__"], {}]],
    [[["a"], { constructor: 1 }]],
    [[[], 5]],
    [[[]]],
    [[["deep"], JSON.parse(`${"[".repeat(40)}${"]".repeat(40)}`)]],
  ];
  for (const data of refused) {
    assert.ok(!Array.isArray(readPatch(data)), JSON.stringify(data).slice(0, 80));
  }
});

/** The state an op setting `value` at `path` builds from an empty one. */
const built = (path: PatchSegment[], value: JsonValue): JsonValue => {
  let state = value;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    state = { [String(path[i])]: state };
  }
  return state;
};

test("a patch may nest exactly as deep as a whole state may", () => {
  for (let length = MAX_STATE_DEPTH - 2; length <= MAX_STATE_DEPTH + 1; length += 1) {
    const path = Array.from({ length }, (_, i) => `k${i}`);
    const values: JsonValue[] = [1, {}, { inner: [] }];
    for (const value of values) {
      const state = built(path, value);
      assert.equal(
        Array.isArray(readPatch([[path, value]])),
        findStructuralIssue(state) === null,
        `a ${length}-key path to ${JSON.stringify(value)}`,
      );
    }
  }
});
