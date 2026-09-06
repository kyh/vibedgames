import assert from "node:assert/strict";
import { networkFixture } from "./network-harness.mjs";

const boss = (hp = 90) => ({
  id: "boss",
  kind: "dreadnought",
  x: 800,
  y: 500,
  vx: 3,
  vy: -2,
  angle: 0,
  hp,
  maxHp: 100,
  telegraphUntil: 1_000_800,
  chargeUntil: 1_001_000,
  blinkUntil: 0,
  graceUntil: 0,
  lances: [{ x: 300, y: 200 }],
  shielded: false,
});
const rock = { id: "rock", x: 300.1234, y: 600.4321, vx: 20, vy: -8, radius: 25, rot: 0.12 };
const accepted = (f, hp = 90) => ({
  ...f.empty(),
  asteroids: [{ ...rock }],
  enemies: [boss(hp)],
  arenaEpoch: 870_000,
  sectorBossIdx: 2,
  playW: 4400,
  playH: 2475,
  items: [
    { id: "item", kind: "weapon", weaponIdx: 1, x: 500, y: 450, vx: 0, vy: 0, diesAt: 1_010_000 },
  ],
  shards: [{ id: "shard", x: 700, y: 600, vx: 2, vy: 1, diesAt: 1_010_000 }],
  enemyShots: [{ id: "shot", x: 900, y: 600, vx: 5, vy: -2, diesAt: 1_010_000 }],
  pulls: [{ id: "pull", x: 250, y: 550, until: 1_010_000 }],
  beacon: {
    x: 500,
    y: 500,
    activeAt: 999_000,
    diesAt: 1_010_000,
    controllerId: "self",
    contested: false,
  },
});
const localOwner = (s) => [
  s.shipX,
  s.shipY,
  s.shipVX,
  s.shipVY,
  s.xp,
  s.runXp,
  s.level,
  s.weapon,
  s.recentPickups,
  s.recentShardPickups,
  s.recentConsumedShots,
];
let groups = 0;

// SDK sync admits a host before notify; adoption must be exact, detached and
// preserve owner-simulated ship/loadout/reward guards.
{
  const f = networkFixture();
  const local = localOwner(f.scene);
  f.scene.enemySim.set("stale", {});
  f.sync(accepted(f));
  assert.deepEqual(f.scene.world, f.client.sharedState);
  assert.notEqual(f.scene.world, f.client.sharedState);
  assert.notEqual(f.scene.world.enemies[0].lances, f.client.sharedState.enemies[0].lances);
  assert.deepEqual(localOwner(f.scene), local);
  assert.equal(f.scene.enemySim.size, 0);
  assert.equal(f.scene.hostSnapshotReady, true);
  assert.equal(f.packets.length, 0, "existing room is never reseeded");
  assert.equal(f.cues.length, 0, "first accepted boss is a silent baseline");
  const before = structuredClone(f.client.sharedState);
  for (let i = 0; i < 180; i++) f.scene.advanceWorld(1 / 60);
  f.scene.world.enemies[0].lances[0].x += 33;
  assert.deepEqual(f.client.sharedState, before, "working frames cannot mutate accepted SDK cache");
  f.scene.hostTick(1_000_000, 1 / 60, 50);
  const written = structuredClone(f.client.sharedState);
  assert.ok(f.packets.some((p) => p.type === "state_patch"));
  for (let i = 0; i < 180; i++) f.scene.advanceWorld(1 / 60);
  f.scene.world.enemies[0].lances[0].x += 33;
  assert.deepEqual(f.client.sharedState, written, "outgoing serializers also detach nested arrays");
  f.client.destroy();
  assert.equal(f.timers.size, 0);
  groups++;
}

// Actual SDK close retains stale hostId. Neither events nor direct ticks may
// write until admission; reconnect-as-host must drop stale entities/epoch.
{
  const f = networkFixture();
  f.sync(accepted(f));
  f.client.updateMyState({ xp: 123, weaponName: "kept", present: true });
  f.socket.close();
  assert.equal(f.client.isHost, true, "SDK retains identity while transport is down");
  assert.equal(f.scene.amHost, false);
  assert.equal(f.scene.hostSnapshotReady, false);
  const count = f.packets.length;
  const world = structuredClone(f.scene.world);
  f.scene.hostTick(1_005_000, 0.016, 50);
  f.event("item_pickup", { itemId: "item" });
  assert.deepEqual(f.scene.world, world);
  assert.equal(f.packets.length, count);
  const next = { ...accepted(f), arenaEpoch: 900_000, sectorBossIdx: 4, enemies: [], items: [] };
  f.sync(next);
  assert.deepEqual(f.scene.world, next);
  assert.equal(f.client.playerId, "self");
  assert.deepEqual(f.client.players.self.state, { xp: 123, weaponName: "kept", present: true });
  assert.equal(f.packets.at(-1).type, "player_state_patch");
  assert.equal(f.cues.length, 0);
  f.scene.hostTick(1_005_000, 0.016, 50);
  assert.equal(f.scene.world.enemies.length, 0);
  assert.equal(f.scene.world.arenaEpoch, 900_000);
  assert.equal(f.scene.world.sectorBossIdx, 4);
  assert.equal(f.scene.lastAsteroidSpawnAt, 1_005_000);
  f.client.destroy();
  groups++;
}

