import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";
import { audioHarness, settle } from "./audio-harness.mjs";

function source(path) {
  return stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), "utf8"), {
    mode: "strip",
  })
    .replace(/^import[\s\S]*?;\s*/gm, "")
    .replaceAll("import.meta.env.DEV", "true")
    .replace(/^export /gm, "");
}
const phaser = readFileSync(
  new URL("../node_modules/phaser/src/core/Game.js", import.meta.url),
  "utf8",
);
const destroyBody = phaser.match(/runDestroy: function \(\)\s*\{([\s\S]*?)\r?\n    \}/)?.[1];
assert.ok(destroyBody, "fixture must use the installed Phaser destruction order");
const runDestroy = new Function("Events", "CanvasPool", `return function () {${destroyBody}}`)(
  { DESTROY: "destroy" },
  { remove() {} },
);

class TrackedTarget extends EventTarget {
  listeners = new Map();
  addEventListener(name, listener, options) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
    super.addEventListener(name, listener, options);
  }
  removeEventListener(name, listener, options) {
    this.listeners.get(name)?.delete(listener);
    super.removeEventListener(name, listener, options);
  }
  count(name) {
    return this.listeners.get(name)?.size ?? 0;
  }
}

function fixture(phase = "farm", online = true) {
  const audio = audioHarness(),
    { Sound } = audio,
    window = new TrackedTarget(),
    document = new TrackedTarget(),
    timers = new Map(),
    calls = [],
    touch = { created: 0, destroyed: 0, synced: 0, options: null };
  let hooks = {},
    seq = 0,
    sceneDestroyed = false;
  class GameScene {
    player = { x: 42, y: 64 };
    controlsPaused = false;
    isOnline() {
      return online;
    }
    setControlsPaused(value) {
      this.controlsPaused = value;
      calls.push(`controls:${value}`);
    }
  }
  class MineScene {
    player = { x: 17, y: 23 };
  }
  class HudScene {
    modalOpen = false;
  }
  class PlaceholderScene {
    active = false;
  }
  const farm = new GameScene(),
    mine = new MineScene(),
    hud = new HudScene();
  const active = new Set(phase === "farm" ? ["Game", "Hud"] : phase === "mine" ? ["Mine"] : []);
  const scene = {
    getScenes() {
      assert.equal(sceneDestroyed, false);
      return phase === "farm" ? [farm] : phase === "mine" ? [mine] : [];
    },
    isActive(key) {
      assert.equal(sceneDestroyed, false);
      return active.has(key);
    },
    getScene(key) {
      assert.equal(sceneDestroyed, false);
      return key === "Game" ? farm : key === "Mine" ? mine : hud;
    },
    destroy() {
      sceneDestroyed = true;
      calls.push("scenes:destroy");
    },
  };
  const touchOwner = new Function(
    "createTouchControls",
    "Sound",
    `${source("../src/touch-controls.ts")}\nreturn {mountTouchControls,syncTouchControls,destroyTouchControls};`,
  )((options) => {
    touch.created++;
    touch.options = options;
    return { sync: () => touch.synced++, destroy: () => touch.destroyed++ };
  }, Sound);
  class Game {
    scene = scene;
    events = new EventEmitter();
    loop = {
      frame: 9,
      sleep: () => calls.push("loop:sleep"),
      wake: () => calls.push("loop:wake"),
      destroy: () => calls.push("loop:destroy"),
    };
    sound = {
      pauseAll: () => calls.push("phaser:pause"),
      resumeAll: () => calls.push("phaser:resume"),
    };
    scale = {
      refresh: () => {
        assert.equal(sceneDestroyed, false);
        calls.push("scale:refresh");
      },
    };
    renderer = null;
    runDestroy = runDestroy;
  }
  const deps = {
    Phaser: { Game, WEBGL: 1, Scale: { RESIZE: 1 }, Core: { Events: { DESTROY: "destroy" } } },
    setPauseHandlers: (next) => {
      hooks = next;
    },
    pauseOverlay: {
      show: () => calls.push("overlay:show"),
      hide: () => calls.push("overlay:hide"),
    },
    BootScene: PlaceholderScene,
    TitleScene: PlaceholderScene,
    GameScene,
    MineScene,
    MineHudScene: PlaceholderScene,
    HudScene,
    InventoryScene: PlaceholderScene,
    fxCounts: () => null,
    Sound,
    store: { gold: 81 },
    destroyTouchControls: touchOwner.destroyTouchControls,
    window,
    document,
    setTimeout: (fn) => {
      timers.set(++seq, fn);
      return seq;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const game = new Function(...Object.keys(deps), `${source("../src/main.ts")}\nreturn game;`)(
    ...Object.values(deps),
  );
  return {
    ...audio,
    window,
    document,
    game,
    farm,
    hud,
    active,
    calls,
    touch,
    touchOwner,
    timers,
    hooks: () => hooks,
  };
}

let groups = 0;
async function check(label, run) {
  await run();
  groups++;
  console.log(`PASS ${label}`);
}
await check(
  "online pause fences local control/audio before returning without sleeping the shared loop",
  async () => {
    const f = fixture();
    f.Sound.muted = false;
    await settle();
    f.Sound.startMusic("farm");
    f.Sound.wake();
    f.hooks().onPause();
    assert.equal(f.calls[0], "controls:true");
    assert.equal(f.farm.controlsPaused, true);
    assert.equal(f.calls.includes("loop:sleep"), false);
    assert.equal(f.Sound.diagnostics().ownedVoices, 0);
    f.hooks().onResume();
    await settle();
    assert.equal(f.farm.controlsPaused, false);
    assert.equal(f.calls.includes("loop:wake"), false);
    assert.equal(f.Sound.diagnostics().schedulerCount, 1);
    f.game.runDestroy();
  },
);
await check(
  "offline farm/mine preserve loop ownership and inventory/modal Escape priority",
  async () => {
    for (const phase of ["farm", "mine"]) {
      const f = fixture(phase, false);
      f.hooks().onPause();
      assert.ok(f.calls.includes("loop:sleep"));
      assert.ok(f.calls.includes("phaser:pause"));
      f.hooks().onResume();
      assert.ok(f.calls.includes("loop:wake"));
      assert.ok(f.calls.includes("phaser:resume"));
      f.active.add("Inventory");
      assert.equal(f.hooks().escapePauses(), false);
      f.active.delete("Inventory");
      f.hud.modalOpen = true;
      assert.equal(f.hooks().escapePauses(), false);
      f.hud.modalOpen = false;
      assert.equal(f.hooks().escapePauses(), true);
      f.game.runDestroy();
    }
  },
);
await check(
  "paused live farm transfers loop ownership only after committed Mine creation",
  async () => {
    const f = fixture();
    f.hooks().onPause();
    assert.equal(f.calls.includes("loop:sleep"), false);
    f.active.delete("Game");
    f.active.add("Mine");
    f.game.events.emit("farm-enter-mine");
    f.game.events.emit("farm-enter-mine");
    assert.equal(f.calls.filter((c) => c === "loop:sleep").length, 1);
    assert.equal(f.Sound.diagnostics().paused, true);
    f.hooks().onResume();
    assert.equal(f.calls.filter((c) => c === "loop:wake").length, 1);
    assert.equal(f.Sound.diagnostics().paused, false);
    f.game.events.emit("farm-enter-mine");
    assert.equal(f.calls.filter((c) => c === "loop:sleep").length, 1);
    f.game.runDestroy();
    assert.equal(f.game.events.listenerCount("farm-enter-mine"), 0);
  },
);
await check(
  "actual Phaser final order closes external owners without resolving destroyed scenes",
  async () => {
    const f = fixture();
    f.touchOwner.mountTouchControls();
    f.touchOwner.mountTouchControls();
    f.touch.options.mute.set(false);
    await settle();
    f.Sound.startMusic("mine");
    f.Sound.wake();
    assert.equal(f.touch.created, 1);
    f.window.dispatchEvent(new Event("resize"));
    const staleTimer = [...f.timers.values()][0],
      staleHooks = f.hooks();
    assert.equal(f.timers.size, 1);
    assert.equal(f.window.count("resize"), 1);
    assert.equal(f.document.count("visibilitychange"), 1);
    f.game.runDestroy();
    await settle();
    assert.ok(f.calls.indexOf("scenes:destroy") < f.calls.lastIndexOf("overlay:hide"));
    assert.deepEqual(f.hooks(), {});
    assert.equal(f.window.count("resize"), 0);
    assert.equal(f.document.count("visibilitychange"), 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.touch.destroyed, 1);
    assert.equal(f.Sound.diagnostics().disposed, true);
    assert.equal(f.Sound.diagnostics().ownedVoices, 0);
    assert.equal(f.Sound.diagnostics().scheduledVoices, 0);
    assert.equal(f.Sound.diagnostics().schedulerCount, 0);
    assert.equal(f.contexts[0].closeCalls, 1);
    const count = f.calls.length;
    staleTimer();
    staleHooks.onPause();
    staleHooks.onResume();
    assert.equal(staleHooks.escapePauses(), false);
    f.window.dispatchEvent(new Event("resize"));
    f.document.dispatchEvent(new Event("visibilitychange"));
    f.touchOwner.mountTouchControls();
    f.touchOwner.syncTouchControls();
    f.touchOwner.destroyTouchControls();
    assert.equal(f.calls.length, count);
    assert.equal(f.touch.created, 1);
    assert.equal(f.touch.destroyed, 1);
    const diag = f.window["__GAME_DIAGNOSTICS__"];
    assert.equal(diag.phase, "menu");
    assert.equal(diag.player, null);
    assert.equal(diag.audio.disposed, true);
  },
);
console.log(`PASS ${groups} actual main/touch/Phaser destruction groups`);
