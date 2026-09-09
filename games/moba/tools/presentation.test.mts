// Pure presentation logic (render/* modules with no Phaser or DOM deps),
// checked against the real sim so HUD copy and cues can never disagree with
// what the simulation actually accepts. Run via `pnpm test`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_LEVEL, XP_CURVE, enemyOf } from "../src/data/config.ts";
import type { Team } from "../src/data/config.ts";
import { HEROES, valAt } from "../src/data/heroes.ts";
import type { AbilityKey } from "../src/data/heroes.ts";
import { ITEMS, MAX_ITEMS } from "../src/data/items.ts";
import { BASES } from "../src/data/map.ts";
import { sharedFxBatch } from "../src/net/snapshot.ts";
import { actionAvailability } from "../src/render/action-availability.ts";
import type { UnavailableReason } from "../src/render/action-availability.ts";
import { attackClipFrame, attackPose } from "../src/render/attack-pose.ts";
import { layoutHeroPlates } from "../src/render/combat-plates.ts";
import type { HeroPlate } from "../src/render/combat-plates.ts";
import {
  abilityExplanation,
  abilityUpgrade,
  experienceProgress,
  killFeedText,
} from "../src/render/hud-presentation.ts";
import { objectiveGuidance, structureAnnouncement } from "../src/render/objective-guidance.ts";
import {
  parsePresentationSettings,
  presentationSettings,
  setPresentationSettings,
  watchPresentationSettings,
} from "../src/render/presentation-settings.ts";
import { readSoundscape, ScoreClock, scoreStep, SCORE_STEP_SECONDS } from "../src/render/score.ts";
import type { ScoreMode } from "../src/render/score.ts";
import { spellPose } from "../src/render/spell-pose.ts";
import { castAbility, levelAbility } from "../src/sim/abilities.ts";
import {
  dealDamage,
  resolvePendingAttacks,
  tryAttack,
  updateStructureGating,
} from "../src/sim/combat.ts";
import type { Status, Unit, World } from "../src/sim/types.ts";
import { buyItem, createWorld, dashHero, spawnCreepAt, spawnHero, step } from "../src/sim/world.ts";

const KEYS: AbilityKey[] = ["Q", "W", "E", "R"];

// ---- action availability ---------------------------------------------------

function fixture(hero = "ironvow") {
  const world = createWorld(303);
  world.now = 5000;
  const unit = spawnHero(world, hero, "radiant", "local", false, 0);
  assert.ok(unit.hero);
  unit.hero.abilities.W.rank = 1;
  return { world, unit };
}

const cases: {
  name: string;
  statuses: Status[];
  cast: boolean;
  dash: boolean;
  reason?: UnavailableReason;
}[] = [
  { name: "ready", statuses: [], cast: true, dash: true },
  {
    name: "stun",
    statuses: [{ kind: "stun", until: 9000, sourceId: "enemy" }],
    cast: false,
    dash: false,
    reason: "stunned",
  },
  {
    name: "silence",
    statuses: [{ kind: "silence", until: 9000 }],
    cast: false,
    dash: true,
    reason: "silenced",
  },
  { name: "root", statuses: [{ kind: "root", until: 9000 }], cast: true, dash: true },
  {
    name: "taunt",
    statuses: [{ kind: "taunt", until: 9000, targetId: "enemy" }],
    cast: true,
    dash: true,
  },
  {
    name: "unstoppable stun retains the actual cast silence rule",
    statuses: [
      { kind: "stun", until: 9000, sourceId: "enemy" },
      { kind: "unstoppable", until: 9000 },
    ],
    cast: false,
    dash: true,
    reason: "stunned",
  },
  {
    name: "unstoppable silence",
    statuses: [
      { kind: "silence", until: 9000 },
      { kind: "unstoppable", until: 9000 },
    ],
    cast: false,
    dash: true,
    reason: "silenced",
  },
];