// Election notification is normally first; also prove direct host command and
// tick admission gates before notify, including two unsent accepted commands.
for (const first of ["notify", "event", "tick"]) {
  const f = networkFixture();
  f.sync(accepted(f), "other");
  f.scene.world.items = [];
  f.scene.world.enemies[0].hp = 1;
  if (first === "notify") f.socket.receive({ type: "host", data: { id: "self" } });
  else Reflect.set(f.client, "_hostId", "self"); // precisely isolate gate ordering before SDK notify
  if (first === "tick") f.scene.hostTick(1_000_000, 0.016, 0);
  else f.scene.handleEvent("item_pickup", { itemId: "item" }, "remote");
  assert.equal(f.scene.world.enemies[0].hp, 90);
  f.scene.handleEvent("shard_pickup", { shardId: "shard" }, "remote");
  f.scene.onUpdate();
  assert.equal(f.scene.world.shards.length, 0);
  assert.equal(f.scene.world.items.length, first === "tick" ? 1 : 0);
  assert.equal(f.client.sharedState.items.length, 1);
  assert.equal(f.client.sharedState.shards.length, 1);
  assert.equal(f.cues.length, 0);
  f.client.destroy();
}
groups++;

// Retained encounter caches cannot announce missed reconnect transitions;
// after admission the next genuine phase/removal still emits exactly once.
for (const removed of [false, true]) {
  const f = networkFixture();
  f.sync(accepted(f));
  f.socket.close();
  f.sync({ ...accepted(f, 20), enemies: removed ? [] : [boss(20)] });
  assert.equal(f.cues.length, 0, "no missed phase/defeat stinger at admission");
  if (removed) f.scene.world.enemies.push({ ...boss(), id: "next" });
  else f.scene.world.enemies = [];
  f.scene.observeBossEncounters(f.scene.world);
  f.scene.observeBossEncounters(f.scene.world);
  assert.deepEqual(
    f.cues.filter((x) => !Array.isArray(x)),
    [removed ? "boss_arrival" : "boss_defeat"],
  );
  f.client.destroy();
}
{
  const f = networkFixture();
  f.sync(accepted(f));
  f.scene.world.enemies[0].hp = 50;
  f.scene.observeBossEncounters(f.scene.world);
  f.scene.onUpdate();
  f.scene.observeBossEncounters(f.scene.world);
  assert.deepEqual(
    f.cues.filter((x) => !Array.isArray(x)),
    ["boss_phase"],
  );
  assert.equal(f.scene.beatResets, 1);
  f.client.destroy();
}
groups++;

// Guest player-only traffic must not reblend toward an unchanged snapshot.
{
  const f = networkFixture();
  f.sync(accepted(f), "other");
  f.scene.advanceWorld(0.1);
  const x = f.scene.world.asteroids[0].x;
  for (let i = 0; i < 20; i++)
    f.socket.receive({ type: "player_state", data: { id: "other", state: { x: i } } });
  assert.equal(f.scene.world.asteroids[0].x, x);
  assert.equal(f.cues.length, 0);
  f.socket.receive({ type: "state_patch", data: { enemies: [boss(50)] } });
  assert.deepEqual(
    f.cues.filter((v) => !Array.isArray(v)),
    ["boss_phase"],
  );
  f.client.destroy();
  groups++;
}

// Empty-room seed is authored once, keeps full precision despite synchronous
// SDK notification, and legacy partial worlds get existing defaults only.
{
  const f = networkFixture();
  f.sync({});
  assert.ok(f.scene.world.asteroids.length > 0);
  assert.equal(f.packets.filter((p) => p.type === "state_patch").length, 1);
  assert.notEqual(f.scene.world.asteroids[0], f.client.sharedState.asteroids[0]);
  assert.ok(f.scene.world.asteroids.some((a, i) => a.x !== f.client.sharedState.asteroids[i].x));
  const world = f.scene.world;
  f.scene.onUpdate();
  assert.equal(f.scene.world, world);
  f.client.destroy();
  const legacy = networkFixture();
  legacy.sync({ asteroids: [], playW: -1, playH: 1e9 });
  assert.equal(legacy.scene.world.playW, 3840);
  assert.equal(legacy.scene.world.playH, 4320);
  for (const name of ["items", "enemies", "enemyShots", "shards", "pulls"])
    assert.deepEqual(legacy.scene.world[name], []);
  assert.equal(legacy.scene.world.arenaEpoch, 1_000_000);
  assert.equal(legacy.packets.length, 0);
  legacy.client.destroy();
  groups++;
}

console.log(`Starfall network ownership: ${groups} actual SDK/scene groups passed`);
