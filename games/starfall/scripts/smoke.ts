// Pure-logic checks for the presentation/HUD helpers and the netcode codecs: `pnpm --filter @repo/starfall test`.
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
import { FIRE_BASE, decodeFire, encodeFire } from "../src/net/fire-wire";
import { HostIntents, readIntents } from "../src/net/intents";
import type { IntentBatch } from "../src/net/intents";
import type { WireRecord } from "../src/net/wire-read";
import {
  ASTEROIDS,
  ENEMY_DETAILS,
  HOT_KEY,
  SHOTS,
  STAMP_KEY,
  WorldEncoder,
  bucketKey,
  bucketOf,
  readAsteroidRow,
  readBucket,
  readEnemyDetail,
  readShotRow,
  readStandings,
  toSim,
} from "../src/net/world-wire";
import { burstLifetime, burstStage, contactPoint, weaponLook } from "../src/render/combat-visuals";
import {
  ELITE_HP_BASE,
  ENEMY_SPECS,
  LEVEL_CAP,
  eliteHp,
  eliteHpMult,
  enemyKillXp,
  scaleWeaponForLevel,
  spawnEnemyState,
  WEAPONS_SPECIAL,
} from "../src/shared/constants";
import type { EnemyKind, SharedState } from "../src/shared/constants";
import { WeaponMastery } from "../src/shared/weapon-mastery";
import { Link } from "../src/state/link";
import { buildVolley } from "../src/sys/volley";
import type { FireSpec } from "../src/sys/volley";

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

// ---- kill XP --------------------------------------------------------------------------

// An elite pays the multiplier its HP was stamped with at spawn, read off the
// enemy: the shooter needs no view of the room's levels.
for (const kind of ELITE_HP_BASE.keys()) {
  const elite = spawnEnemyState(kind, 0, 0);
  assert.equal(
    enemyKillXp(elite),
    ENEMY_SPECS[kind].xp,
    `${kind}: an unstamped elite pays its spec`,
  );
  for (let level = 1; level <= LEVEL_CAP; level += 1) {
    elite.maxHp = eliteHp(kind, level);
    const want = Math.round(ENEMY_SPECS[kind].xp * eliteHpMult(level));
    assert.equal(enemyKillXp(elite), want, `${kind} stamped at L${level}`);
  }
}
const drone = spawnEnemyState("drone", 0, 0);
drone.maxHp = 999;
assert.equal(enemyKillXp(drone), ENEMY_SPECS.drone.xp, "fodder pays its flat spec");
console.log("PASS kill XP rides the elite's own HP stamp");

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

// ---- netcode: world rows, server-time stamps, fire events, intents --------------------

const worldAt = (t: number): SharedState => ({
  arenaEpoch: t - 60_000,
  asteroids: [
    { id: "rock0001", radius: 41.26, rot: 0, vx: 12.34, vy: -5.67, x: 1200.4, y: 800.6 },
    { id: "rock0002", radius: 12, rot: 0, vx: 0, vy: 30, x: 300, y: 300 },
  ],
  beacon: null,
  enemies: [{ ...spawnEnemyState("sniper", 640.2, 480.7), id: "enemy001", vx: 30, vy: -40 }],
  enemyShots: [{ diesAt: t + 3000, id: "shot0001", vx: 250, vy: 0, x: 900, y: 900 }],
  items: [],
  playH: 2160,
  playW: 3840,
  pulls: [],
  sectorBossIdx: -1,
  shards: [],
  ufo: null,
});
const keysOf = (patch: WireRecord): string[] =>
  Object.keys(patch).filter(
    (k) => !["t", "arenaEpoch", "playW", "playH", "sectorBossIdx"].includes(k),
  );

