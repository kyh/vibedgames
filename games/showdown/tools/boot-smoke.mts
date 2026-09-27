// Pure-data checks: the brawler roster, the seeded PRNG and the numeric
// helpers the sim relies on. No DOM, no three.js.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BRAWLERS, DIFFICULTIES, QUALITIES, TUNING, isBrawlerId } from "../src/config.ts";
import { clamp, damp, lerp, randIn, seededRandom, smoothstep } from "../src/utils.ts";

test("nine champions, each keyed by its own id with a super that outranges nothing absurd", () => {
  const ids = Object.keys(BRAWLERS);
  assert.equal(ids.length, 9);
  for (const id of ids) {
    assert.ok(isBrawlerId(id));
    const def = BRAWLERS[id];
    assert.equal(def.id, id);
    assert.ok(def.hp > 0);
    assert.ok(def.attack.range > 0 && def.super.range > 0);
  }
  assert.ok(!isBrawlerId("constructor"));
});

test("each difficulty tier is at least as dangerous as the one below it", () => {
  const { easy, normal, hard } = DIFFICULTIES;
  for (const [softer, tougher] of [
    [easy, normal],
    [normal, hard],
  ] as const) {
    assert.ok(tougher.damage > softer.damage);
    assert.ok(tougher.cadence < softer.cadence);
    assert.ok(tougher.react < softer.react);
    assert.ok(tougher.engage >= softer.engage);
    assert.ok(tougher.hunters >= softer.hunters);
    assert.ok(tougher.skill[0] > softer.skill[0] && tougher.skill[1] > softer.skill[1]);
  }
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

test("randIn scales the stream it is handed and draws exactly once", () => {
  const a = seededRandom(7);
  const b = seededRandom(7);
  const scaled = Array.from({ length: 8 }, () => randIn(a, -2, 6));
  const raw = Array.from({ length: 8 }, () => -2 + b() * 8);
  assert.deepEqual(scaled, raw);
});

// A match replays from its seed only while every sim draw comes off game.rng
// (tools/seed-smoke.mjs proves the replay in a browser). The bot brain is all
// sim, so an unseeded draw there is always a regression.
test("the bot brain draws only from the match's seeded stream", () => {
  const dir = path.resolve(import.meta.dirname, "../src/ai");
  for (const file of readdirSync(dir)) {
    const source = readFileSync(path.join(dir, file), "utf-8");
    assert.ok(!source.includes("Math.random"), `src/ai/${file} calls Math.random`);
    assert.ok(!/\brand\(/u.test(source), `src/ai/${file} calls the cosmetic rand()`);
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
