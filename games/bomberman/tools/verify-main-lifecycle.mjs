import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const phaserRoot = dirname(require.resolve("phaser/package.json"));
const EventEmitter = require(join(phaserRoot, "src/events/EventEmitter.js"));
const GameEvents = require(join(phaserRoot, "src/core/events/index.js"));
const compile = (source) =>
  stripTypeScriptTypes(source.replace(/^import[^;]+;$/gm, "").replace(/^export /gm, ""), {
    mode: "strip",
  });
const main = compile(
  readFileSync(
    process.env.BOMBERMAN_MAIN_SOURCE ?? new URL("../src/main.ts", import.meta.url),
    "utf8",
  ),
);
const embed = compile(
  readFileSync(new URL("../../../packages/embed/src/game.ts", import.meta.url), "utf8"),
);
function phaserMethod(file, name, context = {}) {
  const source = readFileSync(join(phaserRoot, "src", file), "utf8").replaceAll("\r\n", "\n");
  const method = new RegExp(`^    ${name}: (function[^]*?^    })`, "m").exec(source)?.[1];
  assert.ok(method, `${file}:${name}`);
  return new Function(...Object.keys(context), `return (${method});`)(...Object.values(context));
}
const requestDestroy = phaserMethod("core/Game.js", "destroy");
const runDestroy = phaserMethod("core/Game.js", "runDestroy", {
  Events: GameEvents,
  CanvasPool: { remove() {} },
});
const destroyScale = phaserMethod("scale/ScaleManager.js", "destroy");
const refreshScale = phaserMethod("scale/ScaleManager.js", "refresh", { Events: {}, CONST: {} });
const updateScale = phaserMethod("scale/ScaleManager.js", "updateScale", { Events: {}, CONST: {} });

class Surface extends EventTarget {
  listeners = new Map();
  addEventListener(type, callback, options) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(callback);
    this.listeners.set(type, set);
    super.addEventListener(type, callback, options);
  }
  removeEventListener(type, callback, options) {
    this.listeners.get(type)?.delete(callback);
    // Normalize Node's boolean-capture removal; the browser accepts either form.
    super.removeEventListener(
      type,
      callback,
      options === true || options === false ? { capture: options } : options,
    );
  }
  keyBlocked() {
    const event = new Event("keyup");
    let blocked = false;
    event.stopPropagation = () => {
      blocked = true;
    };
    this.dispatchEvent(event);
    return blocked;
  }
}

