import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const strip = (source) => stripTypeScriptTypes(source).replaceAll("import.meta.env.DEV", "true");
function method(source, name) {
  const value = source.match(new RegExp(`^  (?:private )?${name}\\([^]*?^  }`, "m"))?.[0];
  assert.ok(value, `actual ${name} method`);
  return value;
}
function installed(file, name, dependencies) {
  const body = read(`../node_modules/phaser/src/${file}`).match(
    new RegExp(`${name}: function \\([^)]*\\)\\s*\\{([\\s\\S]*?)\\r?\\n    \\}`),
  )?.[1];
  assert.ok(body, `installed Phaser ${name}`);
  return new Function(...Object.keys(dependencies), `return function(){${body}}`)(
    ...Object.values(dependencies),
  );
}
const events = { SHUTDOWN: "shutdown", DESTROY: "destroy" };
const destroySystems = installed("scene/Systems.js", "destroy", {
  Events: events,
  CONST: { DESTROYED: 9 },
});
const destroyGame = installed("core/Game.js", "runDestroy", {
  Events: events,
  CanvasPool: { remove() {} },
});
class Target extends EventTarget {
  listeners = new Map();
  addEventListener(name, fn, options) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    super.addEventListener(
      name,
      fn,
      options === true || options === false ? { capture: options } : options,
    );
  }
  removeEventListener(name, fn, options) {
    this.listeners.get(name)?.delete(fn);
    super.removeEventListener(
      name,
      fn,
      options === true || options === false ? { capture: options } : options,
    );
  }
  count(name) {
    return this.listeners.get(name)?.size ?? 0;
  }
}
const phaser = { Scenes: { Events: events }, Scale: { Events: { RESIZE: "resize" } } };
const presentationSettings = () => ({ effects: "full", motion: "system", view: "standard" });
function gameSceneFixture() {
  const settings = new Set(),
    motion = new Target(),
    counts = {
      reset: 0,
      zoom: 0,
      pad: 0,
      touch: 0,
      physical: 0,
      physicalPrime: 0,
      net: 0,
      viewSettings: 0,
    };
  motion.matches = false;
  const window = { matchMedia: () => motion, location: { search: "" } };
  const watchPresentationSettings = (fn) => {
    settings.add(fn);
    return () => settings.delete(fn);
  };
  const WorldView = new Function(
    "Phaser",
    "window",
    "CommonFx",
    "watchPresentationSettings",
    "presentationSettings",
    strip(
      `class View { clouds=[]; ${method(read("../src/render/view.ts"), "constructor")} buildTerrain(){} buildStructures(){} }`,
    ) + ";return View;",
  )(
    phaser,
    window,
    class {
      setFocused() {
        counts.viewSettings++;
      }
    },
    watchPresentationSettings,
    presentationSettings,
  );
  const source = read("../src/scenes/game-scene.ts");
  const GameScene = new Function(
    "Phaser",
    "window",
    "document",
    "WorldView",
    "watchPresentationSettings",
    "resetSound",
    strip(`class GameScene { ${method(source, "resetMatchState")} ${method(source, "create")} }`) +
      ";return GameScene;",
  )(
    phaser,
    window,
    { getElementById: () => null },
    WorldView,
    watchPresentationSettings,
    () => counts.reset++,
  );
  const scene = new GameScene(),
    bus = new EventEmitter(),
    scale = new EventEmitter();
  Object.assign(scene, {
    events: bus,
    scale,
    feed: [],
    physPad: { update: () => counts.physicalPrime++, destroy: () => counts.physical++ },
    cameras: { main: { setBackgroundColor() {} } },
    applyZoom: () => counts.zoom++,
    scene: { launch() {} },
    startLocal() {
      this.net = { destroy: () => counts.net++ };
    },
    bindInput() {},
    installDebug() {},
    bindTouch() {
      this.pad = { destroy: () => counts.pad++ };
      this.touchControls = { destroy: () => counts.touch++ };
    },
  });
  scene.create();
  return { scene, bus, scale, counts, settings, motion, GameScene };
}
function destroyScene(f) {
  // Installed Systems destroy emits DESTROY after plugin/display teardown and
  // before clearing its event bus. External cleanup must not read display nodes.
  f.scene.view.clouds.push({
    setVisible() {
      throw Error("destroyed cloud accessed");
    },
  });
  destroySystems.call({ events: f.bus, settings: {} });
}
test("actual create owners release once on final Phaser destroy, including view settings and transport", () => {
  const f = gameSceneFixture();
  assert.equal(f.counts.physicalPrime, 2, "menu confirm is baselined before the first game poll");
  assert.equal(f.settings.size, 2);
  assert.equal(f.motion.count("change"), 1);
  const retainedReleases = f.bus.listeners("destroy");
  destroyScene(f);
  for (const release of retainedReleases) release();
  assert.equal(f.settings.size, 0);
  assert.equal(f.motion.count("change"), 0);
  assert.equal(f.scale.listenerCount("resize"), 0);
  for (const key of ["pad", "touch", "physical", "net"]) assert.equal(f.counts[key], 1, key);
  assert.equal(f.scene.net, null);
  assert.equal(f.scene.pad, null);
  assert.equal(f.scene.touchControls, null);
  f.motion.dispatchEvent(new Event("change"));
  for (const listener of f.settings) listener();
});
test("shutdown removes paired destroy listeners; reused scene acquires fresh owners without stale cleanup", () => {
  const f = gameSceneFixture();
  for (let round = 1; round <= 3; round++) {
    f.bus.emit("shutdown");
    assert.equal(f.bus.listenerCount("destroy"), 0);
    assert.equal(f.settings.size, 0);
    for (const key of ["pad", "touch", "physical", "net"]) assert.equal(f.counts[key], round, key);
    if (round < 3) {
      f.scene.create();
      assert.equal(f.settings.size, 2);
    }
  }
  destroyScene(f);
  assert.equal(f.counts.net, 3);
});

