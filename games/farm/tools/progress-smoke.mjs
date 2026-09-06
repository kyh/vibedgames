// Real save/inventory/journal modules and current scene methods. Rendering and
// storage availability are controlled; full scene transitions remain native QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes, createRequire } from "node:module";
import { World } from "../src/world/world.ts";
import { store } from "../src/systems/store.ts";
import { Inventory } from "../src/systems/inventory.ts";
import { loadSave, writeSave } from "../src/systems/save.ts";
import { CROPS } from "../src/data/crops.ts";
import { FISH } from "../src/data/fish.ts";
import * as config from "../src/config.ts";
import { PhysicalGamepad } from "../../../packages/gamepad/src/physical.ts";
import { VirtualGamepad } from "../../../packages/gamepad/src/core.ts";

const require = createRequire(import.meta.url);
const Key = require("../node_modules/phaser/src/input/keyboard/keys/Key.js");
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const gameSource = read("../src/scenes/game-scene.ts");
const mineSource = read("../src/scenes/mine-scene.ts");
function method(source, name) {
  const found = new RegExp(`^  (?:(?:private|override) )?${name}\\([^]*?^  }`, "m").exec(
    source,
  )?.[0];
  assert.ok(found, `actual ${name} method`);
  return found;
}
function constant(source, name) {
  const found = new RegExp(`^(?:export )?const ${name} = [^\\n]+`, "m").exec(source)?.[0];
  assert.ok(found, `actual ${name} constant`);
  return new Function(`${stripTypeScriptTypes(found.replace(/^export /, ""))};return ${name};`)();
}
const MINE_EXIT = constant(read("../src/world/mapgen.ts"), "MINE_EXIT");
const SAVE_FLUSH_SEC = constant(gameSource, "SAVE_FLUSH_SEC");
const cosmetics = { rewards: [], text: [], sound: 0 };
let randomDraws = 0;
const deterministicMath = Object.create(Math);
deterministicMath.random = () => {
  randomDraws++;
  return 0.99;
};
const dependencies = {
  ...config,
  store,
  writeSave,
  CROPS,
  MINE_EXIT,
  SAVE_FLUSH_SEC,
  Math: deterministicMath,
  pop() {},
  burst() {},
  rewardArc: (...args) => cosmetics.rewards.push(args),
  floatText: (...args) => cosmetics.text.push(args[3]),
  Sound: { harvest: () => cosmetics.sound++ },
};
function sceneClass(source, methods) {
  const code = stripTypeScriptTypes(
    `class ActualScene extends Object {${methods.map((name) => method(source, name)).join("\n")} }`,
  );
  return new Function(...Object.keys(dependencies), `${code};return ActualScene;`)(
    ...Object.values(dependencies),
  );
}
const Game = sceneClass(gameSource, [
  "save",
  "requestSave",
  "retryPendingSave",
  "restoreFromStore",
  "showDiscovery",
  "harvest",
  "update",
  "setControlsPaused",
  "tryAction",
  "toggleInventory",
  "actionHeld",
]);
const Mine = sceneClass(mineSource, ["persist"]);
const fishingCode = stripTypeScriptTypes(read("../src/systems/fishing.ts"))
  .replace(/^import[\s\S]*?;\s*/gm, "")
  .replace(/^export /gm, "");
const Fishing = new Function(...Object.keys(dependencies), `${fishingCode};return Fishing;`)(
  ...Object.values(dependencies),
);

let disk = null,
  failing = false,
  writes = 0,
  reads = 0;
globalThis.localStorage = {
  getItem() {
    reads++;
    return disk;
  },
  setItem(_key, value) {
    writes++;
    if (failing) throw new Error("disk unavailable");
    disk = value;
  },
};
function fixture() {
  store.initNew();
  disk = null;
  failing = false;
  writes = 0;
  reads = 0;
  cosmetics.rewards.length = 0;
  cosmetics.text.length = 0;
  cosmetics.sound = 0;
  const game = new Game(),
    timers = [],
    notices = [],
    xp = [],
    events = [];
  let active = true;
  Object.assign(game, {
    farmReady: true,
    saveDirty: false,
    saveFailed: false,
    saveAcc: 0,
    seed: 42,
    day: 9,
    timeMin: 811,
    canCharge: 3,
    world: new World(),
    farmPosition: { x: 40, y: 64 },
    player: {
      x: 90,
      y: 130,
      depth: 0,
      anims: { pause() {}, resume() {} },
      setDepth(depth) {
        this.depth = depth;
      },
    },
    shadow: { setPosition() {}, setDepth() {} },
    scene: { isActive: () => active },
    cropImgs: new Map(),
    time: {
      now: 0,
      delayedCall(ms, callback) {
        const timer = {
          ms,
          callback,
          paused: false,
          removed: false,
          remove() {
            this.removed = true;
          },
        };
        timers.push(timer);
        return timer;
      },
    },
    toast: (...args) => notices.push(args[0]),
    season: () => "spring",
    awardXP: (...args) => xp.push(args),
    netTileAction: (...args) => events.push(args),
    refreshSoilTint() {},
    playerAnim() {},
    setAnim() {},
    startNew() {
      assert.fail("retained farm must not recreate its world/store");
    },
  });
  return {
    game,
    timers,
    notices,
    xp,
    events,
    setActive: (value) => {
      active = value;
    },
  };
}
function fillInventory(item = { kind: "resource", res: "stone" }) {
  store.inv = new Inventory();
  store.inv.slots = store.inv.slots.map(() => ({ item, qty: 99 }));
  store.inv.pack = store.inv.pack.map(() => ({ item, qty: 99 }));
}
let groups = 0;
function check(label, run) {
  run();
  groups++;
  console.log(`PASS ${label}`);
}