function fixture({ freezable = true } = {}) {
  const window = new Surface();
  window.parent = window;
  const document = new Surface();
  document.hidden = false;
  const timers = new Map();
  let serial = 0;
  const api = new Function(
    "window",
    "HTMLElement",
    "GAME_STARTED_MESSAGE",
    "GAME_PAUSED_MESSAGE",
    "isPauseGameMessage",
    `${embed};return { setPauseHandlers, notifyGameStarted, pauseGame, resumeGame, isPausable };`,
  )(
    window,
    class Element {
      tagName = "DIV";
    },
    "started",
    "paused",
    () => false,
  );
  const counts = {
    scale: 0,
    scenes: 0,
    postDestroyReads: 0,
    pause: 0,
    resume: 0,
    soundPause: 0,
    soundResume: 0,
    hide: 0,
    show: 0,
    release: 0,
  };
  const audio = [];
  let savedHandlers;
  let savedDestroy;
  let activeScene;
  class Game {
    destroy(...args) {
      requestDestroy.apply(this, args);
    }
    runDestroy() {
      runDestroy.call(this);
    }
    constructor() {
      this.events = new EventEmitter();
      this.renderer = null;
      this.canvas = null;
      this.domContainer = null;
      this.loop = { destroy() {} };
      this.scale = {
        canvas: { style: {} },
        width: 800,
        height: 600,
        refresh() {
          counts.scale++;
        },
        updateScale,
        removeAllListeners() {},
        stopListeners() {},
        parentSize: { destroy() {} },
        gameSize: { destroy() {} },
        baseSize: { destroy() {} },
        displaySize: { destroy() {} },
      };
      // Installed ScaleManager owns its DESTROY listener before app startup.
      this.events.once(GameEvents.DESTROY, destroyScale, this.scale);
      let destroyed = false;
      const scene = {
        freezable,
        paused: false,
        setPresentationPaused(value) {
          this.paused = value;
        },
        pauseSimulation() {
          counts.pause++;
        },
        resumeSimulation() {
          counts.resume++;
        },
      };
      activeScene = scene;
      this.scene = {
        getScene() {
          if (destroyed) counts.postDestroyReads++;
          return destroyed ? null : scene;
        },
        destroy() {
          destroyed = true;
          counts.scenes++;
        },
      };
      this.sound = {
        pauseAll() {
          counts.soundPause++;
        },
        resumeAll() {
          counts.soundResume++;
        },
      };
      const once = this.events.once.bind(this.events);
      this.events.once = (event, callback, context) => {
        if (event === GameEvents.DESTROY) savedDestroy = callback;
        return once(event, callback, context);
      };
    }
  }
  const args = {
    Phaser: { Game, WEBGL: 1, Scale: { RESIZE: 1 }, Core: { Events: GameEvents } },
    window,
    document,
    BootScene: class BootScene {
      key = "Boot";
    },
    GameScene: class GameScene {
      key = "Game";
    },
    setPauseHandlers(handlers) {
      savedHandlers = handlers;
      const release = api.setPauseHandlers(handlers);
      return () => {
        counts.release++;
        release();
      };
    },
    createBombermanPauseOverlay: () => ({
      show() {
        counts.show++;
      },
      hide() {
        counts.hide++;
      },
    }),
    pauseAudio: (paused) => audio.push(paused),
    setTimeout(callback, delay) {
      assert.equal(delay, 150);
      timers.set(++serial, callback);
      return serial;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const game = new Function(...Object.keys(args), `${main};return game;`)(...Object.values(args));
  const destroy = () => {
    // Real Phaser destroy requests teardown; the following frame owns event order.
    game.destroy(true);
    assert.equal(game.pendingDestroy, true);
    game.runDestroy();
  };
  return {
    game,
    window,
    document,
    timers,
    counts,
    audio,
    api,
    scene: activeScene,
    handlers: savedHandlers,
    destroy,
    repeatDestroy: () => savedDestroy?.(),
  };
}

test("final Phaser destroy cancels scale work and fences already queued callbacks", () => {
  const env = fixture();
  const resize = [...env.window.listeners.get("resize")][0];
  const visibility = [...env.document.listeners.get("visibilitychange")][0];
  resize();
  resize();
  assert.equal(env.timers.size, 1);
  const pending = [...env.timers.values()][0];
  env.destroy();
  assert.equal(env.game.scale.canvas, null, "actual ScaleManager is destroyed first");
  // A stale real Phaser refresh is unsafe; this is the original reported failure.
  assert.throws(() => refreshScale.call(env.game.scale), /null.*style/);
  assert.equal(env.timers.size, 0);
  assert.equal(env.window.listeners.get("resize").size, 0);
  assert.equal(env.document.listeners.get("visibilitychange").size, 0);
  pending();
  resize();
  visibility();
  env.handlers.onPause();
  env.handlers.onResume();
  env.repeatDestroy();
  assert.equal(env.timers.size, 0);
  assert.equal(env.counts.scale, 0);
  assert.equal(env.counts.postDestroyReads, 0);
  assert.equal(env.counts.release, 1);
  assert.equal(env.counts.hide, 1);
  assert.deepEqual(env.audio, []);
});

test("live scale coalescing and solo/online pause remain unchanged; paused destroy releases input", () => {
  for (const freezable of [false, true]) {
    const env = fixture({ freezable });
    env.document.hidden = true;
    env.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(env.timers.size, 0);
    env.document.hidden = false;
    env.document.dispatchEvent(new Event("visibilitychange"));
    const [id, flush] = [...env.timers][0];
    env.timers.delete(id);
    flush();
    assert.equal(env.counts.scale, 1);
    env.api.notifyGameStarted();
    env.api.pauseGame();
    assert.equal(env.scene.paused, true);
    assert.equal(env.counts.pause, freezable ? 1 : 0);
    assert.equal(env.counts.soundPause, freezable ? 1 : 0);
    env.api.resumeGame();
    assert.equal(env.scene.paused, false);
    assert.equal(env.counts.resume, freezable ? 1 : 0);
    assert.deepEqual(env.audio, [true, false]);
    env.api.pauseGame();
    assert.equal(env.window.keyBlocked(), true);
    env.destroy();
    assert.equal(env.window.keyBlocked(), false);
    assert.equal(env.api.isPausable(), false);
    assert.deepEqual(
      env.audio,
      [true, false, true],
      "final owner never resumes disposed scene audio",
    );
    assert.equal(env.counts.postDestroyReads, 0);
  }
});

test("destroying a stale app owner cannot release a newer game's pause", () => {
  const env = fixture();
  let pauses = 0;
  const releaseNew = env.api.setPauseHandlers({ onPause: () => pauses++ });
  env.api.notifyGameStarted();
  env.api.pauseGame();
  env.destroy();
  assert.equal(pauses, 1);
  assert.equal(env.window.keyBlocked(), true);
  releaseNew();
  assert.equal(env.window.keyBlocked(), false);
});
