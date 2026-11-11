// The round rules, played headless: whole matches in milliseconds.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RULES,
  applyDefuse,
  applyHit,
  applyPlant,
  applySelfReport,
  defender,
  newMatch,
  syncRoster,
  tick,
} from "../src/net/rules.ts";
import type { Bodies, MatchState, Team } from "../src/net/rules.ts";

const SITES = [
  { x: 0, y: 0, z: 0 },
  { x: 40, y: 0, z: 0 },
];
const first = () => 0;

/** Two a side, round 1 live, everyone standing at the origin. */
interface Live {
  s: MatchState;
  now: number;
  bodies: Bodies;
}

const liveMatch = (): Live => {
  const s = newMatch();
  const ids = ["a1", "b1", "a2", "b2"];
  const bodies: Bodies = Object.fromEntries(ids.map((id) => [id, { x: 0, y: 0, z: 0 }]));
  syncRoster(s, ids, bodies);
  let now = 1000;
  tick(s, now, bodies, first);
  assert.equal(s.phase, "freeze");
  now += RULES.freezeMs;
  tick(s, now, bodies, first);
  assert.equal(s.phase, "live");
  return { bodies, now, s };
};

const idsOn = (s: MatchState, team: Team): string[] =>
  [...s.roster].filter(([, f]) => f.team === team).map(([id]) => id);

const wipe = (s: MatchState, team: Team, now: number, bodies: Bodies): void => {
  const shooter = idsOn(s, team === 0 ? 1 : 0)[0] ?? "";
  for (const id of idsOn(s, team)) {
    applyHit(s, shooter, id, 120, false, now, bodies);
  }
};

test("players split evenly; warmup waits for both sides", () => {
  const s = newMatch();
  syncRoster(s, ["p1"], {});
  tick(s, 0, {}, first);
  assert.equal(s.phase, "warmup");
  syncRoster(s, ["p1", "p2", "p3"], {});
  const teams = [...s.roster.values()].map((f) => f.team).toSorted();
  assert.deepEqual(teams, [0, 0, 1]);
  tick(s, 1, {}, first);
  assert.equal(s.phase, "freeze");
  assert.equal(s.round, 1);
  assert.equal(s.charge.state, "carried", "an attacker carries the charge");
  assert.equal(s.roster.get(s.charge.carrier)?.team, s.attack);
});

test("friendly fire is refused; a kill drops the charge where the carrier fell", () => {
  const { s, now, bodies } = liveMatch();
  const [a1, a2] = idsOn(s, s.attack);
  const [d1] = idsOn(s, defender(s));
  assert.equal(applyHit(s, a1 ?? "", a2 ?? "", 50, false, now, bodies), null);
  const { carrier } = s.charge;
  bodies[carrier] = { x: 5, y: 0, z: 7 };
  const hit = applyHit(s, d1 ?? "", carrier, 120, true, now, bodies);
  assert.equal(hit?.hp, 0);
  assert.deepEqual(hit?.events, [{ head: true, killer: d1, kind: "kill", victim: carrier }]);
  assert.equal(s.charge.state, "dropped");
  assert.deepEqual([s.charge.x, s.charge.z], [5, 7]);
  // The other attacker walks over it.
  const other = idsOn(s, s.attack).find((id) => id !== carrier) ?? "";
  bodies[other] = { x: 5.5, y: 0, z: 7 };
  tick(s, now + 10, bodies, first);
  assert.equal(s.charge.state, "carried");
  assert.equal(s.charge.carrier, other);
});

test("eliminating a side ends the round; time runs out for the attackers", () => {
  const { s, now, bodies } = liveMatch();
  wipe(s, defender(s), now, bodies);
  const events = tick(s, now + 1, bodies, first);
  assert.deepEqual(events, [{ kind: "round-end", why: "eliminated", winner: s.attack }]);
  assert.equal(s.phase, "post");

  const timed = liveMatch();
  const late = tick(timed.s, timed.now + RULES.roundMs, timed.bodies, first);
  assert.deepEqual(late, [{ kind: "round-end", why: "time", winner: defender(timed.s) }]);
});

test("plant needs the carrier on a site; then detonate or defuse", () => {
  const { s, now, bodies } = liveMatch();
  const { carrier } = s.charge;
  bodies[carrier] = { x: 20, y: 0, z: 0 };
  assert.deepEqual(applyPlant(s, carrier, 0, SITES, bodies, now), [], "off site");
  bodies[carrier] = { x: 39, y: 0, z: 1 };
  assert.deepEqual(applyPlant(s, carrier, 1, SITES, bodies, now), [
    { by: carrier, kind: "planted", site: 1 },
  ]);
  assert.equal(s.phase, "planted");
  // Every attacker down after the plant: the round goes on.
  wipe(s, s.attack, now, bodies);
  assert.deepEqual(tick(s, now + 1, bodies, first), []);
  // A defender too far away cannot defuse; one on the charge can.
  const [d1] = idsOn(s, defender(s));
  bodies[d1 ?? ""] = { x: 30, y: 0, z: 0 };
  assert.deepEqual(applyDefuse(s, d1 ?? "", bodies, now + 2), []);
  bodies[d1 ?? ""] = { x: 39.5, y: 0, z: 1 };
  const defused = applyDefuse(s, d1 ?? "", bodies, now + 2);
  assert.deepEqual(defused, [{ kind: "round-end", why: "defused", winner: defender(s) }]);

  const boom = liveMatch();
  const c = boom.s.charge.carrier;
  boom.bodies[c] = { x: 0, y: 0, z: 0 };
  applyPlant(boom.s, c, 0, SITES, boom.bodies, boom.now);
  const end = tick(boom.s, boom.now + RULES.chargeMs, boom.bodies, first);
  assert.deepEqual(end, [{ kind: "round-end", why: "detonated", winner: boom.s.attack }]);
  assert.equal(boom.s.charge.state, "detonated");
});