check(
  "failed saves remain dirty, retry once per three seconds, and coalesce failure/recovery notices",
  () => {
    const f = fixture(),
      g = f.game;
    failing = true;
    assert.deepEqual(g.save(), { kind: "failure", reason: "storage" });
    assert.equal(g.saveDirty, true);
    assert.equal(f.notices.length, 1);
    for (let i = 0; i < 59; i++) g.retryPendingSave(0.05);
    assert.equal(writes, 1);
    g.retryPendingSave(0.1);
    assert.equal(writes, 2);
    assert.equal(f.notices.length, 1);
    g.retryPendingSave(SAVE_FLUSH_SEC);
    assert.equal(writes, 3);
    assert.equal(f.notices.length, 1);
    failing = false;
    store.gold = 987;
    g.retryPendingSave(SAVE_FLUSH_SEC);
    assert.equal(writes, 4);
    assert.equal(g.saveDirty, false);
    assert.equal(loadSave().gold, 987);
    assert.deepEqual(f.notices.slice(1), ["Progress saved."]);
    for (let i = 0; i < 400; i++) g.retryPendingSave(0.05);
    assert.equal(writes, 4, "clean state cannot write each frame");
    g.farmReady = false;
    assert.deepEqual(g.save(), { kind: "disabled" });
    assert.equal(writes, 4);
  },
);

check(
  "mine persistence and return retain live world/clock and latest carried progress despite stale disk",
  () => {
    const f = fixture(),
      g = f.game,
      mine = new Mine();
    assert.equal(g.save().kind, "success");
    const oldDisk = disk,
      world = g.world;
    world.tilled[57] = 1;
    world.watered[57] = 1;
    world.crops.set(57, { crop: "potato", daysGrown: 4 });
    g.day = 12;
    g.timeMin = 1005;
    store.gold = 654;
    store.collections.recordHarvest("potato", "spring", 1);
    const journal = store.collections,
      inv = store.inv;
    failing = true;
    assert.equal(g.save().kind, "failure");
    assert.equal(disk, oldDisk);
    f.setActive(false);
    Object.defineProperty(g, "player", {
      get() {
        throw new Error("stopped farm cannot read destroyed player");
      },
    });
    mine.farm = g;
    store.inv.add({ kind: "resource", res: "copper" }, 4);
    store.gold += 31;
    store.hp = 41;
    mine.persist();
    assert.equal(g.saveDirty, true);
    failing = false;
    mine.persist();
    const saved = loadSave();
    assert.equal(saved.gold, 685);
    assert.equal(saved.hp, 41);
    assert.equal(saved.day, 12);
    assert.equal(saved.timeMin, 1005);
    assert.deepEqual(saved.player, { x: 90, y: 130 });
    assert.deepEqual(saved.world.crops, [[57, { crop: "potato", daysGrown: 4 }]]);
    assert.equal(saved.world.watered[57], 1);
    assert.equal(saved.collections.discoveries.length, 1);
    assert.equal(
      Inventory.fromJSON(saved.inv).count(
        (item) => item.kind === "resource" && item.res === "copper",
      ),
      4,
    );
    disk = oldDisk;
    const readsBefore = reads;
    g.restoreFromStore();
    assert.equal(reads, readsBefore, "mine return cannot load an older disk snapshot");
    assert.equal(g.world, world);
    assert.equal(store.inv, inv);
    assert.equal(store.collections, journal);
    assert.equal(g.day, 12);
    assert.equal(g.timeMin, 1005);
    assert.equal(store.gold, 685);
    assert.deepEqual(g.pendingSpawn, {
      x: MINE_EXIT.tx * config.TILE + 8,
      y: MINE_EXIT.ty * config.TILE + 8,
    });
  },
);

