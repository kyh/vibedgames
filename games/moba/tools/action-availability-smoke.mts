import assert from "node:assert/strict";
import { test } from "node:test";

import { actionAvailability } from "../src/render/action-availability.ts";
import type { UnavailableReason } from "../src/render/action-availability.ts";
import { castAbility } from "../src/sim/abilities.ts";
import { createWorld, dashHero, spawnHero } from "../src/sim/world.ts";
import type { Status } from "../src/sim/types.ts";

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