test("menu and HUD restart/final boundaries release only their external owners", () => {
  for (const name of ["menu", "hud"]) {
    const body = method(read(`../src/scenes/${name}-scene.ts`), "create");
    const binding = body.match(
      /this\.scale\.on[^]*?this\.events\.once\(Phaser\.Scenes\.Events\.DESTROY, release\);/,
    )?.[0];
    assert.ok(binding, `actual ${name} external-owner binding`);
    const bind = new Function("Phaser", strip(`function bind(){${binding}}`) + ";return bind;")(
      phaser,
    );
    const bus = new EventEmitter(),
      scale = new EventEmitter();
    let unwatched = 0,
      removed = 0;
    const scene = {
      events: bus,
      scale,
      input: { keyboard: new EventEmitter() },
      onMenuKeyDown() {},
      onMenuKeyUp() {},
      layout() {},
      queueRelayout() {},
    };
    for (const final of [false, true]) {
      Object.assign(scene, {
        unwatchControls: () => unwatched++,
        relayout: { remove: () => removed++ },
        activeNotice: {},
        pendingNotices: [{}],
        resultUi: {},
        resultClicked: true,
      });
      bind.call(scene);
      if (final) destroySystems.call({ events: bus, settings: {} });
      else bus.emit("shutdown");
      assert.equal(scale.listenerCount("resize"), 0);
      assert.equal(bus.listenerCount("destroy"), 0);
      if (name === "menu") {
        assert.equal(scene.unwatchControls, null);
        assert.equal(scene.relayout, null);
      } else {
        assert.equal(scene.activeNotice, null);
        assert.deepEqual(scene.pendingNotices, []);
        assert.equal(scene.resultUi, null);
      }
    }
    if (name === "menu") {
      assert.equal(unwatched, 2);
      assert.equal(removed, 2);
    }
  }
});

