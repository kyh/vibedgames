import assert from "node:assert/strict";
import { test } from "node:test";

import { HEROES, valAt } from "../src/data/heroes.ts";
import type { AbilityKey } from "../src/data/heroes.ts";
import { XP_CURVE, MAX_LEVEL } from "../src/data/config.ts";
import {
  abilityExplanation,
  abilityUpgrade,
  experienceProgress,
  killFeedText,
} from "../src/render/hud-presentation.ts";
import { levelAbility } from "../src/sim/abilities.ts";
import { dealDamage } from "../src/sim/combat.ts";
import { createWorld, spawnHero } from "../src/sim/world.ts";

const keys: AbilityKey[] = ["Q", "W", "E", "R"];

for (const definition of HEROES) {
  test(`${definition.name}: upgrade presentation agrees with the real spending rule`, () => {
    const unit = spawnHero(createWorld(202), definition.id, "radiant", "local", false, 0);
    assert.ok(unit.hero);
    for (const key of keys) {
      for (let level = 1; level <= MAX_LEVEL; level++) {
        for (let rank = 0; rank <= definition.abilities[key].maxRank; rank++) {
          for (const points of [0, 1]) {
            unit.hero.level = level;
            unit.hero.abilities[key].rank = rank;
            unit.hero.abilityPoints = points;
            const before = JSON.stringify(unit);
            const shown = abilityUpgrade(unit.hero, key);
            assert.equal(JSON.stringify(unit), before, "Inspecting cannot mutate the hero");
            const accepted = levelAbility(unit, key);
            assert.equal(
              shown.kind === "available",
              accepted,
              `${key} level${level} rank${rank} points${points}`,
            );
            assert.equal(unit.hero.abilityPoints, points - Number(accepted));
            assert.equal(unit.hero.abilities[key].rank, rank + Number(accepted));
            if (shown.kind === "level") {
              unit.hero.abilityPoints = 1;
              unit.hero.level = shown.level - 1;
              assert.equal(
                levelAbility(unit, key),
                false,
                "Unlock copy cannot promise an early rank",
              );
              unit.hero.level = shown.level;
              assert.equal(levelAbility(unit, key), true, "Advertised unlock level must accept");
            }
          }
        }
      }
    }
  });
}

test("all24 descriptions and rank previews come from the existing kit data", () => {
  for (const definition of HEROES) {
    const unit = spawnHero(createWorld(202), definition.id, "radiant", "local", false, 0);
    assert.ok(unit.hero);
    for (const key of keys) {
      const def = definition.abilities[key];
      for (let rank = 0; rank <= def.maxRank; rank++) {
        unit.hero.abilities[key].rank = rank;
        const text = abilityExplanation(unit.hero, key);
        assert.ok(text);
        assert.equal(text.description, def.desc);
        assert.equal(text.name, `${key} · ${def.name}`);
        assert.ok(text.rank.includes(rank ? `Rank ${rank}/${def.maxRank}` : "Rank 1 preview"));
        if (def.targeting === "passive") assert.equal(text.costs, "No cast or mana cost");
        else {
          assert.ok(text.costs.includes(`${valAt(def.manaCost, Math.max(1, rank))} mana`));
          assert.ok(text.costs.includes(`${valAt(def.cooldown, Math.max(1, rank))}s cooldown`));
        }
      }
    }
  }
});

test("XP strip uses cumulative level thresholds and clamps only presentation", () => {
  const unit = spawnHero(createWorld(202), "ironvow", "radiant", "local", false, 0);
  assert.ok(unit.hero);
  for (let level = 1; level < MAX_LEVEL; level++) {
    const floor = XP_CURVE[level - 1];
    const next = XP_CURVE[level];
    assert.ok(floor !== undefined && next !== undefined);
    unit.hero.level = level;
    unit.hero.xp = floor;
    assert.deepEqual(experienceProgress(unit.hero), {
      fraction: 0,
      text: `0 / ${next - floor} XP`,
    });
    unit.hero.xp = floor + (next - floor) / 2;
    assert.equal(experienceProgress(unit.hero).fraction, 0.5);
    unit.hero.xp = next + 100;
    assert.equal(experienceProgress(unit.hero).fraction, 1);
    assert.equal(unit.hero.xp, next + 100);
    unit.hero.xp = floor - 1;
    assert.equal(experienceProgress(unit.hero).fraction, 0);
  }
  unit.hero.level = MAX_LEVEL;
  assert.deepEqual(experienceProgress(unit.hero), { fraction: 1, text: "MAX LEVEL" });
});

test("actual mirrored-hero and environmental kill events identify the fallen side", () => {
  for (const team of ["radiant", "dire"] satisfies ("radiant" | "dire")[]) {
    const enemyTeam = team === "radiant" ? "dire" : "radiant";
    for (const environmental of [false, true]) {
      const world = createWorld(202);
      const killer = spawnHero(world, "ironvow", team, "killer", false, 0);
      const victim = spawnHero(world, "ironvow", enemyTeam, "victim", false, 0);
      dealDamage(world, environmental ? null : killer, victim, victim.maxHp * 10, "pure", {});
      const event = world.fx.find((fx) => fx.t === "kill");
      assert.ok(event?.t === "kill");
      assert.equal(
        killFeedText(event, team),
        environmental
          ? `Enemy ${event.victim} has fallen`
          : `Ally ${event.killer} → Enemy ${event.victim}`,
      );
      assert.ok(killFeedText(event, enemyTeam).includes(`Ally ${event.victim}`));
      assert.ok(
        killFeedText(event, null).includes(
          `${enemyTeam === "dire" ? "Dire" : "Radiant"} ${event.victim}`,
        ),
      );
    }
  }
});
