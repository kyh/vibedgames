// Pure-logic checks for the presentation/HUD helpers: `pnpm --filter @repo/starfall test`.
import assert from "node:assert/strict";

import { BattleBeatDirector, waveBattleBeat } from "../src/render/battle-beat";
import type { BattleBeatInput } from "../src/render/battle-beat";
import { BossEncounters } from "../src/render/boss-encounters";
import type { BossObservation } from "../src/render/boss-encounters";
import {
  enemyChargeDuration,
  enemyChargeProgress,
  usesLockedAim,
} from "../src/render/charge-progress";
import { burstLifetime, burstStage, contactPoint, weaponLook } from "../src/render/combat-visuals";
import { spawnEnemyState, WEAPONS_SPECIAL } from "../src/shared/constants";
import type { EnemyKind } from "../src/shared/constants";
import { WeaponMastery } from "../src/shared/weapon-mastery";

// ---- charge progress ------------------------------------------------------------------

const windups: { kind: EnemyKind; ms: number }[] = [
  { kind: "drone", ms: 400 },
  { kind: "wasp", ms: 350 },
  { kind: "lancer", ms: 600 },
  { kind: "warden", ms: 700 },
  { kind: "sniper", ms: 900 },
  { kind: "spawner", ms: 650 },
];
for (const { kind, ms } of windups) {
  const enemy = spawnEnemyState(kind, 40, 80);
  enemy.telegraphUntil = 5000;
  const duration = enemyChargeDuration(enemy);
  assert.equal(duration, ms, kind);
  assert.equal(enemyChargeProgress(5000, 5000 - ms, duration), 0);
  assert.equal(enemyChargeProgress(5000, 5000 - ms / 2, duration), 0.5);
  assert.equal(enemyChargeProgress(5000, 5000, duration), 1);
  assert.equal(enemyChargeProgress(5000, 5001, duration), 1);
  assert.equal(enemyChargeProgress(5000, 2000, duration), 0);
}
const boss = spawnEnemyState("dreadnought", 0, 0);
boss.maxHp = 14_000;
boss.hp = 14_000;
assert.equal(enemyChargeDuration(boss), 600);
boss.hp = 7000;
assert.equal(enemyChargeDuration(boss), 1100);
assert.equal(usesLockedAim(boss), true);
boss.hp = 1000;
assert.equal(enemyChargeDuration(boss), 700);
assert.equal(usesLockedAim(boss), false);
console.log("PASS charge windups per enemy kind and boss phase");

// ---- combat visuals -------------------------------------------------------------------

const tail = { x: 0, y: 0 };
const head = { x: 1000, y: 0 };
const target = { x: 200, y: 0 };
assert.deepEqual(
  contactPoint(tail, head, target, 20, false),
  { x: 180, y: 0 },
  "pierce lands at the hull",
);
assert.deepEqual(
  contactPoint(tail, tail, target, 20, true),
  { x: 180, y: 0 },
  "AoE lands at the near surface",
);
assert.deepEqual(
  contactPoint(tail, tail, target, 20, false),
  tail,
  "zero-length segment stays finite",
);
const graze = contactPoint(tail, { x: 1000, y: 21 }, target, 0, false);
assert.ok(
  Math.abs(graze.x - 199.9) < 0.1 && Math.abs(graze.y - 4.2) < 0.1,
  "graze projects onto the segment",
);
assert.deepEqual(
  [tail, head, target],
  [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 200, y: 0 },
  ],
);

assert.equal(burstStage(139, 140, 1000), 0);
assert.equal(burstStage(140, 140, 1000), 1);
assert.equal(burstStage(640, 140, 1000), 0.5);
assert.equal(burstStage(1140, 140, 1000), 0);
for (const delay of [0, 140, 280]) {
  assert.equal(burstStage(burstLifetime("boss"), delay, 1000), 0);
}
const looks = new Set(WEAPONS_SPECIAL.map(weaponLook));
for (const look of [
  "rapid",
  "heavy",
  "laser",
  "rail",
  "scatter",
  "missile",
  "plasma",
  "drill",
  "glaive",
  "arc",
  "orb",
  "nova",
  "mine",
] as const) {
  assert.ok(looks.has(look), look);
}
console.log("PASS contact points, blast stages and weapon looks");

// ---- boss encounters ------------------------------------------------------------------