for (const scenario of cases) {
  test(`HUD availability agrees with real cast/dash: ${scenario.name}`, () => {
    const { world, unit } = fixture();
    unit.statuses = structuredClone(scenario.statuses);
    const before = JSON.stringify(unit);
    const ability = actionAvailability(unit, world.now, { kind: "ability", key: "W" });
    const dash = actionAvailability(unit, world.now, { kind: "dash" });
    assert.equal(JSON.stringify(unit), before, "Reading availability cannot mutate the unit");
    assert.equal(ability.kind === "available", scenario.cast);
    if (scenario.reason) assert.deepEqual(ability, { kind: "blocked", reason: scenario.reason });
    assert.equal(dash.kind === "available", scenario.dash);
    assert.equal(castAbility(world, unit, { key: "W" }), scenario.cast);
    dashHero(world, unit, 1, 0);
    assert.equal((unit.hero?.dashUntil ?? 0) > world.now, scenario.dash);
  });
}

test("dead, unlearned and passive abilities never advertise an active cast", () => {
  const { world, unit } = fixture();
  assert.ok(unit.hero);
  unit.alive = false;
  assert.deepEqual(actionAvailability(unit, world.now, { kind: "ability", key: "W" }), {
    kind: "blocked",
    reason: "dead",
  });
  assert.deepEqual(actionAvailability(unit, world.now, { kind: "dash" }), {
    kind: "blocked",
    reason: "dead",
  });
  assert.equal(castAbility(world, unit, { key: "W" }), false);
  dashHero(world, unit, 1, 0);
  assert.equal(unit.hero.dashUntil, 0);
  unit.alive = true;
  assert.deepEqual(actionAvailability(unit, world.now, { kind: "ability", key: "E" }), {
    kind: "blocked",
    reason: "unlearned",
  });
  unit.hero.abilities.E.rank = 1;
  assert.deepEqual(actionAvailability(unit, world.now, { kind: "ability", key: "E" }), {
    kind: "blocked",
    reason: "passive",
  });
  assert.equal(castAbility(world, unit, { key: "E" }), false);
});

test("cooldowns remain unavailable through the last millisecond and mana remains separate", () => {
  const { world, unit } = fixture();
  assert.ok(unit.hero);
  unit.hero.abilities.W.readyAt = world.now + 1;
  unit.hero.dashReadyAt = world.now + 1;
  assert.deepEqual(actionAvailability(unit, world.now, { kind: "ability", key: "W" }), {
    kind: "blocked",
    reason: "cooldown",
  });
  assert.deepEqual(actionAvailability(unit, world.now, { kind: "dash" }), {
    kind: "blocked",
    reason: "cooldown",
  });
  assert.equal(castAbility(world, unit, { key: "W" }), false);
  dashHero(world, unit, 1, 0);
  assert.equal(unit.hero.dashUntil, 0);
  world.now += 1;
  assert.equal(actionAvailability(unit, world.now, { kind: "dash" }).kind, "available");
  unit.mp = 0;
  assert.deepEqual(actionAvailability(unit, world.now, { kind: "ability", key: "W" }), {
    kind: "blocked",
    reason: "mana",
  });
  assert.equal(castAbility(world, unit, { key: "W" }), false);
  unit.mp = unit.maxMp;
  assert.equal(
    actionAvailability(unit, world.now, { kind: "ability", key: "W" }).kind,
    "available",
  );
  assert.equal(castAbility(world, unit, { key: "W" }), true);
  dashHero(world, unit, 1, 0);
  assert.ok(unit.hero.dashUntil > world.now);
});

