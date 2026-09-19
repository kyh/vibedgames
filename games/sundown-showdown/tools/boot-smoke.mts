// Pure-data checks: the brawler roster, the seeded PRNG and the numeric
// helpers the sim relies on. No DOM, no three.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BRAWLERS, DIFFICULTIES, QUALITIES, TUNING, isBrawlerId } from "../src/config.ts";
import { clamp, damp, lerp, seededRandom, smoothstep } from "../src/utils.ts";

test("four brawlers, each keyed by its own id with a super that outranges nothing absurd", () => {
  const ids = Object.keys(BRAWLERS);
  assert.equal(ids.length, 4);
  for (const id of ids) {
    assert.ok(isBrawlerId(id));
    const def = BRAWLERS[id];
    assert.equal(def.id, id);
    assert.ok(def.hp > 0);
    assert.ok(def.attack.range > 0 && def.super.range > 0);
  }
  assert.ok(!isBrawlerId("constructor"));
});

test("difficulty and quality tables expose every tier the settings panel lists", () => {
  assert.deepEqual(Object.keys(DIFFICULTIES), ["easy", "normal", "hard"]);
  assert.deepEqual(Object.keys(QUALITIES), ["low", "medium", "high", "ultra"]);
  assert.ok(TUNING.bots + 1 <= 8);
  assert.ok(TUNING.startHour < TUNING.endHour);
});

test("seededRandom is deterministic per seed and stays in [0, 1)", () => {
  const a = seededRandom(1234);
  const b = seededRandom(1234);
  const c = seededRandom(1235);
  const runA = Array.from({ length: 16 }, () => a());
  const runB = Array.from({ length: 16 }, () => b());
  const runC = Array.from({ length: 16 }, () => c());
  assert.deepEqual(runA, runB);
  assert.notDeepEqual(runA, runC);
  for (const value of runA) {
    assert.ok(value >= 0 && value < 1);
  }
});

test("clamp, lerp, smoothstep and damp hold their edges", () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-2, 0, 3), 0);
  assert.equal(clamp(1.5, 0, 3), 1.5);
  assert.equal(lerp(10, 20, 0.25), 12.5);
  assert.equal(smoothstep(0, 1, -1), 0);
  assert.equal(smoothstep(0, 1, 2), 1);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  assert.equal(damp(0, 1, 5, 0), 0);
  assert.ok(Math.abs(damp(0, 1, 5, 100) - 1) < 1e-9);
});
