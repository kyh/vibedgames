import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { environment, settle } from "./audio-harness.mjs";

const require = createRequire(import.meta.url);
const phaserRoot = dirname(require.resolve("phaser/package.json"));
const EventEmitter = require(join(phaserRoot, "src/events/EventEmitter.js"));
const Events = require(join(phaserRoot, "src/core/events/index.js"));
const compile = (text) =>
  stripTypeScriptTypes(text.replace(/^import\b[^;]+;\s*/gm, ""), { mode: "transform" })
    .replace(/^export (function|const|class) /gm, "$1 ")
    .replace(/^export \{\};?$/gm, "");
const main = compile(
  readFileSync(
    process.env.LUNERFALL_MAIN_SOURCE ?? new URL("../src/main.ts", import.meta.url),
    "utf8",
  ),
).replace('import("./trailer/trailer-director")', "loadTrailer()");
const embedCode = compile(
  readFileSync(new URL("../../../packages/embed/src/game.ts", import.meta.url), "utf8"),
);
const diagCode = compile(readFileSync(new URL("../src/sys/diag.ts", import.meta.url), "utf8"));
const gameSource = readFileSync(join(phaserRoot, "src/core/Game.js"), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const gameMethod = (name) => {
  const text = new RegExp(`^    ${name}: (function[^]*?^    })`, "m").exec(gameSource)?.[1];
  assert.ok(text);
  return new Function("Events", "CanvasPool", `return (${text});`)(Events, { remove() {} });
};
const destroy = gameMethod("destroy");
const runDestroy = gameMethod("runDestroy");
class Surface extends EventTarget {
  listeners = new Map();
  addEventListener(name, fn, options) {
    const group = this.listeners.get(name) ?? new Set();
    group.add(fn);
    this.listeners.set(name, group);
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
}

function fixture({ search = "", online = false, versus = false, active = true } = {}) {
  const audio = environment();
  const window = new Surface();
  window.parent = window;
  window.location = { search };
  const embed = new Function(
    "window",
    "HTMLElement",
    "GAME_PAUSED_MESSAGE",
    "GAME_STARTED_MESSAGE",
    "isPauseGameMessage",
    `${embedCode}; return {setPauseHandlers,notifyGameStarted,pauseGame,resumeGame,isPausable};`,
  )(
    window,
    class Element {
      tagName = "DIV";
    },
    "paused",
    "started",
    () => false,
  );
  const installTestHooks = new Function(
    "globalThis",
    "reseed",
    `${diagCode}; return installTestHooks;`,
  )(window, () => {});
  const counts = {
    mount: 0,
    touchDispose: 0,
    show: 0,
    hide: 0,
    sleep: 0,
    wake: 0,
    reads: 0,
    scenes: 0,
    loops: 0,
    imports: 0,
    director: 0,
  };
  let sceneDestroyed = false;
  let controlsPaused = false;
  let retained;
  let resolveTrailer;
  const trailer = new Promise((resolve) => {
    resolveTrailer = resolve;
  });
  class GameScene {
    isOnline() {
      return online;
    }
    isVersus() {
      return versus;
    }
    setControlsPaused(value) {
      controlsPaused = value;
    }
  }
  const scene = new GameScene();
  class Game {
    events = new EventEmitter();
    renderer = null;
    canvas = null;
    domContainer = null;
    scene = {
      getScene(key) {
        assert.equal(key, "game");
        assert.equal(
          sceneDestroyed,
          false,
          "Phaser destroys SceneManager before the app DESTROY event",
        );
        counts.reads++;
        return scene;
      },
      isActive: () => active,
      destroy: () => {
        sceneDestroyed = true;
        counts.scenes++;
      },
    };
    loop = {
      sleep: () => counts.sleep++,
      wake: () => counts.wake++,
      destroy: () => counts.loops++,
    };
  }
  const globals = {
    Phaser: { Game, WEBGL: 1, Scale: { FIT: 1, CENTER_BOTH: 1 }, Core: { Events } },
    setPauseHandlers(next) {
      retained = next;
      return embed.setPauseHandlers(next);
    },
    sfx: audio.sfx,
    BASE_H: 360,
    BASE_W: 640,
    window,
    globalThis: window,
    createLunerfallPauseOverlay: () => ({ show: () => counts.show++, hide: () => counts.hide++ }),
    BootScene: class BootScene {
      key = "boot";
    },
    GameScene,
    SelectScene: class SelectScene {
      key = "select";
    },
    installTestHooks,
    mountTouchHud: () => counts.mount++,
    destroyTouchHud: () => counts.touchDispose++,
    loadTrailer() {
      counts.imports++;
      return trailer;
    },
  };
  const game = new Function(...Object.keys(globals), `${main};return game;`)(
    ...Object.values(globals),
  );
  window["__lf"] = { scene };
  const cleanup = game.events.listeners(Events.DESTROY).at(-1);
  return {
    game,
    window,
    embed,
    audio,
    counts,
    retained,
    controlsPaused: () => controlsPaused,
    destroy() {
      destroy.call(game, true);
      runDestroy.call(game);
    },
    repeatCleanup: () => cleanup(),
    resolveTrailer: () =>
      resolveTrailer({
        initTrailer: (target) => {
          assert.equal(target, game);
          counts.director++;
        },
      }),
  };
}

test("actual Phaser final path releases pause owner, audio, touch and owned globals after SceneManager dies", () => {
  const f = fixture();
  f.audio.sfx.unlock();
  f.audio.sfx.hit("local");
  assert.equal(f.window["__game"], f.game);
  f.window["__GAME_TEST_HOOKS__"].setState("no-transition");
  f.embed.notifyGameStarted();
  f.embed.pauseGame();
  assert.equal(f.window.listeners.get("keyup").size, 1);
  assert.equal(f.counts.sleep, 1);
  assert.equal(f.controlsPaused(), true);
  f.destroy();
  assert.equal(f.window.listeners.get("keyup").size, 0);
  assert.equal(f.embed.isPausable(), false);
  assert.equal(f.counts.wake, 0, "release does not resume a destroyed game");
  for (const key of [
    "__game",
    "__lf",
    "__GAME_DIAGNOSTICS__",
    "__GAME_TEST_HOOKS__",
    "__LUNERFALL_AUDIO__",
  ])
    assert.equal(Object.hasOwn(f.window, key), false, key);
  const before = { ...f.counts };
  f.retained.onPause();
  f.retained.onResume();
  f.repeatCleanup();
  assert.equal(f.retained.escapePauses(), false);
  assert.deepEqual(f.counts, before);
  assert.equal(f.counts.scenes, 1);
  assert.equal(f.counts.loops, 1);
  assert.equal(f.counts.touchDispose, 1);
  assert.equal(f.audio.sfx.diagnostics().disposed, true);
  assert.equal(f.audio.sfx.diagnostics().ownedVoices, 0);
  assert.equal(f.audio.timers.size, 0);
  assert.equal(f.audio.contexts[0].closed, 1);
});

test("online pause stays local; solo resumes only its loop; hub/versus retain Escape ownership", async () => {
  for (const online of [false, true]) {
    const f = fixture({ online });
    f.audio.sfx.unlock();
    f.embed.notifyGameStarted();
    f.embed.pauseGame();
    assert.equal(f.controlsPaused(), true);
    assert.equal(f.audio.sfx.diagnostics().paused, true);
    assert.equal(f.counts.sleep, online ? 0 : 1);
    await settle();
    f.embed.resumeGame();
    await settle();
    assert.equal(f.controlsPaused(), false);
    assert.equal(f.audio.sfx.diagnostics().paused, false);
    assert.equal(f.counts.wake, online ? 0 : 1);
    f.destroy();
  }
  for (const options of [{ active: false }, { versus: true }]) {
    const f = fixture(options);
    assert.equal(f.retained.escapePauses(), false);
    f.destroy();
  }
});

test("old app disposal leaves a newer pause installation and replacement diagnostics intact", () => {
  const f = fixture();
  let pauses = 0;
  const release = f.embed.setPauseHandlers({ onPause: () => pauses++ });
  const replacement = { replacement: true };
  for (const key of ["__game", "__lf", "__GAME_DIAGNOSTICS__", "__GAME_TEST_HOOKS__"])
    f.window[key] = replacement;
  Object.defineProperty(f.window, "__LUNERFALL_AUDIO__", {
    configurable: true,
    get: () => replacement,
  });
  f.destroy();
  for (const key of [
    "__game",
    "__lf",
    "__GAME_DIAGNOSTICS__",
    "__GAME_TEST_HOOKS__",
    "__LUNERFALL_AUDIO__",
  ])
    assert.equal(f.window[key], replacement);
  f.embed.notifyGameStarted();
  f.embed.pauseGame();
  assert.equal(pauses, 1);
  release();
});

test("normal/viewer never import trailer; lazy import completed after final destruction stays inert", async () => {
  for (const search of ["", "?viewer=1"]) {
    const f = fixture({ search });
    assert.equal(f.counts.imports, 0);
    assert.equal(f.counts.mount, search ? 0 : 1);
    f.destroy();
  }
  for (const deadFirst of [false, true]) {
    const f = fixture({ search: "?trailer=1" });
    assert.equal(f.counts.imports, 1);
    assert.equal(f.counts.mount, 0);
    if (deadFirst) f.destroy();
    f.resolveTrailer();
    await settle();
    assert.equal(f.counts.director, deadFirst ? 0 : 1);
    if (!deadFirst) f.destroy();
  }
});

const trailerSource = readFileSync(
  process.env.LUNERFALL_TRAILER_SOURCE ??
    new URL("../src/trailer/trailer-director.ts", import.meta.url),
  "utf8",
);
const entry = /^export function initTrailer\([^]*?^}/m.exec(trailerSource)?.[0];
assert.ok(entry);
const bootCode = compile(entry);
function trailerFixture() {
  const f = fixture({ active: false });
  const timers = new Map();
  let timerId = 0;
  let ready = false;
  let reads = 0;
  let config;
  const freezes = [];
  class GameScene {
    trailerFreeze(value) {
      freezes.push(value);
    }
  }
  const scene = new GameScene();
  f.game.scene.getScene = () => {
    assert.equal(f.counts.scenes, 0);
    reads++;
    return ready ? scene : null;
  };
  f.game.scene.isActive = () => ready;
  const beats = [{ id: 1 }, { id: 2 }];
  const boot = new Function(
    "Phaser",
    "GameScene",
    "window",
    "sfx",
    "BEATS",
    "toScene",
    "runTrailer",
    `${bootCode};return initTrailer;`,
  )(
    { Core: { Events } },
    GameScene,
    {
      setInterval(fn, ms) {
        assert.equal(ms, 80);
        timers.set(++timerId, fn);
        return timerId;
      },
      clearInterval: (id) => timers.delete(id),
    },
    f.audio.sfx,
    beats,
    (target, beat) => {
      assert.equal(target, scene);
      return beat;
    },
    (next) => {
      assert.equal(config, undefined, "only one trailer handoff");
      config = next;
    },
  );
  boot(f.game);
  return {
    ...f,
    timers,
    freezes,
    beats,
    ready: () => {
      ready = true;
    },
    reads: () => reads,
    config: () => config,
  };
}

test("pending trailer polling belongs to final Game destroy, including an already-dequeued callback", () => {
  const f = trailerFixture();
  assert.equal(f.audio.sfx.muted, true);
  assert.equal(f.audio.contexts.length, 0);
  const tick = [...f.timers.values()][0];
  for (let i = 0; i < 20; i++) tick();
  assert.equal(f.timers.size, 1);
  f.destroy();
  const reads = f.reads();
  tick();
  assert.equal(f.reads(), reads);
  assert.equal(f.timers.size, 0);
  assert.equal(f.config(), undefined);
});

test("ready trailer hands off once with original staging and native-gesture audio semantics", () => {
  const f = trailerFixture();
  const tick = [...f.timers.values()][0];
  f.ready();
  tick();
  tick();
  assert.deepEqual(f.freezes, [9999]);
  assert.equal(f.timers.size, 0);
  assert.equal(
    f.game.events.listenerCount(Events.DESTROY),
    2,
    "boot listener released; two app owners remain",
  );
  assert.equal(f.config().vignette, false);
  assert.deepEqual(f.config().scenes, f.beats);
  assert.equal(f.audio.contexts.length, 0);
  f.config().onGesture();
  assert.equal(f.audio.sfx.muted, false);
  assert.equal(f.audio.timers.size, 1);
  f.destroy();
  f.config().onGesture();
  assert.equal(f.audio.contexts.length, 1);
  assert.equal(f.audio.timers.size, 0);
});
