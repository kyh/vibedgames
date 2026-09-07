import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

import { enemyOf } from "../src/data/config.ts";
import type { Team } from "../src/data/config.ts";
import { ITEMS, MAX_ITEMS } from "../src/data/items.ts";
import { BASES } from "../src/data/map.ts";
import { objectiveGuidance, structureAnnouncement } from "../src/render/objective-guidance.ts";
import { levelAbility } from "../src/sim/abilities.ts";
import { dealDamage, updateStructureGating } from "../src/sim/combat.ts";
import { dist2 } from "../src/sim/math.ts";
import type { Unit, World } from "../src/sim/types.ts";
import { buyItem, createWorld, spawnHero } from "../src/sim/world.ts";

function fixture(team: Team = "radiant") {
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
      const { world, player, prefix } = fixture(team);
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
  const { world, player, prefix } = fixture();
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
  const { world, player } = fixture();
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
  const { world, player, prefix } = fixture();
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

test("actual collectFeed keeps event order, bounded feed, scene clock and existing local hit-stop", () => {
  const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
  const method = source.match(/^  private collectFeed\([^]*?^  }/m)?.[0];
  assert.ok(method);
  const js = stripTypeScriptTypes(`class Probe { ${method} }`);
  const Probe = new Function("structureAnnouncement", "dist2", `${js}; return Probe;`)(
    structureAnnouncement,
    dist2,
  );
  const receiver = new Probe();
  const { world, player, prefix } = fixture();
  const event = destroy(world, player, `${prefix}-top-t1`);
  world.fx = [
    { t: "kill", killer: "Ironvow", victim: "Emberhex", team: "radiant" },
    event,
    { t: "death", kind: "hero", unitId: "nearby", x: player.x, y: player.y },
  ];
  Object.assign(receiver, {
    world,
    player,
    time: { now: 456 },
    feed: [],
    online: false,
    hitStopUntil: 0,
  });
  receiver.collectFeed();
  assert.equal(receiver.feed[0].kind, "kill");
  assert.deepEqual(receiver.feed[1], {
    kind: "notify",
    ...structureAnnouncement(world, event, player.team),
    at: 456,
  });
  assert.equal(receiver.hitStopUntil, 566);
  receiver.online = true;
  receiver.hitStopUntil = 0;
  receiver.collectFeed();
  assert.equal(receiver.hitStopUntil, 0);
  for (let i = 0; i < 30; i++) receiver.collectFeed();
  assert.equal(receiver.feed.length, 40);
});