function embedFixture(window) {
  window.parent = window;
  const source = strip(
    read("../../../packages/embed/src/protocol.ts") +
      "\n" +
      read("../../../packages/embed/src/game.ts"),
  )
    .replace(/^import[\s\S]*?;\s*/gm, "")
    .replace(/^export /gm, "");
  return new Function(
    "window",
    "HTMLElement",
    `${source};return {setPauseHandlers,notifyGameStarted,pauseGame,resumeGame,isPausable};`,
  )(window, class extends Target {});
}
async function appFixture(online) {
  const window = new Target(),
    document = new Target(),
    timers = new Map(),
    calls = [],
    scenes = gameSceneFixture();
  const embed = embedFixture(window);
  let hooks = {},
    timerId = 0,
    destroyed = false,
    game;
  document.fonts = { load: () => Promise.resolve() };
  class HudScene {
    escConsumed = false;
  }
  const hud = new HudScene();
  Object.assign(scenes.scene, {
    isOnline: () => online,
    setControlsPaused: (value) => calls.push(`controls:${value}`),
    diagnostics: () => ({ phase: "playing" }),
  });
  class Game {
    constructor() {
      game = this;
    }
    events = new EventEmitter();
    scene = {
      getScene: (key) => {
        assert.equal(destroyed, false, "no scene access after manager destruction");
        return key === "Game" ? scenes.scene : hud;
      },
      isActive: () => {
        assert.equal(destroyed, false);
        return true;
      },
      destroy: () => {
        destroyScene(scenes);
        destroyed = true;
      },
    };
    loop = {
      frame: 31,
      sleep: () => calls.push("sleep"),
      wake: () => calls.push("wake"),
      destroy: () => calls.push("loop:destroy"),
    };
    sound = {
      pauseAll: () => calls.push("phaser:pause"),
      resumeAll: () => calls.push("phaser:resume"),
    };
    scale = {
      refresh: () => {
        assert.equal(destroyed, false);
        calls.push("scale");
      },
    };
    renderer = null;
    runDestroy = destroyGame;
  }
  const deps = {
    Phaser: { Game, WEBGL: 1, Scale: { RESIZE: 1 }, Core: { Events: events } },
    window,
    document,
    GameScene: scenes.GameScene,
    HudScene,
    MenuScene: class {
      key = "Menu";
    },
    BootScene: class {
      key = "Boot";
    },
    setPauseHandlers: (value) => {
      hooks = value;
      return embed.setPauseHandlers(value);
    },
    showPauseOverlay: () => calls.push("overlay:show"),
    hidePauseOverlay: () => calls.push("overlay:hide"),
    setSoundPaused: (value) => calls.push(`sound:${value}`),
    disposeSound: () => calls.push("sound:dispose"),
    soundDiagnostics: () => ({ ownedSources: 0 }),
    setTimeout: (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const source = strip(read("../src/main.ts")).replace(/^import[\s\S]*?;\s*/gm, "");
  await new Function(...Object.keys(deps), `${source};return fontReady;`)(...Object.values(deps));
  return { window, document, game, scenes, timers, calls, hooks: () => hooks, hud, embed };
}
test("paused offline/online Game.runDestroy releases the actual embed owner without querying dead scenes", async () => {
  for (const online of [false, true]) {
    const f = await appFixture(online);
    const baselineKeys = f.window.count("keydown");
    assert.equal(f.timers.size, 0, "resolved font cancels its fallback timeout");
    f.embed.notifyGameStarted();
    f.embed.pauseGame();
    assert.equal(f.window.count("keydown"), baselineKeys + 1);
    assert.equal(f.window.count("keyup"), 1);
    f.window.dispatchEvent(new Event("resize"));
    const pending = [...f.timers.values()][0],
      stale = f.hooks();
    assert.ok(pending);
    const retainedDisposes = f.game.events.listeners("destroy");
    f.game.runDestroy();
    for (const dispose of retainedDisposes) dispose();
    assert.equal(f.scenes.counts.net, 1);
    assert.equal(f.scenes.settings.size, 0);
    assert.equal(f.window.count("resize"), 0);
    assert.equal(f.document.count("visibilitychange"), 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.window.count("keydown"), baselineKeys);
    assert.equal(f.window.count("keyup"), 0);
    assert.equal(f.embed.isPausable(), false);
    assert.equal(f.window["__GAME_DIAGNOSTICS__"].phase, "disposed");
    const finalCalls = [...f.calls];
    pending();
    stale.onPause();
    stale.onResume();
    assert.equal(stale.escapePauses(), false);
    f.embed.resumeGame();
    f.embed.pauseGame();
    f.window.dispatchEvent(new Event("resize"));
    f.document.dispatchEvent(new Event("visibilitychange"));
    f.game.events.emit("destroy");
    assert.deepEqual(
      f.calls,
      finalCalls,
      "retained callbacks cannot resume the dead scene or loop",
    );
    assert.equal(f.calls.filter((x) => x === "sound:dispose").length, 1);
    assert.equal(f.calls.includes("scale"), false);
  }
});
test("old app destroy preserves a newer actual embed pause owner and its active key gate", async () => {
  const f = await appFixture(true);
  const baselineKeys = f.window.count("keydown");
  f.embed.notifyGameStarted();
  f.embed.pauseGame();
  const newerCalls = [];
  const releaseNewer = f.embed.setPauseHandlers({
    onPause: () => newerCalls.push("pause"),
    onResume: () => newerCalls.push("resume"),
  });
  const retainedDisposes = f.game.events.listeners("destroy");
  f.game.runDestroy();
  for (const dispose of retainedDisposes) dispose();
  assert.equal(f.window.count("keyup"), 1, "old release cannot remove a newer owner's paused gate");
  f.embed.resumeGame();
  assert.deepEqual(newerCalls, ["resume"]);
  assert.equal(f.embed.isPausable(), true);
  assert.equal(f.window.count("keydown"), baselineKeys);
  assert.equal(f.window.count("keyup"), 0);
  f.embed.pauseGame();
  assert.deepEqual(newerCalls, ["resume", "pause"]);
  releaseNewer();
  releaseNewer();
  f.embed.resumeGame();
  assert.deepEqual(newerCalls, ["resume", "pause"]);
  assert.equal(f.embed.isPausable(), false);
  assert.equal(f.window.count("keyup"), 0);
  assert.equal(f.calls.includes("wake"), false);
  assert.equal(f.calls.filter((x) => x === "sound:dispose").length, 1);
});
test("unchanged online pause keeps simulation live; offline pause owns one sleep/wake and HUD Escape", async () => {
  for (const online of [true, false]) {
    const f = await appFixture(online);
    f.embed.notifyGameStarted();
    f.embed.pauseGame();
    f.embed.resumeGame();
    assert.deepEqual(f.calls.slice(0, 2), ["controls:true", "sound:true"]);
    assert.equal(f.calls.includes("sleep"), !online);
    assert.equal(f.calls.includes("wake"), !online);
    f.hud.escConsumed = true;
    assert.equal(f.hooks().escapePauses(), false);
    f.hud.escConsumed = false;
    assert.equal(f.hooks().escapePauses(), true);
    f.game.runDestroy();
  }
});