check(
  "actual harvest journals only accepted full/partial yields; duplicates preserve original rewards and RNG count",
  () => {
    for (const capacity of [0, 1, 99]) {
      const f = fixture(),
        g = f.game;
      fillInventory();
      if (capacity)
        store.inv.pack[0] = { item: { kind: "produce", crop: "potato" }, qty: 99 - capacity };
      g.world.crops.set(57, { crop: "potato", daysGrown: 20 });
      g.world.watered[57] = 1;
      const before = randomDraws;
      g.harvest(57);
      assert.equal(randomDraws - before, 2, "journal cannot change the authored yield RNG stream");
      const accepted = Math.min(capacity, CROPS.potato.yield[1]);
      assert.equal(store.collections.page("spring").discovered, Number(accepted > 0));
      assert.equal(cosmetics.rewards.length, Number(accepted > 0));
      assert.equal(cosmetics.text[0], accepted ? `+${accepted} Potato` : "Bag full");
      assert.equal(g.world.crops.has(57), false);
      assert.equal(g.world.watered[57], 0);
      assert.deepEqual(f.xp, [["farming", 12]]);
      assert.deepEqual(f.events, [[57, "harvest"]]);
      assert.equal(g.saveDirty, true);
      if (capacity === 99) {
        g.world.crops.set(57, { crop: "potato", daysGrown: 20 });
        g.harvest(57);
        assert.equal(f.notices.filter((s) => s.startsWith("Journal:")).length, 1);
        assert.equal(cosmetics.sound, 2);
        assert.equal(f.xp.length, 2);
      }
    }
  },
);

check(
  "actual catch records first accepted fish only; full bag keeps catch XP and the original recovery deadline",
  () => {
    for (const full of [true, false]) {
      const f = fixture(),
        g = f.game,
        fishing = new Fishing(g);
      if (full) fillInventory();
      fishing.target = FISH.carp;
      fishing.state = "reeling";
      fishing.land();
      assert.equal(store.collections.page("spring").discovered, full ? 0 : 1);
      assert.equal(cosmetics.rewards.length, full ? 0 : 1);
      assert.deepEqual(f.xp, [["fishing", 10 + FISH.carp.difficulty * 4]]);
      assert.equal(fishing.state, "done");
      assert.equal(f.timers[0].ms, 650);
      f.timers[0].callback();
      assert.equal(fishing.active, false);
      fishing.land();
      assert.equal(f.notices.filter((s) => s.startsWith("Journal:")).length, full ? 0 : 1);
      assert.equal(f.xp.length, 2);
      assert.equal(cosmetics.sound, 2);
    }
  },
);

check(
  "local online pause clears real keys/stick, keeps shared updates, and cannot replay held controller actions",
  () => {
    const f = fixture(),
      g = f.game,
      buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    const device = { connected: true, buttons, axes: [0, 0, 0, 0] };
    const pad = new PhysicalGamepad({ poll: () => [device] });
    const touch = new VirtualGamepad({ stick: { radius: 50, deadZone: 5 } });
    touch.setViewport(400, 300);
    touch.pointerDown(1, 70, 70);
    touch.pointerMove(1, 95, 70);
    const key = new Key({}, 68);
    key.onDown({
      timeStamp: 5,
      repeat: false,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    assert.equal(key.isDown, true);
    assert.equal(touch.getStick().active, true);
    assert.ok(touch.getStick().magnitude > 0);
    const calls = { clock: 0, tick: 0, send: 0, movement: 0, animals: 0, npcs: 0 };
    Object.assign(g, {
      controlsPaused: false,
      acting: false,
      uiOpen: false,
      transitioning: false,
      moving: true,
      clickPath: [{ x: 1, y: 2 }],
      pathStuck: 1,
      keys: { D: key },
      pad,
      gamepad: { pad: touch, update: () => touch.nextFrame() },
      amHost: true,
      net: { live: true, tick: () => calls.tick++ },
      reconcileClock() {},
      reconcileTiles() {},
      advanceTime: () => calls.clock++,
      handleMovement: () => calls.movement++,
      updateNet: () => calls.send++,
      animals: { update: () => calls.animals++ },
      npcs: { update: () => calls.npcs++ },
      updateHighlight() {},
      updateNightTint() {},
    });
    g.fishing = new Fishing(g);
    buttons[0].pressed = true;
    g.setControlsPaused(true);
    assert.equal(key.isDown, false);
    assert.equal(touch.getStick().active, false);
    assert.equal(g.moving, false);
    assert.deepEqual(g.clickPath, []);
    assert.equal(g.pathStuck, 0);
    assert.equal(g.actionHeld(), false);
    g.tryAction();
    g.toggleInventory();
    for (let i = 0; i < 10; i++) g.update(0, 50);
    assert.deepEqual(calls, { clock: 10, tick: 10, send: 10, movement: 0, animals: 10, npcs: 10 });
    g.setControlsPaused(false);
    let actions = 0;
    g.tryAction = () => actions++;
    g.update(0, 16);
    assert.equal(actions, 0, "held pause/resume controller button cannot become a new action");
    buttons[0].pressed = false;
    g.update(0, 16);
    buttons[0].pressed = true;
    g.update(0, 16);
    assert.equal(actions, 1, "a fresh post-resume press still works");
    g.fishing.state = "waiting";
    g.fishing.timer = 2;
    g.setControlsPaused(true);
    for (let i = 0; i < 10; i++) g.update(0, 50);
    assert.equal(
      g.fishing.timer,
      2,
      "paused catch timeout cannot consume the partner's ticking frames",
    );
    const timer = { paused: false, remove() {} };
    g.fishing.pending = timer;
    g.setControlsPaused(true);
    assert.equal(timer.paused, true);
    g.setControlsPaused(false);
    assert.equal(timer.paused, false);
    key.destroy();
  },
);
console.log(`Farm progress: ${groups} groups passed`);
