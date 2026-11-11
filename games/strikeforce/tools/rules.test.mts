// The deathmatch rules, played headless: whole matches in milliseconds.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RULES,
  applyHit,
  applySelfReport,
  newMatch,
  standings,
  syncRoster,
  tick,
} from "../src/net/rules.ts";
import type { MatchState } from "../src/net/rules.ts";

/** Two players in a fresh match, live at `now`. */
interface Live {
  s: MatchState;
  now: number;
}

const live = (): Live => {
  const s = newMatch();
  syncRoster(s, ["p1"]);
  assert.deepEqual(tick(s, 0), []);
  assert.equal(s.phase, "warmup", "one player waits");
  syncRoster(s, ["p1", "p2"]);
  assert.deepEqual(tick(s, 1), [{ kind: "start", round: 1 }]);
  assert.equal(s.phase, "live");
  return { now: 1, s };
};

test("a second player starts the match; a leaver takes it back to warmup", () => {
  const { s, now } = live();
  assert.ok(
    [...s.roster.values()].every((f) => f.alive && f.life === 2),
    "everyone on a new life",
  );
  syncRoster(s, ["p1"]);
  tick(s, now + 1);
  assert.equal(s.phase, "warmup");
  assert.equal(s.ends, 0);
});

test("anyone may shoot anyone but themselves; the dead come back on a new life", () => {
  const { s, now } = live();
  assert.equal(applyHit(s, "p1", "p1", 50, false, now), null, "no self hits");
  const before = s.roster.get("p2")?.life ?? 0;
  const hit = applyHit(s, "p1", "p2", 120, true, now);
  assert.equal(hit?.hp, 0);
  assert.deepEqual(hit?.events, [{ head: true, killer: "p1", kind: "kill", victim: "p2" }]);
  assert.equal(s.roster.get("p1")?.kills, 1);
  assert.equal(s.roster.get("p2")?.deaths, 1);
  assert.equal(applyHit(s, "p1", "p2", 50, false, now), null, "the dead take no hits");
  tick(s, now + RULES.respawnMs - 1);
  assert.equal(s.roster.get("p2")?.alive, false, "not before the respawn");
  tick(s, now + RULES.respawnMs);
  const p2 = s.roster.get("p2");
  assert.equal(p2?.alive, true);
  assert.equal(p2?.hp, RULES.maxHp);
  assert.equal(p2?.life, before + 1);
});

test("a hit never heals and deals at most a rifle headshot", () => {
  const { s, now } = live();
  assert.equal(applyHit(s, "p1", "p2", 40, false, now)?.hp, 60);
  assert.equal(applyHit(s, "p1", "p2", -50, false, now)?.hp, 60);
  const fighter = s.roster.get("p1");
  assert.ok(fighter);
  fighter.hp = 500;
  assert.equal(applyHit(s, "p2", "p1", 9999, false, now)?.hp, 500 - RULES.maxHit);
});

test("self reports only lower health, and only for the life they belong to", () => {
  const { s, now } = live();
  const life = s.roster.get("p1")?.life ?? -1;
  applySelfReport(s, "p1", 150, life, now);
  assert.equal(s.roster.get("p1")?.hp, 100);
  applySelfReport(s, "p1", 40, life - 1, now);
  assert.equal(s.roster.get("p1")?.hp, 100, "a report from an earlier life is ignored");
  applySelfReport(s, "p1", 40, life, now);
  assert.equal(s.roster.get("p1")?.hp, 40);
  const events = applySelfReport(s, "p1", 0, life, now);
  assert.deepEqual(events, [{ head: false, killer: "", kind: "kill", victim: "p1" }]);
  assert.equal(s.roster.get("p2")?.kills, 0, "a barrel death credits nobody");
  // Back on a new life, the dead body's last report (0 hp, old life) cannot kill it.
  tick(s, now + RULES.respawnMs);
  applySelfReport(s, "p1", 0, life, now + RULES.respawnMs + 1);
  assert.equal(s.roster.get("p1")?.alive, true);
});

test("the kill limit ends it, then a fresh one starts on a full dock", () => {
  const { s } = live();
  let now = 10;
  for (let k = 0; k < RULES.kills; k += 1) {
    applyHit(s, "p1", "p2", 120, false, now);
    now += RULES.respawnMs;
    tick(s, now);
  }
  assert.equal(s.phase, "over");
  assert.equal(s.champ, "p1");
  assert.equal(applyHit(s, "p2", "p1", 120, false, now), null, "no fighting over the results");
  now += RULES.overMs;
  assert.deepEqual(tick(s, now), [{ kind: "start", round: 2 }], "the next match says so");
  assert.equal(s.phase, "live");
  assert.ok([...s.roster.values()].every((f) => f.kills === 0 && f.deaths === 0 && f.alive));
});

test("time runs out and the most kills wins", () => {
  const { s, now } = live();
  applyHit(s, "p2", "p1", 120, false, now);
  assert.deepEqual(tick(s, now + RULES.matchMs), [{ champ: "p2", kind: "end" }]);
});

test("results with nobody left wait in warmup", () => {
  const { s, now } = live();
  tick(s, now + RULES.matchMs);
  assert.equal(s.phase, "over");
  syncRoster(s, ["p1"]);
  assert.deepEqual(tick(s, now + RULES.matchMs + RULES.overMs), []);
  assert.equal(s.phase, "warmup");
});

test("a kill tie goes to fewer deaths, the same on the HUD as at the whistle", () => {
  const { s, now } = live();
  syncRoster(s, ["p1", "p2", "p3"]);
  applyHit(s, "p1", "p3", 120, false, now);
  applyHit(s, "p2", "p3", 0, false, now);
  const p1 = s.roster.get("p1");
  const p2 = s.roster.get("p2");
  assert.ok(p1 && p2);
  p2.kills = 1;
  p1.deaths = 2;
  assert.deepEqual(
    standings(s).map(([id]) => id),
    ["p2", "p1", "p3"],
  );
  assert.deepEqual(tick(s, now + RULES.matchMs), [{ champ: "p2", kind: "end" }]);
});
