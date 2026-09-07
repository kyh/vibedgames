import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { HEROES } from "../src/data/heroes.ts";
import { castAbility, breakChannel } from "../src/sim/abilities.ts";
import { createWorld, spawnHero } from "../src/sim/world.ts";
import { spellPose } from "../src/render/spell-pose.ts";
import { parseCastActor } from "../src/net/cast-actor.ts";
import { sharedFxBatch } from "../src/net/snapshot.ts";
import { abilityNotes, abilityFoley } from "../src/render/ability-sound.ts";
import { attackRecoveryFrame } from "../src/render/attack-pose.ts";

// Contact cells inspected in the original sheets, not inferred from clip length.
const contactFrames = new Map([
  ["warrior", [6, 3]],
  ["pawn", [6, 3]],
  ["archer", [7, 6]],
  ["torch", [6, 3]],
  ["tnt", [6, 2]],
  ["barrel", [3, 2]],
]);

// Execute the real render admission method without constructing WebGL.
const source = readFileSync(new URL("../src/render/view.ts", import.meta.url), "utf8");
const start = source.indexOf("  private admitSpellCues(");
const end = source.indexOf("  private syncUnits(", start);
assert.ok(start > 0 && end > start);
const View = new Function(
  `${stripTypeScriptTypes(`class View {${source.slice(start, end)}}`)}; return View;`,
)();
const recipes = new Set();
let active = 0;
for (const hero of HEROES) {
  for (const def of Object.values(hero.abilities)) {
    const world = createWorld(718);
    world.now = 2000;
    const caster = spawnHero(world, hero.id, "radiant", "you", false, 0);
    const enemy = spawnHero(world, "ironvow", "dire", "target", false, 0);
    enemy.x = caster.x + 40;
    enemy.y = caster.y;
    caster.hero.abilities[def.key].rank = 1;
    caster.mp = 1000;
    world.fx = [];
    const input = { key: def.key, point: { x: enemy.x, y: enemy.y }, targetId: enemy.id };
    if (def.targeting === "passive") {
      assert.equal(castAbility(world, caster, input), false);
      assert.equal(world.fx.length, 0);
      continue;
    }
    active++;
    assert.equal(castAbility(world, caster, input), true, def.effect);
    const accepted = world.fx.find((fx) => fx.t === "cast");
    assert.deepEqual(accepted.actor, { unitId: caster.id, at: world.now });
    const before = structuredClone(world);
    const cue = { effect: def.effect, at: world.now, facing: caster.facing };
    const release = spellPose(cue, caster.hero.channel, world.now, caster.facing);
    assert.ok(release, def.effect);
    if (release.frame !== null) {
      const [count, contact] = contactFrames.get(hero.sheet);
      assert.equal(
        attackRecoveryFrame(release.frame, `u-${hero.sheet}-blue-attack`, count),
        contact,
        `${def.effect} must show its actual release immediately, never pre-damage wind-up`,
      );
    }
    assert.equal(spellPose(cue, null, world.now - 1, 1), null, "no invented anticipation");
    assert.equal(spellPose(cue, null, world.now + 450, 1), null, "finite recovery");
    assert.deepEqual(world, before, "rendering cannot mutate accepted combat");
    const notes = abilityNotes(def.effect);
    assert.ok(notes.length >= 2 && notes.length <= 3);
    assert.ok(abilityFoley(def.effect));
    recipes.add(JSON.stringify(notes));

    const view = new View();
    const body = { spellCue: null, lastCast: null };
    view.units = new Map([[caster.id, body]]);
    view.admitSpellCues(world);
    assert.deepEqual(body.spellCue, cue);
    const sameCue = body.spellCue;
    view.admitSpellCues(world);
    assert.equal(body.spellCue, sameCue, "duplicate snapshot cannot restart gesture");
    body.spellCue = null;
    view.admitSpellCues(world);
    assert.equal(body.spellCue, null, "expired cue cannot replay from repeated batch");
    body.lastCast = { at: world.now + 1, effect: "newer" };
    view.admitSpellCues(world);
    assert.equal(body.spellCue, null, "older cast cannot return after newer recovery ended");
    body.lastCast = null;
    world.now += 451;
    view.admitSpellCues(world);
    assert.equal(body.spellCue, null, "stale batch cannot animate");
    world.now = 1999;
    view.admitSpellCues(world);
    assert.equal(body.spellCue, null, "future batch cannot animate");
    world.now = 2000;
    caster.alive = false;
    view.admitSpellCues(world);
    assert.equal(body.spellCue, null, "dead body cannot cast");
    caster.alive = true;
    world.fx = [];
    assert.equal(castAbility(world, caster, input), false, "cooldown rejection");
    assert.equal(world.fx.length, 0, "rejected input emits no cast cue");
    if (caster.hero.channel) {
      assert.ok(spellPose(null, caster.hero.channel, world.now + 500, 1));
      breakChannel(world, caster);
      assert.equal(spellPose(cue, caster.hero.channel, world.now, 1), null);
    }
  }
}
assert.equal(active, 22);
assert.equal(recipes.size, active, "all active spells have distinct recipes");
for (const bad of [
  undefined,
  null,
  {},
  { unitId: "", at: 1 },
  { unitId: "u", at: NaN },
  { unitId: "u", at: -1 },
  { unitId: 4, at: 1 },
])
  assert.equal(parseCastActor(bad), null);
assert.equal(spellPose(null, { effect: "stormcaller:R", until: Infinity }, NaN, 1), null);
console.log(
  "✓ 22 real accepted casts: unique sound, body release, duplicate/stale/dead/rejected fences, channel cancellation",
);

for (const actor of [undefined, { unitId: "you", at: -1 }, { unitId: 1, at: 1 }]) {
  const batch = sharedFxBatch({
    fx: [{ t: "cast", x: 1, y: 1, effect: "ironvow:Q", team: "radiant", actor }],
  });
  assert.equal(batch[0].actor, undefined, "wire boundary discards malformed actor extension");
}