const seen = (id: string, hp = 1000, maxHp = 1000): BossObservation => ({
  hp,
  id,
  kind: "dreadnought",
  maxHp,
});
for (const initial of [[], [seen("a")], [seen("a", 500)], [seen("a", 0)]]) {
  const fresh = new BossEncounters();
  assert.deepEqual(
    fresh.observe(100, initial),
    [],
    "first snapshot of an epoch is a silent baseline",
  );
  assert.deepEqual(fresh.observe(100, initial), []);
}
const encounters = new BossEncounters();
encounters.observe(100, []);
assert.deepEqual(encounters.observe(100, [seen("a")]), [{ id: "a", kind: "arrival", phase: 1 }]);
assert.deepEqual(encounters.observe(100, [seen("a", 661)]), []);
assert.deepEqual(encounters.observe(100, [seen("a", 660)]), [{ id: "a", kind: "phase", phase: 2 }]);
for (const hp of [660, 900, 500, 331]) {
  assert.deepEqual(encounters.observe(100, [seen("a", hp)]), []);
}
assert.deepEqual(encounters.observe(100, [seen("a", 330)]), [{ id: "a", kind: "phase", phase: 3 }]);
assert.deepEqual(
  encounters.observe(100, [seen("a", 0)]),
  [],
  "a dead lingering boss is not yet a defeat",
);
assert.deepEqual(encounters.observe(100, []), [{ id: "a", kind: "defeat" }]);
assert.deepEqual(encounters.observe(100, []), []);
assert.deepEqual(encounters.observe(100, [seen("b", 500)]), [
  { id: "b", kind: "arrival", phase: 2 },
]);
assert.deepEqual(encounters.observe(100, [seen("b", 500), seen("b", 100)]), [
  { id: "b", kind: "phase", phase: 3 },
]);
assert.deepEqual(encounters.observe(200, [seen("b", 100)]), [], "epoch change rebaselines");
assert.deepEqual(encounters.observe(200, []), [{ id: "b", kind: "defeat" }]);
assert.deepEqual(encounters.observe(Number.NaN, [seen("c")]), []);
assert.deepEqual(encounters.observe(200, [{ ...seen("c"), kind: "lancer" }]), []);
encounters.reset();
assert.deepEqual(encounters.observe(200, [seen("d")]), []);
console.log("PASS boss arrival / phase / defeat edges, baselines and epoch changes");

// ---- battle beat ----------------------------------------------------------------------

const epoch = 10_000;
const frame = (t: number, overrides: Partial<BattleBeatInput> = {}): BattleBeatInput => ({
  bossAlive: false,
  epoch,
  now: epoch + t,
  presenting: true,
  ...overrides,
});
assert.equal(waveBattleBeat(0), "quiet");
assert.equal(waveBattleBeat(22.5), "crest");
assert.equal(waveBattleBeat(45), "crest");
assert.equal(waveBattleBeat(90), "quiet");
assert.equal(waveBattleBeat(-2), "quiet");
assert.equal(waveBattleBeat(Number.NaN), "quiet");
for (const trough of [1080, 2160, 3600]) {
  assert.equal(waveBattleBeat(trough), "quiet");
  assert.equal(waveBattleBeat(trough + 22.5), "crest");
}

const smooth = new BattleBeatDirector();
let prior = smooth.update(frame(0));
let candidateSince = -1;
for (let t = 100; t <= 25_000; t += 100) {
  const mood = waveBattleBeat(t / 1000);
  if (mood !== prior && candidateSince < 0) {
    candidateSince = t;
  }
  const beat = smooth.update(frame(t));
  if (beat !== prior) {
    assert.ok(t - candidateSince >= 700, "beat changes only after 700ms of the new mood");
    candidateSince = -1;
  }
  assert.equal(smooth.update(frame(t)), beat, "same-time reads are idempotent");
  prior = beat;
}
assert.equal(prior, "crest");

const encounter = new BattleBeatDirector();
encounter.update(frame(0));
assert.equal(
  encounter.update(frame(10, { bossAlive: true })),
  "crest",
  "a live boss is always a crest",
);
encounter.bossDefeated(epoch + 40, epoch);
assert.equal(encounter.update(frame(40)), "aftermath");
for (let t = 1040; t < 6040; t += 1000) {
  assert.equal(encounter.update(frame(t)), "aftermath");
}
assert.equal(encounter.update(frame(6039)), "aftermath");
assert.equal(encounter.update(frame(6040)), waveBattleBeat(6.04), "aftermath lasts exactly 6s");

const stale = new BattleBeatDirector();
stale.update(frame(0));
stale.bossDefeated(epoch + 20_000, epoch);
assert.equal(
  stale.update(frame(20_000)),
  waveBattleBeat(20),
  "a defeat across a gap is not an aftermath",
);
stale.bossDefeated(epoch + 20_000, epoch);
assert.equal(stale.update(frame(20_010)), "aftermath");
assert.equal(stale.update(frame(0)), "quiet", "rewind adopts the new timeline");
assert.equal(stale.update(frame(100, { epoch: epoch + 100 })), "quiet", "epoch change adopts");
assert.equal(stale.update(frame(200, { epoch: epoch + 100, presenting: false })), "quiet");
assert.equal(stale.update(frame(300, { epoch: epoch + 100, now: Infinity })), "quiet");

