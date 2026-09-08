import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as constants from "../src/shared/constants.ts";
import { rand, reseed } from "../src/shared/rng.ts";
import { now as simNow, pauseClock, resumeClock } from "../src/shared/clock.ts";
import { WeaponMastery } from "../src/shared/weapon-mastery.ts";
import { contactPoint } from "../src/render/combat-visuals.ts";
import { sealPointerEvents } from "../../../packages/embed/src/pointer-seal.ts";

// Execute current scene methods, with explicit display/network collaborators.
// This is not a GPU, real touch-device or connected-client test. No snapshots
// of source bodies: assertions target ordering, clocks, RNG and accepted state.
const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const method = (name) => {
  const found = new RegExp(`^  (?:(?:private|override) )?${name}\\([^]*?^  }`, "m").exec(
    source,
  )?.[0];
  assert.ok(found, `GameScene.${name}`);
  return found;
};
const helper = (name) => {
  const found = new RegExp(`^function ${name}\\([^]*?^}`, "m").exec(source)?.[0];
  assert.ok(found, name);
  return found;
};
class ElementProbe {
  constructor(tag = "div", parent = null) {
    this.tag = tag;
    this.parent = parent;
    this.listeners = new Map();
    this.classList = { add() {} };
  }
  closest() {
    return this.tag === "a" || this.tag === "button" ? this : (this.parent?.closest() ?? null);
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type, callback) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((cb) => cb !== callback),
    );
  }
  send(type, target = this) {
    const event = new Event(type, { cancelable: true, bubbles: true });
    Object.defineProperty(event, "target", { value: target });
    for (const callback of this.listeners.get(type) ?? []) callback(event);
    return event;
  }
  remove() {}
}
const elements = new Map();
const context = {
  ...constants,
  simNow,
  pauseClock,
  resumeClock,
  rand,
  contactPoint,
  NO_ASTEROIDS: [],
  inWorld: () => true,
  shipHullPoints: () => [],
  HITSPARK_SKIP_BUDGET: 580,
  BEAM_CULL_MARGIN: 200,
  DEG: Math.PI / 180,
  Phaser: { Math: { Clamp: (n, low, high) => Math.max(low, Math.min(high, n)) } },
  sfx: { unlock() {}, play() {}, setSuspended() {} },
  document: { getElementById: (id) => elements.get(id) ?? null },
  Element: ElementProbe,
  sealPointerEvents,
  watchControlContext: () => () => {},
  notifyGameStarted() {},
  readNetState: (player) => player.state,
};
const methods = [
  "update",
  "beginPlay",
  "buildStartScreen",
  "onStartKeyUp",
  "ensureSpawned",
  "pickRespawnPoint",
  "seedOpeningRocks",
  "recordMasteryContact",
  "updateWeaponMastery",
  "makeBeam",
  "detectMyHits",
  "updateBeams",
  "applyBaseLoadout",
  "pauseToSpectator",
  "die",
  "handleEvent",
  "pickupItems",
  "onBeamHit",
  "handleShooting",
  "isFiring",
  "freezeSim",
  "unfreezeSim",
];
const code = stripTypeScriptTypes(
  `${["emptyShared", "dist2", "segHitsCircle", "isWireRecord", "asWireRecord", "wireStr"].map(helper).join("\n")}\nclass SceneProbe extends Object {\n${methods.map(method).join("\n")}\n}`,
  { mode: "strip" },
);
const SceneProbe = new Function(...Object.keys(context), `${code};return SceneProbe;`)(
  ...Object.values(context),
);
const weapon = (name) => {
  const value = constants.WEAPONS_SPECIAL.find((w) => w.name === name);
  assert.ok(value, name);
  return value;
};
const noop = () => {};
const fresh = () => {
  const trace = [];
  const scene = Object.assign(new SceneProbe(), {
    mastery: new WeaponMastery(),
    masteryShots: new WeakMap(),
    trailer: false,
    flightHud: { reset: () => trace.push("hide-hud") },
    offline: true,
    live: true,
    amHost: true,
    myId: "solo",
    peers: {},
    peerStates: new Map(),
    started: false,
    spawned: false,
    paused: false,
    frozen: false,
    alive: true,
    shipX: 0,
    shipY: 0,
    shipVX: 0,
    shipVY: 0,
    shipAngle: 0,
    phasedUntil: 0,
    world: {
      playW: 3840,
      playH: 2160,
      arenaEpoch: simNow(),
      asteroids: [],
      enemies: [],
      items: [],
      ufo: null,
    },
    weapon: constants.WEAPON_DEFAULT,
    weaponUntil: 0,
    level: 1,
    shootCooldown: 0,
    windupAcc: 0,
    boosts: new Map(),
    dirty: {},
    beams: [],
    predictedKills: new Map(),
    recentPickups: new Map(),
    recentConsumedShots: new Map(),
    ramImmunity: new Map(),
    pvpIframeUntil: new Map(),
    comboExpiresAt: 0,
    streak: 0,
    trace,
    pad: { connected: false, update: noop, justPressed: () => false },
    gamepad: { isTouch: false, update: noop, setTint: noop },
    input: { activePointer: { isDown: false }, keyboard: { on: noop, off: noop } },
    fireKey: { isDown: false },
    time: { now: simNow(), delayedCall: noop },
    game: { loop: { sleep: () => trace.push("sleep"), wake: () => trace.push("wake") } },
    cameras: { main: { width: 1280, height: 720, zoom: 1, centerOn: noop } },
    starfield: { update: () => trace.push("stars") },
    barrier: { update: noop },
    attract: { update: () => trace.push("attract"), destroy: noop },
    battleBeat: { reset: noop },
    fx: {
      update: () => trace.push("fx"),
      aliveParticles: () => 0,
      sparks: noop,
      shatter: noop,
      ring: noop,
      battle: { beginWeapons: noop, burst: noop },
    },
    shared: () => null,
    myTint: () => 0xffffff,
    spawnInFx: noop,
    pushMyState: noop,
    writeStartCopy: noop,
    netSendEvent: (event, payload) => trace.push([event, payload]),
    enemyKillXp: () => 5,
    predictKill: noop,
    fireWeapon: (now) => trace.push(["cast", now]),
    prepareHost: () => scene.amHost,
    gainXp: (amount) => trace.push(["xp", amount]),
    trauma: { add: noop },
    splinterBurst: noop,
    screenFlash: noop,
    applyDeathXpPenalty: noop,
    deathCounts: new Map(),
    hostTick: () => {
      trace.push("host");
      scene.world.roll = rand();
    },
    advanceWorld: (dt) => {
      trace.push("advance");
      for (const a of scene.world.asteroids) a.x += a.vx * dt;
    },
  });
  for (const name of [
    "maybeGoOffline",
    "tickRespawn",
    "steerShip",
    "updateBeams",
    "tickMines",
    "tickSentry",
    "detectIncomingDamage",
    "collectShards",
    "tickBeaconClient",
    "tickShield",
    "tickSector",
    "netSend",
    "syncShips",
    "syncAsteroids",
    "syncUfo",
    "syncItems",
    "drawShards",
    "syncEnemies",
    "drawEnemyTelegraphs",
    "drawPulls",
    "drawBeacon",
    "drawEdgePips",
    "drawEnemyShots",
    "drawBeams",
    "updateSplinters",
    "drawMinimap",
    "updateCamera",
    "syncScreenUi",
    "updateBattlePresentation",
    "updateHud",
    "publishDiag",
  ])
    scene[name] = () => trace.push(name);
  return scene;
};

