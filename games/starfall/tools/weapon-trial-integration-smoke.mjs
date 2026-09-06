import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as constants from "../src/shared/constants.ts";
import { rand, reseed } from "../src/shared/rng.ts";
import { now as simNow, pauseClock, resumeClock } from "../src/shared/clock.ts";
import { WeaponTrial, readTrialChoice } from "../src/trials/weapon-trial.ts";
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
class CardProbe {
  updates = [];
  update(...args) {
    this.updates.push(args);
  }
}
const context = {
  ...constants,
  simNow,
  pauseClock,
  resumeClock,
  rand,
  contactPoint,
  NO_ASTEROIDS: [],
  HITSPARK_SKIP_BUDGET: 580,
  DEG: Math.PI / 180,
  Phaser: { Math: { Clamp: (n, low, high) => Math.max(low, Math.min(high, n)) } },
  sfx: { unlock() {}, play() {}, setSuspended() {} },
  document: { getElementById: (id) => elements.get(id) ?? null },
  Element: ElementProbe,
  sealPointerEvents,
  watchControlContext: () => () => {},
  notifyGameStarted() {},
  TrialCard: CardProbe,
  readNetState: (player) => player.state,
};
const methods = [
  "update",
  "beginPlay",
  "buildStartScreen",
  "onStartKeyUp",
  "seedWeaponTrial",
  "ensureSpawned",
  "pickRespawnPoint",
  "seedOpeningRocks",
  "recordTrialContact",
  "updateWeaponTrial",
  "detectMyHits",
  "pickupItems",
  "onBeamHit",
  "handleShooting",
  "isFiring",
  "freezeSim",
  "unfreezeSim",
];
const code = stripTypeScriptTypes(
  `${["emptyShared", "dist2", "segHitsCircle"].map(helper).join("\n")}\nclass SceneProbe extends Object {\n${methods.map(method).join("\n")}\n}`,
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
const fresh = (kind = "railgun") => {
  const choice = readTrialChoice(new URLSearchParams(`offline=1&trial=${kind}`));
  const trace = [];
  const scene = Object.assign(new SceneProbe(), {
    trial: choice ? new WeaponTrial(choice) : null,
    trialCard: null,
    trialPickupId: null,
    trialBeamIds: new WeakMap(),
    nextTrialBeam: 0,
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
  group("trial title freezes world/RNG; ordinary live rooms still simulate behind title", () => {
    reseed(7319);
    const next = rand();
    reseed(7319);
    const trial = fresh();
    trial.world.asteroids.push({ x: 500, y: 500, vx: 10, vy: 0, radius: 20 });
    const before = structuredClone(trial.world);
    for (let i = 0; i < 300; i++) {
      wall += 100;
      trial.update(wall, 100);
    }
    assert.deepEqual(trial.world, before);
    assert.equal(rand(), next);
    assert.equal(trial.trialPickupId, null);
    assert.ok(trial.trace.includes("attract") && trial.trace.includes("fx"));
    assert.ok(!trial.trace.includes("host") && !trial.trace.includes("advance"));
    const room = fresh("none");
    room.offline = false;
    room.world.asteroids.push({ x: 500, y: 500, vx: 10, vy: 0, radius: 20 });
    room.update(wall, 100);
    assert.ok(room.trace.includes("host") && room.trace.includes("advance"));
    assert.equal(room.world.asteroids[0].x, 501);
    assert.equal(room.trialPickupId, null);
    assert.equal(room.trace.indexOf("advance") < room.trace.indexOf("host"), true);
    const connecting = fresh();
    connecting.live = false;
    connecting.update(wall, 100);
    assert.ok(!connecting.trace.includes("host"));
  });

  group("seeded trial opening/pickup is identical after0 versus30s title dwell", () => {
    const opening = (dwell, kind) => {
      wall = 2_000_000;
      reseed(7319);
      const scene = fresh(kind);
      scene.world.asteroids.push(constants.spawnOpeningAsteroid(400, 400));
      for (let t = 0; t < dwell; t += 100) {
        wall += 100;
        scene.update(wall, 100);
      }
      scene.beginPlay();
      scene.update(wall, 16);
      assert.equal(scene.trial.state.phase, "active");
      assert.equal(scene.trial.state.endsAt - simNow(), 20000);
      assert.equal(scene.world.arenaEpoch, simNow());
      const relativeEnemies = scene.world.enemies.map((e) => ({
        kind: e.kind,
        x: e.x - scene.shipX,
        y: e.y - scene.shipY,
        angle: e.angle,
        hp: e.hp,
        maxHp: e.maxHp,
      }));
      const snapshot = {
        x: scene.shipX,
        y: scene.shipY,
        enemies: relativeEnemies,
        rocks: scene.world.asteroids.map(({ x, y, vx, vy, radius }) => ({ x, y, vx, vy, radius })),
        weapon: scene.weapon.name,
        state: { ...scene.trial.state, startedAt: 0, endsAt: 20000 },
        nextRandom: rand(),
      };
      const count = scene.world.enemies.length;
      scene.seedWeaponTrial();
      assert.equal(scene.world.enemies.length, count);
      for (const e of relativeEnemies) assert.equal(e.angle, Math.atan2(-e.y, -e.x));
      return snapshot;
    };
    for (const kind of ["railgun", "glaive"])
      assert.deepEqual(opening(0, kind), opening(30000, kind));
  });

  group(
    "actual accepted designated pickup owns exact deadline; repeated/other pickups cannot restart it",
    () => {
      const scene = fresh();
      scene.started = scene.spawned = true;
      scene.shipX = scene.shipY = 1000;
      scene.seedWeaponTrial();
      assert.equal(scene.trial.state.phase, "waiting");
      const item = scene.world.items[0];
      assert.ok(item);
      scene.phasedUntil = simNow() + 1;
      scene.pickupItems(simNow());
      assert.equal(scene.trial.state.phase, "waiting");
      scene.phasedUntil = 0;
      item.x += 100;
      scene.pickupItems(simNow());
      assert.equal(scene.trial.state.phase, "waiting");
      item.x = scene.shipX;
      scene.pickupItems(simNow());
      const first = structuredClone(scene.trial.state);
      assert.equal(first.phase, "active");
      assert.equal(first.endsAt, simNow() + 20000);
      assert.equal(scene.world.items.length, 0);
      scene.world.items.push(item);
      scene.pickupItems(simNow());
      assert.deepEqual(scene.trial.state, first);
      scene.world.items.length = 0;
      wall += 1000;
      scene.world.items.push(
        constants.spawnItemState(scene.shipX, scene.shipY, {
          kind: "weapon",
          weaponIdx: constants.WEAPONS_SPECIAL.indexOf(weapon("RAILGUN")),
        }),
      );
      scene.pickupItems(simNow());
      assert.ok(scene.weaponUntil > first.endsAt);
      assert.deepEqual(scene.trial.state, first);
      scene.updateWeaponTrial(first.endsAt);
      assert.equal(scene.trial.state.phase, "result");
      assert.equal(scene.trial.state.reason, "window");
    },
  );

  group(
    "real collision admits one contact before beam reaction; misses/duplicates cannot score",
    () => {
      const scene = fresh();
      scene.spawned = scene.started = true;
      scene.weapon = weapon("RAILGUN");
      scene.trial.begin(1000, 21000);
      const beam = {
        weapon: scene.weapon,
        head: { x: 100, y: 0 },
        tail: { x: 0, y: 0 },
        angle: 0,
        exploding: false,
        vanished: false,
        hitIds: new Set(),
      };
      scene.beams = [beam];
      const a = constants.spawnEnemyState("warden", 80, 0);
      const b = constants.spawnEnemyState("warden", 60, 40);
      scene.world.enemies = [a, b];
      const original = scene.onBeamHit;
      let reactions = 0;
      scene.onBeamHit = function (...args) {
        reactions++;
        assert.equal(this.trial.state.contacts, reactions);
        original.apply(this, args);
      };
      scene.detectMyHits(1100);
      assert.equal(scene.trial.state.contacts, 1);
      assert.equal(beam.vanished, false);
      scene.detectMyHits(1101);
      assert.equal(scene.trial.state.contacts, 1);
      b.y = 0;
      scene.detectMyHits(1200);
      assert.equal(scene.trial.state.completions, 1);
      assert.equal(scene.trial.state.contacts, 2);
      assert.equal(scene.nextTrialBeam, 1);
      assert.equal(scene.trial.trackedShots, 1);
      beam.vanished = true;
      scene.updateWeaponTrial(1300);
      assert.equal(scene.trial.trackedShots, 0);
      assert.equal(scene.trace.filter((e) => Array.isArray(e) && e[0] === "enemy_hit").length, 2);
    },
  );

  group("Glaive same-beam legs, deadline, death/loadout and no-trial input boundaries", () => {
    const scene = fresh("glaive");
    scene.spawned = scene.started = true;
    scene.weapon = weapon("GLAIVE");
    scene.trial.begin(1000, 21000);
    const beam = { weapon: scene.weapon, glaive: { returning: false }, vanished: false };
    scene.beams = [beam];
    scene.recordTrialContact(beam, "a", 1100);
    scene.recordTrialContact(beam, "a", 1101);
    beam.glaive.returning = true;
    scene.recordTrialContact(beam, "a", 1200);
    scene.recordTrialContact(beam, "a", 1201);
    assert.equal(scene.trial.state.completions, 1);
    assert.equal(scene.trial.state.contacts, 2);
    scene.recordTrialContact(beam, "b", 21000);
    assert.equal(scene.trial.state.contacts, 2);
    scene.alive = false;
    scene.beams = [];
    scene.updateWeaponTrial(1300);
    assert.equal(scene.trial.state.reason, "death");
    scene.recordTrialContact(beam, "b", 1400);
    assert.equal(scene.trial.state.contacts, 2);
    assert.equal(scene.trial.trackedShots, 0);
    const changed = fresh();
    changed.trial.begin(1000, 21000);
    changed.weapon = weapon("GLAIVE");
    changed.updateWeaponTrial(1100);
    assert.equal(changed.trial.state.reason, "loadout");
    const free = fresh("none");
    free.recordTrialContact(null, "ignored", 0);
    free.updateWeaponTrial(0);
    free.seedWeaponTrial();
    assert.equal(free.world.items.length, 0);
  });

  group("real offline clock pause hides trial and preserves remaining pickup window", () => {
    wall = 3_000_000;
    const scene = fresh();
    scene.started = scene.spawned = true;
    scene.weapon = weapon("RAILGUN");
    scene.trial.begin(simNow(), simNow() + 20000);
    scene.trialCard = new CardProbe();
    wall += 5000;
    const before = simNow();
    scene.freezeSim();
    wall += 30000;
    scene.freezeSim();
    assert.equal(simNow(), before);
    assert.equal(scene.trialCard.updates.at(-1)[2], false);
    scene.unfreezeSim();
    assert.equal(simNow(), before);
    scene.updateWeaponTrial(simNow());
    assert.equal(scene.trial.state.endsAt - simNow(), 15000);
    assert.equal(scene.trialCard.updates.at(-1)[2], true);
    assert.deepEqual(
      scene.trace.filter((e) => e === "sleep" || e === "wake"),
      ["sleep", "wake"],
    );
  });

  group(
    "title/result seals preserve anchor touch click, stop gameplay propagation, keep background dismissal safe",
    () => {
      const start = new ElementProbe();
      const card = new ElementProbe();
      elements.set("start", start);
      elements.set("trial-card", card);
      const scene = fresh();
      let starts = 0;
      scene.beginPlay = () => starts++;
      scene.buildStartScreen();
      const anchor = new ElementProbe("a", start),
        span = new ElementProbe("span", anchor);
      const touch = start.send("touchend", span);
      assert.equal(touch.defaultPrevented, false);
      assert.equal(touch.cancelBubble, true);
      start.send("pointerup", span);
      assert.equal(starts, 0);
      scene.onStartKeyUp({ key: "Enter", target: span });
      scene.onStartKeyUp({ key: "Tab", target: start });
      assert.equal(starts, 0);
      assert.equal(start.send("touchend").defaultPrevented, true);
      start.send("pointerup");
      assert.equal(starts, 1);
      scene.spawned = true;
      scene.shipX = scene.shipY = 1000;
      scene.seedWeaponTrial();
      const retry = new ElementProbe("a", card);
      const retryTouch = card.send("touchend", retry);
      assert.equal(retryTouch.defaultPrevented, false);
      assert.equal(retryTouch.cancelBubble, true);
      assert.equal(card.send("touchend").defaultPrevented, true);
      elements.clear();
    },
  );

  group("existing native fire admission keeps Railgun windup and release semantics", () => {
    const scene = fresh();
    scene.started = scene.spawned = true;
    scene.weapon = weapon("RAILGUN");
    scene.fireKey.isDown = true;
    for (let i = 0; i < 6; i++) scene.handleShooting(100, 1000 + i * 100);
    assert.equal(scene.trace.length, 0);
    scene.handleShooting(100, 1600);
    assert.equal(scene.trace.length, 1);
    assert.deepEqual(scene.trace[0], ["cast", 1600]);
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
console.log(`${groups} Starfall trial integration groups passed`);