const paused = new BattleBeatDirector();
paused.update(frame(0));
paused.bossDefeated(epoch + 10, epoch);
assert.equal(paused.update(frame(10)), "aftermath");
assert.equal(paused.update(frame(20, { presenting: false })), "quiet", "spectating/dead is quiet");
paused.bossDefeated(epoch + 30, epoch);
assert.equal(
  paused.update(frame(40)),
  waveBattleBeat(0.04),
  "a defeat while not presenting is dropped",
);
console.log("PASS battle beat hysteresis, aftermath, gaps, rewinds and pauses");

// ---- weapon mastery -------------------------------------------------------------------

const active = (mastery: WeaponMastery) => {
  const { state } = mastery;
  assert.equal(state.phase, "active");
  if (state.phase !== "active") {
    throw new Error("unreachable");
  }
  return state;
};
const shot = (mastery: WeaponMastery, weapon: string, now: number) => {
  const value = mastery.shot(weapon, now);
  assert.ok(value);
  return value;
};

const rail = new WeaponMastery();
assert.equal(rail.shot("RAILGUN", 1000), null, "no window before pickup");
rail.pickup("RAILGUN", 1000, 21_000);
const a = shot(rail, "RAILGUN", 1000);
const twin = shot(rail, "RAILGUN", 1000);
rail.contact(a, "a", false, 1200);
rail.contact(a, "a", false, 1300);
rail.contact(twin, "b", false, 1400);
assert.equal(active(rail).completions, 0, "different beams never pool their contacts");
rail.contact(a, "b", false, 1500);
rail.contact(a, "c", false, 1600);
assert.equal(active(rail).completions, 1, "one completion per beam");
assert.equal(active(rail).contacts, 4);
const before = active(rail);
rail.pickup("RAILGUN", 5000, 41_000);
assert.deepEqual(
  rail.state,
  { ...before, endsAt: 41_000 },
  "stacking extends the deadline in place",
);
rail.contact(twin, "c", false, 21_000);
assert.equal(active(rail).completions, 2, "earlier beams stay live past the original deadline");
rail.contact(twin, "d", false, 41_000);
assert.equal(active(rail).contacts, 5, "the deadline itself is exclusive");
assert.equal(rail.shot("RAILGUN", 41_000), null);
rail.pickup("RAILGUN", 41_000, 61_000);
assert.notEqual(active(rail).generation, before.generation);
rail.contact(twin, "e", false, 41_001);
assert.equal(active(rail).contacts, 0, "old-generation beams cannot join a new window");

const glaive = new WeaponMastery();
glaive.pickup("GLAIVE", 1000, 21_000);
const blade = shot(glaive, "GLAIVE", 1000);
const other = shot(glaive, "GLAIVE", 1000);
glaive.contact(blade, "a", false, 900);
glaive.contact(blade, "a", false, 1100);
glaive.contact(other, "a", true, 1200);
glaive.contact(blade, "b", true, 1300);
assert.equal(active(glaive).completions, 0);
glaive.contact(blade, "a", true, 1400);
glaive.contact(blade, "a", true, 1401);
assert.equal(active(glaive).completions, 1, "same beam, same target, out then back");
assert.equal(active(glaive).contacts, 4);
const held = active(glaive);
for (let i = 0; i < 60; i += 1) {
  glaive.advance(1500, true, "GLAIVE");
}
assert.deepEqual(glaive.state, held);
glaive.pickup("BLASTER", 1600, 21_600);
assert.deepEqual(glaive.state, { phase: "idle" }, "non-mastery weapons clear the window");

for (const end of [
  { alive: true, now: 21_000, weapon: "RAILGUN" },
  { alive: false, now: 1100, weapon: "RAILGUN" },
  { alive: true, now: 1100, weapon: "GLAIVE" },
  { alive: true, now: 900, weapon: "RAILGUN" },
]) {
  const mastery = new WeaponMastery();
  mastery.pickup("RAILGUN", 1000, 21_000);
  mastery.advance(end.now, end.alive, end.weapon);
  assert.deepEqual(mastery.state, { phase: "idle" }, JSON.stringify(end));
  mastery.pickup("GLAIVE", 22_000, 42_000);
  assert.equal(active(mastery).weapon, "GLAIVE");
}
console.log("PASS weapon mastery windows, generations, stacking and expiry");