test("self reports only lower health, and only for the life they belong to", () => {
  const { s, now, bodies } = liveMatch();
  const [id = ""] = idsOn(s, 0);
  const life = s.roster.get(id)?.life ?? -1;
  applySelfReport(s, id, 150, life, now, bodies);
  assert.equal(s.roster.get(id)?.hp, 100);
  applySelfReport(s, id, 40, life - 1, now, bodies);
  assert.equal(s.roster.get(id)?.hp, 100, "a report from an earlier life is ignored");
  applySelfReport(s, id, 40, life, now, bodies);
  assert.equal(s.roster.get(id)?.hp, 40);
});

/** Two players in a fresh deathmatch, live. */
const liveDm = (): Live => {
  const s = newMatch("dm");
  const bodies: Bodies = { p1: { x: 0, y: 0, z: 0 }, p2: { x: 5, y: 0, z: 0 } };
  syncRoster(s, ["p1"], bodies);
  tick(s, 0, bodies, first);
  assert.equal(s.phase, "warmup", "one player waits");
  syncRoster(s, ["p1", "p2"], bodies);
  tick(s, 1, bodies, first);
  assert.equal(s.phase, "live");
  return { bodies, now: 1, s };
};

test("deathmatch: anyone may shoot anyone; the dead come back on a new life", () => {
  const { s, now, bodies } = liveDm();
  // Seat both on the same side: deathmatch ignores sides.
  for (const f of s.roster.values()) {
    f.team = 0;
  }
  const before = s.roster.get("p2")?.life ?? 0;
  const hit = applyHit(s, "p1", "p2", 120, true, now, bodies);
  assert.equal(hit?.hp, 0);
  assert.equal(s.roster.get("p1")?.kills, 1);
  assert.equal(s.roster.get("p2")?.alive, false);
  // The dead body still reports 0 hp for its old life: no second death.
  tick(s, now + RULES.dmRespawnMs, bodies, first);
  const p2 = s.roster.get("p2");
  assert.equal(p2?.alive, true);
  assert.equal(p2?.life, before + 1);
  applySelfReport(s, "p2", 0, before, now + RULES.dmRespawnMs + 1, bodies);
  assert.equal(s.roster.get("p2")?.alive, true, "a stale report cannot kill the new life");
});

test("deathmatch: the kill limit ends it, then a fresh one starts", () => {
  const { s, bodies } = liveDm();
  let now = 10;
  for (let k = 0; k < RULES.dmKills; k += 1) {
    applyHit(s, "p1", "p2", 120, false, now, bodies);
    now += RULES.dmRespawnMs;
    tick(s, now, bodies, first);
  }
  assert.equal(s.phase, "over");
  assert.equal(s.champ, "p1");
  now += RULES.overMs;
  tick(s, now, bodies, first);
  assert.equal(s.phase, "live");
  assert.ok([...s.roster.values()].every((f) => f.kills === 0 && f.alive));
});

test("deathmatch: time runs out and the most kills wins", () => {
  const { s, now, bodies } = liveDm();
  applyHit(s, "p2", "p1", 120, false, now, bodies);
  const events = tick(s, now + RULES.dmMs, bodies, first);
  assert.deepEqual(events, [{ champ: "p2", kind: "dm-end" }]);
});

test("sides swap at the half and the first team to five wins, then a new match starts", () => {
  const live = liveMatch();
  const { s, bodies } = live;
  let { now } = live;
  const firstAttack = s.attack;
  const winners: Team[] = [];
  let swapped = false;
  for (let guard = 0; guard < 40 && s.phase !== "over"; guard += 1) {
    // Gold wins every round, attacking or defending.
    wipe(s, 1, now, bodies);
    for (const e of tick(s, now, bodies, first)) {
      if (e.kind === "round-end") {
        winners.push(e.winner);
      }
      if (e.kind === "half") {
        swapped = true;
      }
    }
    if (s.phase === "post") {
      now += RULES.postMs;
      for (const e of tick(s, now, bodies, first)) {
        if (e.kind === "half") {
          swapped = true;
        }
      }
      now += RULES.freezeMs;
      tick(s, now, bodies, first);
    }
  }
  assert.deepEqual(winners, [0, 0, 0, 0, 0]);
  assert.equal(s.phase, "over");
  assert.ok(swapped || winners.length < RULES.half + 1, "the half came");
  assert.notEqual(s.attack, firstAttack, "the second half attacks the other way");
  now += RULES.overMs;
  tick(s, now, bodies, first);
  assert.deepEqual(s.score, [0, 0]);
  assert.equal(s.round, 1);
});

test("a side emptying out returns to warmup and takes the charge with it", () => {
  const { s, now, bodies } = liveMatch();
  const c = s.charge.carrier;
  bodies[c] = { x: 0, y: 0, z: 0 };
  applyPlant(s, c, 0, SITES, bodies, now);
  tick(s, now + RULES.chargeMs, bodies, first);
  assert.equal(s.charge.state, "detonated");
  syncRoster(s, idsOn(s, 0), bodies);
  tick(s, now + RULES.chargeMs + 1, bodies, first);
  assert.equal(s.phase, "warmup");
  assert.equal(s.charge.state, "none", "no detonation replays in warmup");
  assert.equal(s.last, null);
  assert.ok([...s.roster.values()].every((f) => f.alive));
});