{
  // The host's sim clock reads T0 at server time S0.
  const T0 = 5_000_000;
  const S0 = 1_760_000_000_000;
  const host = worldAt(T0);
  const enc = new WorldEncoder();
  const first = enc.encode(host, T0, S0);
  assert.ok(keysOf(first).includes(HOT_KEY), "enemies' motion goes every share");
  const rockBucket = readBucket(
    first[bucketKey(ASTEROIDS, bucketOf("rock0001", ASTEROIDS.buckets))],
  );
  assert.ok(rockBucket, "the first share carries every rock bucket");
  assert.equal(first[STAMP_KEY], S0, "a share is stamped with server time");
  assert.equal(rockBucket?.t, S0, "so is every bucket in it");
  const rock = rockBucket?.rows.map(readAsteroidRow).find((r) => r?.id === "rock0001");
  assert.ok(rock && Math.abs(rock.x - 1200.4) <= 0.5 && rock.vx === 12.3 && rock.radius === 41.3);
  const shotKey = bucketKey(SHOTS, bucketOf("shot0001", SHOTS.buckets));
  const [firstShot] =
    readBucket(first[shotKey])?.rows.map((r) => readShotRow(r, (rel) => T0 + rel)) ?? [];
  assert.equal(firstShot?.diesAt, T0 + 3000, "deadlines ride relative to the bucket stamp");
  const detail = readEnemyDetail(
    readBucket(first[bucketKey(ENEMY_DETAILS, bucketOf("enemy001", ENEMY_DETAILS.buckets))])
      ?.rows[0] ?? [],
    (rel) => T0 + rel,
  );
  assert.equal(detail?.kind, "sniper");
  console.log("PASS world rows round-trip (positions, velocities, stamp-relative deadlines)");

  // Pure motion is extrapolated by guests: besides the enemies' poses, only the
  // slow round-robin refresh goes (every second share, one bucket).
  for (const drifting of host.asteroids) {
    drifting.x += drifting.vx * 0.05;
    drifting.y += drifting.vy * 0.05;
  }
  assert.deepEqual(keysOf(enc.encode(host, T0 + 50, S0 + 50)), [bucketKey(ASTEROIDS, 0), HOT_KEY]);
  // A rock that turns resends its bucket alone.
  const [hitRock] = host.asteroids;
  if (hitRock) {
    hitRock.vx = -20;
  }
  const turned = keysOf(enc.encode(host, T0 + 100, S0 + 100)).filter((k) => k !== HOT_KEY);
  assert.ok(turned.includes(bucketKey(ASTEROIDS, bucketOf("rock0001", ASTEROIDS.buckets))));
  assert.ok(
    turned.every((k) => k.startsWith(ASTEROIDS.key)),
    `only rock buckets: ${turned}`,
  );
  // An expired shot leaves on every client by itself; a consumed one is resent.
  host.enemyShots = [];
  const expired = keysOf(enc.encode(host, T0 + 3100, S0 + 3100));
  assert.ok(!expired.includes(shotKey), "expiry needs no resend");
  host.enemyShots = [{ diesAt: T0 + 9000, id: "shot0002", vx: 0, vy: 0, x: 50, y: 50 }];
  enc.encode(host, T0 + 3150, S0 + 3150);
  host.enemyShots = [];
  const eaten = keysOf(enc.encode(host, T0 + 3200, S0 + 3200));
  assert.ok(
    eaten.includes(bucketKey(SHOTS, bucketOf("shot0002", SHOTS.buckets))),
    "a taken shot is resent",
  );
  console.log("PASS host patches carry only what a guest cannot extrapolate");

  const scatter = WEAPONS_SPECIAL.find((w) => w.name === "SCATTER");
  assert.ok(scatter);
  const sent: FireSpec = {
    angle: 0.7,
    chain: null,
    code: WEAPONS_SPECIAL.indexOf(scatter),
    kind: "volley",
    level: 2,
    lock: null,
    seed: 4242,
    t: 1000,
    twin: 1.1,
    twinLock: null,
    weapon: scaleWeaponForLevel(scatter, 2),
    x: 500,
    y: 400,
  };
  const got = decodeFire(encodeFire(sent));
  assert.ok(got, "fire event decodes");
  const mine = buildVolley(sent);
  const theirs = buildVolley(got);
  assert.equal(theirs.length, mine.length, "same pellet count (nose + twin)");
  for (const [i, b] of mine.entries()) {
    const r = theirs[i];
    assert.ok(r && Math.abs(r.angle - b.angle) < 0.002 && Math.abs(r.head.x - b.head.x) < 0.2);
    assert.equal(r.weapon.power, b.weapon.power);
  }
  const chain = decodeFire(
    encodeFire({
      ...sent,
      chain: [
        { x: 1, y: 2 },
        { x: 30, y: 40 },
      ],
      code: FIRE_BASE,
      kind: "chain",
    }),
  );
  assert.equal(chain?.chain?.length, 2);
  console.log("PASS fire events rebuild the shooter's exact volley");

  // The epoch rides as server time, converted once per value: a share whose
  // stamp jitters by a millisecond against the sim clock leaves it alone.
  const epochHost = worldAt(T0);
  const epochEnc = new WorldEncoder();
  const epochWire = epochEnc.encode(epochHost, T0, S0)["arenaEpoch"];
  assert.equal(epochWire, S0 - 60_000, "the arena epoch goes out as server time");
  assert.equal(epochEnc.encode(epochHost, T0 + 50, S0 + 51)["arenaEpoch"], epochWire);
  epochHost.arenaEpoch -= 5000;
  assert.equal(epochEnc.encode(epochHost, T0 + 100, S0 + 100)["arenaEpoch"], S0 - 65_000);
  // A guest's sim clock shares no epoch with the host's: it reads G0 at server
  // time S0. Decoding 30 ms after the share, a row is 30 ms old and a
  // deadline lands at the same moment on the guest's own clock.
  const G0 = 90_000;
  const guestClock = { now: G0 + 30, serverNow: S0 + 30 };
  const shotRows = readBucket(first[shotKey]);
  assert.ok(shotRows);
  const [guestShot] = shotRows.rows.map((r) =>
    readShotRow(r, (rel) => toSim(shotRows.t + rel, guestClock)),
  );
  assert.equal(guestShot?.diesAt, G0 + 3000, "a deadline maps onto the guest's sim clock");
  assert.equal(guestClock.serverNow - shotRows.t, 30, "rows age by server time");
  console.log("PASS world stamps are server time; deadlines map onto each client's clock");

  // The host's standings relay: id/score pairs, malformed pairs skipped.
  assert.deepEqual(
    [...readStandings(["a", 10, "b", 3, 7, "x", "c"])],
    [
      ["a", 10],
      ["b", 3],
    ],
  );
  assert.equal(readStandings(null).size, 0);
  console.log("PASS the relayed standings decode");

  let delivered: IntentBatch | null = null;
  const inboxLink = new Link({
    inbox: (_event, payload) => {
      delivered = readIntents(payload);
    },
  });
  inboxLink.offline = true;
  const intents = new HostIntents();
  intents.enemyHit("enemy001", 25, 3, -4);
  intents.asteroidHit("rock0001", 1 / 3);
  intents.shotConsumed("shot0001");
  intents.pull(10, 20, 800);
  intents.flush(inboxLink);
  assert.deepEqual(delivered, {
    hits: [
      { damage: 25, id: "enemy001", kind: "enemy", kx: 3, ky: -4 },
      { damage: 0.333, id: "rock0001", kind: "asteroid" },
    ],
    items: [],
    pulls: [{ ms: 800, x: 10, y: 20 }],
    shards: [],
    shots: ["shot0001"],
  });
  console.log("PASS a frame's intents reach the host as one batch");
}