test("an actual channel permits another spell and a dash that cancels it", () => {
  const { world, unit } = fixture("stormcaller");
  assert.ok(unit.hero);
  unit.hero.level = 6;
  unit.hero.abilities.R.rank = 1;
  unit.hero.abilities.Q.rank = 1;
  unit.mp = 1000;
  const point = { x: unit.x + 100, y: unit.y };
  assert.equal(castAbility(world, unit, { key: "R", point }), true);
  assert.ok(unit.hero.channel);
  assert.equal(
    actionAvailability(unit, world.now, { kind: "ability", key: "Q" }).kind,
    "available",
  );
  assert.equal(actionAvailability(unit, world.now, { kind: "dash" }).kind, "available");
  assert.equal(castAbility(world, unit, { key: "Q", point }), true);
  assert.ok(unit.hero.channel, "The simulation allows this spell without cancelling its channel");
  dashHero(world, unit, 1, 0);
  assert.equal(unit.hero.channel, null);
  assert.ok(unit.hero.dashUntil > world.now);
});

// ---- HUD copy: upgrades, XP, kill feed --------------------------------------

for (const definition of HEROES) {
  test(`${definition.name}: upgrade presentation agrees with the real spending rule`, () => {
    const unit = spawnHero(createWorld(202), definition.id, "radiant", "local", false, 0);
    assert.ok(unit.hero);
    for (const key of KEYS) {
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
    for (const key of KEYS) {
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

// ---- objective guidance ------------------------------------------------------

function laneFixture(team: Team = "radiant") {
  const world = createWorld(482);
  const player = spawnHero(world, "ironvow", team, "local", false, 0);
  const prefix = enemyOf(team) === "radiant" ? "r" : "d";
  return { world, player, prefix };
}

function unit(world: World, id: string): Unit {
  const found = world.units.get(id);
  assert.ok(found, id);
  return found;
}

function destroy(world: World, player: Unit, id: string) {
  const victim = unit(world, id);
  assert.equal(
    victim.structure?.attackable,
    true,
    "fixture only destroys actually exposed structures",
  );
  world.fx.length = 0;
  dealDamage(world, player, victim, 1_000_000, "pure", {});
  assert.equal(victim.alive, false);
  updateStructureGating(world);
  const event = world.fx.find((fx) => fx.t === "structureDown");
  assert.ok(event);
  return event;
}

for (const team of ["radiant", "dire"] satisfies Team[]) {
  test(`${team}: both lanes follow actual damage and structure gates through the Ancient`, () => {
    for (const lane of ["top", "bot"]) {
      const { world, player, prefix } = laneFixture(team);
      const first = unit(world, `${prefix}-${lane}-t1`);
      player.x = first.x;
      player.y = first.y;
      const before = structuredClone(world);
      assert.equal(objectiveGuidance(world, player)?.targetId, first.id);
      assert.deepEqual(world, before, "reading guidance leaves all simulation state untouched");

      const outer = destroy(world, player, first.id);
      assert.equal(objectiveGuidance(world, player)?.targetId, `${prefix}-${lane}-t2`);
      const outerNotice = structureAnnouncement(world, outer, team);
      assert.match(outerNotice.text, lane === "top" ? /ENEMY TOP/ : /ENEMY BOTTOM/);
      assert.match(outerNotice.text, /INNER TOWER EXPOSED/);
      assert.equal(outerNotice.tone, "good");
      assert.equal(structureAnnouncement(world, outer, enemyOf(team)).tone, "bad");
      assert.equal(structureAnnouncement(world, outer, null).tone, "neutral");

      const inner = destroy(world, player, `${prefix}-${lane}-t2`);
      assert.equal(objectiveGuidance(world, player)?.lane, "base");
      assert.match(
        structureAnnouncement(world, inner, team).text,
        /LANE OPEN · BASE TOWERS EXPOSED/,
      );
      assert.equal(structureAnnouncement(world, inner, team).priority, "major");
      const otherLane = lane === "top" ? "bot" : "top";
      assert.equal(unit(world, `${prefix}-${otherLane}-t2`).alive, true, "one lane is sufficient");

      const base = destroy(world, player, `${prefix}-base-1`);
      assert.equal(objectiveGuidance(world, player)?.targetId, `${prefix}-base-2`);
      assert.match(objectiveGuidance(world, player)?.text ?? "", /LAST ENEMY BASE TOWER/);
      assert.doesNotMatch(structureAnnouncement(world, base, team).text, /ANCIENT EXPOSED/);
      const secondBase = destroy(world, player, `${prefix}-base-2`);
      assert.equal(objectiveGuidance(world, player)?.targetId, `${prefix}-ancient`);
      assert.match(structureAnnouncement(world, secondBase, team).text, /ANCIENT EXPOSED/);

      const ancient = destroy(world, player, `${prefix}-ancient`);
      assert.equal(world.winner, team);
      assert.equal(objectiveGuidance(world, player), null, "terminal match has no stale route");
      assert.equal(structureAnnouncement(world, ancient, team).priority, "ending");
    }
  });
}

test("route selection is stable across snapshot order and ignores protected/neutral structures", () => {
  const { world, player, prefix } = laneFixture();
  player.y = 1536;
  const before = objectiveGuidance(world, player);
  world.units = new Map([...world.units].toReversed());
  assert.deepEqual(objectiveGuidance(world, player), before);
  const ancient = unit(world, `${prefix}-ancient`);
  player.x = ancient.x;
  player.y = ancient.y;
  assert.notEqual(objectiveGuidance(world, player)?.targetId, ancient.id);
  ancient.neutral = true;
  if (ancient.structure) ancient.structure.attackable = true;
  assert.notEqual(objectiveGuidance(world, player)?.targetId, ancient.id);
  assert.equal(objectiveGuidance(world, undefined), null);
  assert.equal(objectiveGuidance(world, ancient), null, "unassigned spectator is not a hero");
});

test("respawn tip uses real upgrade eligibility, and only suggests shopping after return", () => {
  const { world, player } = laneFixture();
  assert.ok(player.hero);
  assert.equal(objectiveGuidance(world, player)?.respawnTip, null);
  player.alive = false;
  player.hero.respawnAt = world.now + 10_000;
  player.hero.abilityPoints = 1;
  assert.match(objectiveGuidance(world, player)?.respawnTip ?? "", /upgrade Q/);
  assert.equal(levelAbility(player, "Q"), true, "dead hero can actually spend this point");
  player.hero.abilities.W.rank = 1;
  player.hero.abilities.E.rank = 1;
  player.hero.abilityPoints = 1;
  player.hero.gold = 450;
  assert.equal(levelAbility(player, "R"), false, "level-one ultimate remains locked");
  assert.match(objectiveGuidance(world, player)?.respawnTip ?? "", /shop after respawning/);
  assert.equal(buyItem(world, player, "boots"), false, "tip must not promise shopping while dead");
  player.alive = true;
  player.x = BASES[player.team].fountain.x;
  player.y = BASES[player.team].fountain.y;
  assert.equal(buyItem(world, player, "boots"), true);
  player.alive = false;
  player.hero.gold = 450;
  assert.match(objectiveGuidance(world, player)?.respawnTip ?? "", /Return with your creeps/);
  player.hero.gold = 100_000;
  player.hero.items = ITEMS.slice(0, MAX_ITEMS).map((item) => item.id);
  assert.match(objectiveGuidance(world, player)?.respawnTip ?? "", /Return with your creeps/);
  const ownPrefix = player.team === "radiant" ? "r" : "d";
  for (const id of [`${ownPrefix}-base-1`, `${ownPrefix}-base-2`]) unit(world, id).alive = false;
  updateStructureGating(world);
  assert.match(objectiveGuidance(world, player)?.respawnTip ?? "", /Your Ancient is exposed/);
  player.hero.respawnAt = 0;
  assert.equal(objectiveGuidance(world, player)?.respawnTip, null);
});

test("unknown/stale structure events never invent a lane or a currently exposed target", () => {
  const { world, player, prefix } = laneFixture();
  const unknown = structureAnnouncement(
    world,
    { t: "structureDown", team: "dire", tier: "t1", x: -1, y: -1 },
    null,
  );
  assert.deepEqual(unknown, {
    text: "DIRE TOWER HAS FALLEN",
    tone: "neutral",
    priority: "objective",
  });
  const event = destroy(world, player, `${prefix}-top-t1`);
  destroy(world, player, `${prefix}-top-t2`);
  assert.doesNotMatch(structureAnnouncement(world, event, player.team).text, /INNER TOWER EXPOSED/);
});

// ---- score -------------------------------------------------------------------

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
  assert.equal(clock.mode, "silent");
  assert.equal(clock.step, -1);
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

// ---- attack pose -------------------------------------------------------------

test("attack pose follows the real wind-up, strike, recovery and repeated snapshots", () => {
  const world = createWorld(718);
  world.gameTime = 300;
  step(world);
  const attacker = [...world.units.values()].find((u) => u.neutral && u.creep?.boss);
  assert.ok(attacker, "real neutral boss must exist");
  const victim = spawnHero(world, "ironvow", "radiant", "target", false, 0);
  victim.x = attacker.x + 40;
  victim.y = attacker.y;
  world.now = 2000;
  tryAttack(world, attacker, victim);
  assert.ok(attacker.pendingAttack);
  const cue = {
    startedAt: attacker.lastAttackAt,
    resolveAt: attacker.pendingAttack.resolveAt,
    facing: attacker.facing,
  };
  const hp = victim.hp;
  const before = structuredClone(attacker);
  const anticipation = attackPose(cue, cue.resolveAt - 1);
  assert.ok(anticipation && anticipation.x < 0 && anticipation.angle < 0);
  assert.deepEqual(attacker, before, "presentation must not mutate combat state");
  world.now = cue.resolveAt - 1;
  resolvePendingAttacks(world);
  assert.equal(victim.hp, hp, "wind-up retains real damage deadline");
  world.now = cue.resolveAt;
  resolvePendingAttacks(world);
  assert.ok(victim.hp < hp, "real strike resolves at its original deadline");
  const strike = attackPose(cue, world.now);
  assert.ok(strike && strike.x > 0 && strike.angle > 0);
  assert.deepEqual(attackPose(cue, world.now), strike, "repeated snapshots keep the same pose");
  const left = attackPose({ ...cue, facing: -1 }, world.now);
  assert.ok(left && left.x === -strike.x && left.angle === -strike.angle);
  assert.equal(
    attackPose(cue, cue.resolveAt + 170),
    null,
    "recovery ends at the authored boundary",
  );
  for (const [key, count, contact] of [
    ["u-warrior-blue-attack", 6, 3],
    ["u-pawn-red-attack", 6, 3],
    ["u-archer-blue-attack", 7, 6],
    ["u-torch-red-attack", 6, 3],
    ["u-tnt-red-attack", 6, 2],
    ["u-barrel-blue-attack", 3, 2],
  ] satisfies [string, number, number][]) {
    const beforeContact = attackClipFrame(cue, cue.resolveAt - 1, key, count);
    assert.ok(beforeContact !== null && beforeContact < contact);
    assert.equal(attackClipFrame(cue, cue.resolveAt, key, count), contact, key);
    assert.equal(attackClipFrame(cue, cue.resolveAt + 169, key, count), count - 1);
    assert.equal(attackClipFrame(cue, cue.resolveAt + 170, key, count), null);
    assert.equal(attackClipFrame(cue, cue.startedAt - 1, key, count), null);
  }
});

// ---- spell pose + cast actor wire validation ---------------------------------

test("spell pose starts at the accepted cast, holds a brace only during a live channel", () => {
  const profile = spellPose({ effect: "ironvow:Q", at: 1000, facing: 1 }, null, 1050, 1);
  assert.ok(profile && profile.x > 0 && profile.frame !== null);
  assert.equal(spellPose({ effect: "ironvow:Q", at: 1000, facing: 1 }, null, 999, 1), null);
  assert.equal(spellPose({ effect: "ironvow:Q", at: 1000, facing: 1 }, null, 1240, 1), null);
  const mirrored = spellPose({ effect: "ironvow:Q", at: 1000, facing: -1 }, null, 1050, -1);
  assert.ok(mirrored && mirrored.x === -profile.x && mirrored.angle === -profile.angle);
  const channel = { effect: "stormcaller:R", until: 2000 };
  assert.ok(spellPose(null, channel, 1500, 1)?.frame === null);
  assert.equal(spellPose(null, channel, 2000, 1), null);
  assert.equal(spellPose({ effect: "unknown:X", at: 1000, facing: 1 }, null, 1050, 1), null);
});

test("malformed cast actors from older or hostile peers are stripped, valid ones kept", () => {
  const cast = { t: "cast", x: 1, y: 2, effect: "ironvow:Q", team: "radiant" };
  const batch = sharedFxBatch({
    fx: [
      { ...cast, actor: { unitId: "h-a", at: 1234 } },
      { ...cast, actor: { unitId: "", at: 1 } },
      { ...cast, actor: { unitId: "h-b", at: -1 } },
      { ...cast, actor: "h-c" },
      cast,
      { t: "bogus" },
    ],
  });
  assert.equal(batch.length, 5);
  assert.deepEqual(
    batch.map((event) => (event.t === "cast" ? (event.actor ?? null) : event.t)),
    [{ unitId: "h-a", at: 1234 }, null, null, null, null],
  );
});

// ---- combat plates -----------------------------------------------------------

test("hero plates keep the local anchor, separate crowds, and are order-stable", () => {
  const crowd: HeroPlate[] = [
    { id: "enemy", x: 100, y: 100, width: 76, height: 36, priority: "target" },
    { id: "ally", x: 108, y: 108, width: 86, height: 36, priority: "hero" },
    { id: "local", x: 100, y: 100, width: 64, height: 36, priority: "player" },
    { id: "distant", x: 320, y: 100, width: 76, height: 36, priority: "hero" },
  ];
  const before = structuredClone(crowd);
  const arranged = layoutHeroPlates(crowd);
  assert.deepEqual(crowd, before, "presentation must not mutate its source positions");
  assert.equal(arranged.find((p) => p.id === "local")?.lift, 0, "player keeps the primary anchor");
  assert.equal(arranged.find((p) => p.id === "distant")?.lift, 0, "unrelated labels stay put");
  for (const a of arranged) {
    for (const b of arranged) {
      if (a.id === b.id) continue;
      const overlap =
        Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y;
      assert.equal(overlap, false, `${a.id} obscures ${b.id}`);
    }
  }
  assert.deepEqual(
    layoutHeroPlates(crowd.toReversed()),
    arranged,
    "snapshot order cannot swap labels",
  );
  assert.deepEqual(layoutHeroPlates([]), [], "empty or ended stage leaves no stale labels");
});

// ---- presentation settings ---------------------------------------------------

test("presentation settings parse strictly, survive denied storage, and unsubscribe", () => {
  const defaults = { effects: "full", motion: "system", view: "standard" };
  for (const raw of [null, "bad json", "null", "true", "12", "[]", '"focused"', "{}"])
    assert.deepEqual(parsePresentationSettings(raw), defaults, `unsafe stored value: ${raw}`);
  assert.deepEqual(
    parsePresentationSettings('{"effects":"focused","motion":"reduced","view":"close"}'),
    { effects: "focused", motion: "reduced", view: "close" },
  );
  assert.deepEqual(
    parsePresentationSettings(
      '{"effects":"focused","motion":true,"view":"future-version","extra":1}',
    ),
    { effects: "focused", motion: "system", view: "standard" },
    "invalid fields fall back independently",
  );
  let changes = 0;
  const unwatch = watchPresentationSettings(() => changes++);
  // No window/storage in this Node process: memory and subscriptions still work.
  setPresentationSettings({ effects: "focused", motion: "system", view: "close" });
  assert.equal(presentationSettings().effects, "focused");
  assert.equal(changes, 1);
  unwatch();
  unwatch();
  setPresentationSettings({ effects: "full", motion: "reduced", view: "standard" });
  assert.equal(changes, 1, "a destroyed scene must not receive setting changes");
});
