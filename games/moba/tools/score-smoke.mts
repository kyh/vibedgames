import assert from "node:assert/strict";
import { test } from "node:test";

import { readSoundscape, ScoreClock, scoreStep, SCORE_STEP_SECONDS } from "../src/render/score.ts";
import type { ScoreMode } from "../src/render/score.ts";
import { createWorld, spawnCreepAt, spawnHero } from "../src/sim/world.ts";

test("soundscape follows local accepted combat, not idle proximity or distant lanes", () => {
  const world = createWorld(808);
  world.now = 10000;
  const me = spawnHero(world, "ironvow", "radiant", "me", false, 0);
  const enemy = spawnHero(world, "emberhex", "dire", "enemy", false, 0);
  assert.ok(me.hero);
  me.x = enemy.x = 1500;
  me.y = enemy.y = 1500;
  assert.equal(readSoundscape(world, me.id).kind, "quiet");
  enemy.pendingAttack = { targetId: me.id, resolveAt: 10200 };
  assert.equal(readSoundscape(world, me.id).kind, "battle");
  enemy.x += 1000;
  assert.equal(readSoundscape(world, me.id).kind, "quiet");
  me.hero.recentDamageFrom[enemy.id] = 9999;
  assert.equal(readSoundscape(world, me.id).kind, "battle");
  world.now += 1500;
  assert.equal(readSoundscape(world, me.id).kind, "quiet");
  const creep = spawnCreepAt(world, "dire", "top", "melee", me.x + 50, me.y);
  creep.pendingAttack = { targetId: me.id, resolveAt: world.now + 200 };
  assert.equal(readSoundscape(world, me.id).kind, "skirmish");
  me.alive = false;
  assert.equal(readSoundscape(world, me.id).kind, "fallen");
  assert.equal(readSoundscape(world, "missing").kind, "silent");
  world.phase = "ended";
  assert.equal(readSoundscape(world, "missing").kind, "ended");
});

test("the score reads without changing simulation state or random state", () => {
  const world = createWorld(19);
  const me = spawnHero(world, "ironvow", "radiant", "me", false, 0);
  const before = JSON.stringify({
    ...world,
    units: [...world.units],
    projectiles: [...world.projectiles],
  });
  for (let i = 0; i < 100; i++) readSoundscape(world, me.id);
  assert.equal(
    JSON.stringify({ ...world, units: [...world.units], projectiles: [...world.projectiles] }),
    before,
  );
});

test("fixed D-Dorian form, bounded recipes and sparse exploration", () => {
  const modes: ScoreMode[] = ["quiet", "skirmish", "battle", "fallen"];
  const pitches = new Set([0, 2, 4, 5, 7, 9, 11]);
  const totals = { quiet: 0, skirmish: 0, battle: 0, fallen: 0 };
  for (const mode of modes) {
    for (let step = 0; step < 64; step++) {
      const recipe = scoreStep(step, mode, true);
      assert.deepEqual(recipe, scoreStep(step, mode, true));
      assert.ok(recipe.music.length <= 3 && recipe.ambience.length <= 2);
      totals[mode] += recipe.music.length;
      if (mode !== "quiet") assert.equal(recipe.ambience.length, 0);
      for (const note of [...recipe.music, ...recipe.ambience]) {
        assert.ok(note.gain > 0 && note.gain <= 0.032);
        assert.ok(note.attack > 0 && note.release > 0 && note.attack + note.release <= note.dur);
        assert.ok(note.at >= 0 && note.at <= 0.035);
        if (note.kind === "score-tone" && note.voice !== "drum") {
          const pitch = Math.round(69 + 12 * Math.log2(note.freq / 440));
          assert.ok(pitches.has(pitch % 12));
        }
      }
    }
  }
  assert.ok(
    totals.fallen < totals.quiet &&
      totals.quiet < totals.skirmish &&
      totals.skirmish < totals.battle,
  );
});

test("repeated snapshots, locked sound and clock jumps never queue catch-up beats", () => {
  const clock = new ScoreClock();
  assert.equal(clock.observe({ kind: "quiet", time: 0, water: false }, false), null);
  assert.equal(clock.observe({ kind: "quiet", time: 0, water: false }, true), null);
  const next = clock.observe(
    { kind: "quiet", time: SCORE_STEP_SECONDS * 2 + 0.00001, water: false },
    true,
  );
  assert.equal(next?.step, 2);
  for (let i = 0; i < 100; i++)
    assert.equal(
      clock.observe({ kind: "quiet", time: SCORE_STEP_SECONDS * 2 + 0.00001, water: false }, true),
      null,
    );
  assert.equal(
    clock.observe({ kind: "quiet", time: SCORE_STEP_SECONDS * 320 + 0.00001, water: true }, true)
      ?.step,
    320,
  );
  assert.equal(clock.observe({ kind: "quiet", time: 0, water: false }, true)?.step, 0);
  assert.equal(clock.observe({ kind: "ended", time: 1 }, true), null);
  assert.equal(clock.mode, "silent");
  clock.reset();
  assert.deepEqual(clock.diagnostics(), { mode: "silent", step: -1 });
});

test("combat hold relaxes through skirmish; death clears the old encounter", () => {
  const clock = new ScoreClock();
  clock.observe({ kind: "battle", time: 0, water: false }, true);
  clock.observe({ kind: "quiet", time: 3, water: false }, true);
  assert.equal(clock.mode, "battle");
  clock.observe({ kind: "quiet", time: 4.5, water: false }, true);
  assert.equal(clock.mode, "skirmish");
  clock.observe({ kind: "quiet", time: 6, water: false }, true);
  assert.equal(clock.mode, "quiet");
  clock.observe({ kind: "battle", time: 7, water: false }, true);
  clock.observe({ kind: "fallen", time: 8, water: false }, true);
  assert.equal(clock.mode, "fallen");
  clock.observe({ kind: "quiet", time: 9, water: false }, true);
  assert.equal(clock.mode, "quiet");
});