function put(scene, name, id) {
  const item = {
    id,
    kind: "weapon",
    weaponIdx: constants.WEAPONS_SPECIAL.indexOf(weapon(name)),
    x: scene.shipX,
    y: scene.shipY,
  };
  scene.world.items.push(item);
  return item;
}
function acquire(scene, name, id, now) {
  scene.started = scene.spawned = true;
  put(scene, name, id);
  scene.pickupItems(now);
  return scene.mastery.state;
}
function beam(scene, now, angle = 0) {
  const b = scene.makeBeam({ x: scene.shipX, y: scene.shipY }, angle, scene.weapon, now);
  scene.beams.push(b);
  return b;
}
let groups = 0;
function group(name, run) {
  run();
  groups++;
  console.log(`PASS ${name}`);
}
let wall = 1_000_000;
const originalNow = Date.now;
Date.now = () => wall;
try {
  group(
    "ordinary title runs shared simulation; no mode-specific items/enemies/clearing or RNG",
    () => {
      const scene = fresh();
      scene.world.asteroids.push({ x: 500, y: 500, vx: 10, vy: 0, radius: 20 });
      reseed(83);
      const rolls = Array.from({ length: 3 }, () => rand());
      const next = rand();
      reseed(83);
      for (const roll of rolls) {
        wall += 100;
        scene.update(wall, 100);
        assert.equal(scene.world.roll, roll);
      }
      assert.equal(scene.world.asteroids[0].x, 503);
      assert.equal(scene.world.asteroids.length, 1);
      assert.deepEqual(scene.world.items, []);
      assert.deepEqual(scene.world.enemies, []);
      assert.deepEqual(scene.mastery.state, { phase: "idle" });
      assert.equal(rand(), next);
      assert.equal(scene.trace.filter((e) => e === "host").length, 3);
    },
  );

  group(
    "actual pickup guards, local ownership, stacking and switch preserve ordinary item/RNG events",
    () => {
      for (const host of [true, false]) {
        const scene = fresh();
        scene.offline = false;
        scene.amHost = host;
        scene.started = scene.spawned = true;
        const item = put(scene, "RAILGUN", "local-rail");
        for (const gate of ["dead", "unspawned", "phased", "distant"]) {
          scene.alive = gate !== "dead";
          scene.spawned = gate !== "unspawned";
          scene.phasedUntil = gate === "phased" ? 1001 : 0;
          item.x = gate === "distant" ? 100 : 0;
          scene.pickupItems(1000);
          assert.deepEqual(scene.mastery.state, { phase: "idle" }, gate);
          assert.equal(scene.world.items.length, 1);
        }
        scene.alive = scene.spawned = true;
        scene.phasedUntil = 0;
        item.x = 0;
        const enemies = structuredClone(scene.world.enemies);
        const rocks = structuredClone(scene.world.asteroids);
        reseed(83);
        const next = rand();
        reseed(83);
        scene.pickupItems(1000);
        assert.equal(rand(), next, "feedback and accepted pickup add no random draws");
        assert.equal(scene.weaponUntil, 21000);
        assert.equal(scene.mastery.state.endsAt, scene.weaponUntil);
        assert.equal(scene.mastery.state.weapon, "RAILGUN");
        assert.deepEqual(scene.trace, [["item_pickup", { itemId: item.id }]]);
        assert.deepEqual(scene.world.enemies, enemies);
        assert.deepEqual(scene.world.asteroids, rocks);
        scene.world.items.push(item);
        const accepted = structuredClone(scene.mastery.state);
        scene.pickupItems(1001);
        assert.deepEqual(scene.mastery.state, accepted);
        assert.equal(scene.trace.length, 1, "same ID cannot replay acquisition");
        scene.world.items = [];
        const b = beam(scene, 1100);
        scene.recordMasteryContact(b, "a", 1200);
        acquire(scene, "RAILGUN", "stack-1", 2000);
        assert.deepEqual(scene.mastery.state, { ...accepted, contacts: 1, endsAt: 41000 });
        for (let i = 0; i < 5; i++) acquire(scene, "RAILGUN", `stack-${i + 2}`, 2000);
        assert.equal(scene.weaponUntil, 62000);
        assert.equal(scene.mastery.state.endsAt, 62000, "same60s cap as actual held weapon");
        scene.recordMasteryContact(b, "b", 21001);
        assert.equal(scene.mastery.state.completions, 1);
        const progress = structuredClone(scene.mastery.state);
        scene.level = 2;
        scene.applyBaseLoadout(22000);
        scene.updateWeaponMastery(22000);
        assert.deepEqual(scene.mastery.state, progress, "level scaling preserves pickup ownership");
        acquire(scene, "BLASTER", "switch", 23000);
        assert.deepEqual(scene.mastery.state, { phase: "idle" });
        assert.equal(scene.weaponUntil, 43000);
        acquire(scene, "RAILGUN", "new-rail", 24000);
        scene.recordMasteryContact(b, "c", 24001);
        assert.equal(scene.mastery.state.contacts, 0);
      }
      const remote = fresh();
      put(remote, "RAILGUN", "remote-item");
      remote.handleEvent("item_pickup", { itemId: "remote-item" }, "peer");
      assert.equal(remote.world.items.length, 0);
      remote.weapon = weapon("RAILGUN"); // a loaded/DEV loadout alone is not an acquisition
      remote.weaponUntil = 22000;
      const b = beam(remote, 2000);
      remote.recordMasteryContact(b, "a", 2100);
      remote.updateWeaponMastery(2200);
      assert.deepEqual(remote.mastery.state, { phase: "idle" });
      const trailer = fresh();
      trailer.trailer = true;
      acquire(trailer, "RAILGUN", "staged", 1000);
      assert.deepEqual(trailer.mastery.state, { phase: "idle" });
    },
  );

  group(
    "real collision counts local contact before beam reaction; duplicate/miss/deadline stay inert",
    () => {
      for (const host of [true, false]) {
        const scene = fresh();
        scene.amHost = host;
        acquire(scene, "RAILGUN", "rail", 1000);
        scene.trace.length = 0;
        const b = beam(scene, 1000);
        const a = constants.spawnEnemyState("warden", 80, 0);
        const other = constants.spawnEnemyState("warden", 60, 40);
        scene.world.enemies = [a, other];
        let reactions = 0;
        const original = scene.onBeamHit;
        scene.onBeamHit = function (...args) {
          reactions++;
          assert.equal(this.mastery.state.contacts, reactions);
          original.apply(this, args);
        };
        scene.detectMyHits(1100);
        scene.detectMyHits(1101);
        assert.equal(scene.mastery.state.contacts, 1);
        other.y = 0;
        scene.detectMyHits(1200);
        assert.equal(scene.mastery.state.completions, 1);
        assert.equal(scene.mastery.state.contacts, 2);
        assert.equal(b.vanished, false);
        assert.deepEqual(scene.trace, [
          ["enemy_hit", { enemyId: a.id, damage: scene.weapon.power * 100 }],
          ["enemy_hit", { enemyId: other.id, damage: scene.weapon.power * 100 }],
        ]);
        scene.onBeamHit = original;
        const last = constants.spawnEnemyState("warden", 40, 0);
        scene.world.enemies.push(last);
        scene.detectMyHits(21000);
        assert.equal(
          scene.mastery.state.contacts,
          2,
          "expired feedback never delays actual damage",
        );
        assert.equal(scene.trace.length, 3);
        scene.updateWeaponMastery(21000);
        assert.deepEqual(scene.mastery.state, { phase: "idle" });
        assert.equal(scene.mastery.trackedShots, 0);
      }
    },
  );

  group(
    "Glaive actual turnaround rearms contacts; earlier beams never join a replacement pickup",
    () => {
      const scene = fresh();
      acquire(scene, "GLAIVE", "glaive", 1000);
      const b = beam(scene, 1000);
      const other = beam(scene, 1000);
      const target = constants.spawnEnemyState("warden", b.head.x, b.head.y);
      scene.world.enemies = [target];
      scene.beams = [b];
      scene.detectMyHits(1100);
      assert.equal(scene.mastery.state.contacts, 1);
      other.glaive.returning = true;
      scene.recordMasteryContact(other, target.id, 1101);
      assert.equal(scene.mastery.state.completions, 0, "two shots cannot form out/back pair");
      b.glaive.traveled = b.weapon.boomerang.outRange;
      SceneProbe.prototype.updateBeams.call(scene, 0, 1200);
      assert.equal(b.glaive.returning, true);
      assert.equal(b.hitIds.size, 0);
      scene.detectMyHits(1200);
      scene.detectMyHits(1201);
      assert.equal(scene.mastery.state.completions, 1);
      assert.equal(scene.mastery.state.contacts, 3);
      const before = beam(scene, 1250); // no contact yet; registration must happen at creation
      acquire(scene, "BLASTER", "blaster", 1300);
      acquire(scene, "GLAIVE", "glaive-2", 1400);
      for (const old of [b, before]) {
        old.glaive.returning = false;
        scene.recordMasteryContact(old, target.id, 1500);
        old.glaive.returning = true;
        scene.recordMasteryContact(old, target.id, 1600);
      }
      assert.equal(scene.mastery.state.contacts, 0);
      const current = beam(scene, 1700);
      scene.recordMasteryContact(current, "new", 1800);
      current.glaive.returning = true;
      scene.recordMasteryContact(current, "new", 1900);
      assert.equal(scene.mastery.state.completions, 1);
      current.vanished = true;
      scene.updateWeaponMastery(2000);
      assert.equal(scene.mastery.trackedShots, 0);
    },
  );

  group(
    "offline clock freeze preserves progress; online spectator and actual death clear without replay",
    () => {
      wall = 3_000_000;
      const scene = fresh();
      acquire(scene, "RAILGUN", "rail", simNow());
      const b = beam(scene, simNow());
      scene.recordMasteryContact(b, "a", simNow());
      const accepted = structuredClone(scene.mastery.state);
      wall += 5000;
      const before = simNow();
      scene.freezeSim();
      wall += 30000;
      scene.freezeSim();
      assert.equal(simNow(), before);
      assert.ok(scene.trace.includes("hide-hud"));
      scene.unfreezeSim();
      scene.updateWeaponMastery(simNow());
      assert.deepEqual(scene.mastery.state, accepted);
      assert.equal(scene.mastery.state.endsAt - simNow(), 15000);
      assert.deepEqual(
        scene.trace.filter((e) => e === "sleep" || e === "wake"),
        ["sleep", "wake"],
      );
      scene.offline = false;
      scene.pauseToSpectator();
      assert.deepEqual(scene.mastery.state, { phase: "idle" });
      assert.equal(scene.beams.length, 0);
      scene.recordMasteryContact(b, "b", simNow());
      assert.equal(scene.mastery.trackedShots, 0);
      const dead = fresh();
      acquire(dead, "GLAIVE", "blade", simNow());
      const blade = beam(dead, simNow());
      dead.recordMasteryContact(blade, "a", simNow());
      dead.die(simNow(), null, "WARDEN");
      assert.equal(dead.alive, false);
      assert.equal(dead.weaponUntil, 0);
      assert.deepEqual(dead.mastery.state, { phase: "idle" });
      assert.equal(dead.mastery.trackedShots, 0);
      assert.equal(dead.beams.length, 0);
    },
  );

  group("ordinary title containment and native Railgun windup/release stay unchanged", () => {
    const start = new ElementProbe();
    elements.set("start", start);
    const scene = fresh();
    let starts = 0;
    scene.beginPlay = () => starts++;
    scene.buildStartScreen();
    scene.onStartKeyUp({ key: "Tab", target: start });
    assert.equal(starts, 0);
    assert.equal(start.send("touchend").defaultPrevented, true);
    start.send("pointerup");
    assert.equal(starts, 1);
    elements.clear();
    scene.started = scene.spawned = true;
    scene.weapon = weapon("RAILGUN");
    scene.fireKey.isDown = true;
    for (let i = 0; i < 6; i++) scene.handleShooting(100, 1000 + i * 100);
    assert.equal(scene.trace.length, 0);
    scene.handleShooting(100, 1600);
    assert.deepEqual(scene.trace, [["cast", 1600]]);
    scene.fireKey.isDown = false;
    scene.handleShooting(100, 1700);
    assert.equal(scene.windupAcc, 0);
    scene.alive = false;
    scene.fireKey.isDown = true;
    scene.handleShooting(2000, 3700);
    assert.equal(scene.trace.length, 1);
  });
} finally {
  resumeClock();
  Date.now = originalNow;
}
console.log(`${groups} Starfall mastery integration groups passed`);
