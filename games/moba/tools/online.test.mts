import assert from "node:assert/strict";
import { test } from "node:test";

import { restoreHostState } from "../src/net/host-state.ts";
import { emptyGuestWorld, encodeWorld } from "../src/net/snapshot.ts";
import { createWorld, spawnHero, step } from "../src/sim/world.ts";

test("only an empty room seeds a match, retaining the renderer's world and maps", () => {
  const world = emptyGuestWorld();
  const { units } = world;
  const seats = restoreHostState(world, null);
  assert.equal(world.units, units);
  assert.deepEqual(encodeWorld(world), encodeWorld(createWorld(1234)));
  assert.deepEqual(seats, { picks: {}, seats: {} });
});

test("promotion retains the accepted clock, RNG, combat state and stable human seats", () => {
  const host = createWorld(93);
  const hero = spawnHero(host, "duskblade", "dire", "remaining", false, 2);
  const departed = spawnHero(host, "ironvow", "radiant", "previous-host", false, 1);
  spawnHero(host, "emberhex", "dire", "bot-dire-0", true, 0);
  assert.ok(hero.hero && departed.hero);
  hero.hp = 137;
  hero.hero.gold = 923;
  hero.hero.level = 4;
  hero.hero.kills = 3;
  hero.hero.items = ["boots"];
  hero.hero.abilities.Q.readyAt = 65_432;
  departed.alive = false;
  departed.hero.respawnAt = 80_000;
  host.now = 61_750;
  host.gameTime = 61.75;
  host.seq = 108;
  host.nextWaveAt = 90;
  host.waveCount = 3;
  host.campRespawnAt["held-camp"] = 145;
  const wire = structuredClone(encodeWorld(host));
  const guest = emptyGuestWorld();
  guest.fx.push({ t: "notify", text: "stale local effect", tone: "neutral" });
  const roster = restoreHostState(guest, wire);
  assert.deepEqual(encodeWorld(guest), wire);
  assert.deepEqual(roster, {
    picks: { "previous-host": "ironvow", remaining: "duskblade" },
    seats: {
      "previous-host": { slot: 1, team: "radiant" },
      remaining: { slot: 2, team: "dire" },
    },
  });
  assert.equal(guest.fx.length, 0);
});

test("an ended snapshot stays ended even when its final roster is empty", () => {
  const ended = createWorld(88);
  ended.phase = "ended";
  ended.winner = "dire";
  ended.gameTime = 1371;
  ended.units.clear();
  const guest = createWorld(1);
  const result = restoreHostState(guest, structuredClone(encodeWorld(ended)));
  assert.equal(guest.phase, "ended");
  assert.equal(guest.winner, "dire");
  assert.equal(guest.gameTime, 1371);
  assert.equal(guest.units.size, 0);
  assert.deepEqual(result, { picks: {}, seats: {} });
});

test("promotion resumes the same deterministic simulation instead of resetting it", () => {
  const host = createWorld(987);
  spawnHero(host, "ironvow", "radiant", "a", true, 0);
  spawnHero(host, "emberhex", "dire", "b", true, 0);
  for (let i = 0; i < 180; i++) {
    step(host, 1 / 30);
  }
  const promoted = emptyGuestWorld();
  restoreHostState(promoted, structuredClone(encodeWorld(host)));
  host.fx.length = 0;
  for (let i = 0; i < 180; i++) {
    step(host, 1 / 30);
    step(promoted, 1 / 30);
  }
  assert.deepEqual(encodeWorld(promoted), encodeWorld(host));
  assert.deepEqual(promoted.fx, host.fx);
});

test("a newer reconnect snapshot replaces stale local progress without changing its roster", () => {
  const stale = createWorld(7);
  spawnHero(stale, "ironvow", "radiant", "returning", false, 0);
  const current = createWorld(91);
  const hero = spawnHero(current, "brewkeeper", "dire", "returning", false, 2);
  assert.ok(hero.hero);
  hero.hero.gold = 712;
  current.gameTime = 300;
  current.now = 300_000;
  const snap = structuredClone(encodeWorld(current));
  restoreHostState(stale, snap);
  assert.deepEqual(encodeWorld(stale), snap);
  const roster = restoreHostState(stale, snap);
  assert.deepEqual(roster.seats.returning, { slot: 2, team: "dire" });
  assert.equal(roster.picks.returning, "brewkeeper");
  assert.equal(stale.units.get("h-returning")?.hero?.gold, 712);
});

test("host adoption owns its mutable state without rewriting the accepted snapshot", () => {
  const host = createWorld(34);
  spawnHero(host, "ironvow", "radiant", "a", true, 0);
  spawnHero(host, "emberhex", "dire", "b", true, 0);
  const accepted = structuredClone(encodeWorld(host));
  const before = structuredClone(accepted);
  const promoted = emptyGuestWorld();
  restoreHostState(promoted, accepted);
  for (let i = 0; i < 180; i++) {
    step(promoted, 1 / 30);
  }
  assert.deepEqual(accepted, before);
  assert.notDeepEqual(encodeWorld(promoted), before);
  restoreHostState(promoted, accepted);
  assert.deepEqual(encodeWorld(promoted), before);
});
