import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { environment, settle } from "./audio-harness.mjs";

const require = createRequire(import.meta.url);
const phaserRoot = dirname(require.resolve("phaser/package.json"));
const EventEmitter = require(join(phaserRoot, "src/events/EventEmitter.js"));
const GameEvents = require(join(phaserRoot, "src/core/events/index.js"));
const source = readFileSync(
  process.env.STARFALL_MAIN_SOURCE ?? new URL("../src/main.ts", import.meta.url),
  "utf8",
);
const main = stripTypeScriptTypes(
  source
    .replace(/^import[^;]+;$/gm, "")
    .replaceAll("import.meta.env.DEV", "true")
    .replace('import("./trailer/trailer-director")', "loadTrailer()"),
  { mode: "transform" },
).replace(/^export \{\};?$/gm, "");
const choiceSource = /^export function readTrialChoice\([^]*?^}/m.exec(
  readFileSync(new URL("../src/trials/weapon-trial.ts", import.meta.url), "utf8"),
)?.[0];
assert.ok(choiceSource);
const readTrialChoice = new Function(
  `${stripTypeScriptTypes(choiceSource.replace("export ", ""))};return readTrialChoice;`,
)();
const phaserMethod = (file, name, context = {}) => {
  const text = readFileSync(join(phaserRoot, "src", file), "utf8").replaceAll("\r\n", "\n");
  const found = new RegExp(`^    ${name}: (function[^]*?^    })`, "m").exec(text)?.[1];
  assert.ok(found, `${file}:${name}`);
  return new Function(...Object.keys(context), `return (${found});`)(...Object.values(context));
};
const destroy = phaserMethod("core/Game.js", "destroy");
const runDestroy = phaserMethod("core/Game.js", "runDestroy", {
  Events: GameEvents,
  CanvasPool: { remove() {} },
});
const destroyScale = phaserMethod("scale/ScaleManager.js", "destroy");
const actualRefresh = phaserMethod("scale/ScaleManager.js", "refresh", { Events: {}, CONST: {} });
const updateScale = phaserMethod("scale/ScaleManager.js", "updateScale", { Events: {}, CONST: {} });

class Surface extends EventTarget {
  listeners = new Map();
  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(name, callbacks);
    super.addEventListener(name, callback);
  }
  removeEventListener(name, callback) {
    this.listeners.get(name)?.delete(callback);
    super.removeEventListener(name, callback);
  }
}

function fixture(search = "", options) {
  const env = environment(options);
  const window = new Surface();
  const document = new Surface();
  document.hidden = false;
  const timers = new Map();
  const seeds = [];
  const counts = { scenes: 0, loops: 0, refresh: 0, disposeAudio: 0, imports: 0, director: 0 };
  let nextTimer = 0;
  let resolveTrailer;
  let finalCleanup;
  const trailer = new Promise((resolve) => {
    resolveTrailer = resolve;
  });
  class Game {
    destroy(...args) {
      destroy.apply(this, args);
    }
    runDestroy() {
      runDestroy.call(this);
    }
    constructor(config) {
      this.config = config;
      this.events = new EventEmitter();
      this.renderer = null;
      this.canvas = null;
      this.domContainer = null;
      this.scene = {
        destroy: () => {
          counts.scenes++;
        },
      };
      this.loop = {
        destroy: () => {
          counts.loops++;
        },
      };
      this.scale = {
        canvas: { style: {} },
        width: 1280,
        height: 720,
        refresh: () => {
          counts.refresh++;
        },
        updateScale,
        removeAllListeners() {},
        stopListeners() {},
        parentSize: { destroy() {} },
        gameSize: { destroy() {} },
        baseSize: { destroy() {} },
        displaySize: { destroy() {} },
      };
      // Installed Phaser ScaleManager releases its canvas before the app callback.
      this.events.once(GameEvents.DESTROY, destroyScale, this.scale);
      const once = this.events.once.bind(this.events);
      this.events.once = (name, callback, context) => {
        finalCleanup = callback;
        return once(name, callback, context);
      };
    }
  }
  const globals = {
    Phaser: { Game, WEBGL: 1, Core: { Events: GameEvents }, Scale: { RESIZE: 1 } },
    window,
    document,
    location: { search },
    URLSearchParams,
    sfx: {
      dispose() {
        counts.disposeAudio++;
        env.audio.dispose();
      },
    },
    BootScene: class BootScene {
      key = "Boot";
    },
    GameScene: class GameScene {
      key = "Game";
    },
    readTrialChoice,
    reseed: (seed) => seeds.push(seed),
    setTimeout(callback, delay) {
      assert.equal(delay, 150);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id) => timers.delete(id),
    loadTrailer() {
      counts.imports++;
      return trailer;
    },
  };
  const game = new Function(...Object.keys(globals), `${main};return game;`)(
    ...Object.values(globals),
  );
  return {
    env,
    game,
    window,
    document,
    counts,
    timers,
    seeds,
    destroy() {
      game.destroy(true);
      assert.equal(game.pendingDestroy, true);
      game.runDestroy();
    },
    repeatCleanup: () => finalCleanup?.(),
    resolveTrailer() {
      resolveTrailer({
        bootTrailerDirector: (target) => {
          assert.equal(target, game);
          counts.director++;
        },
      });
    },
  };
}

test("actual final Phaser teardown cancels scale work, releases DOM listeners and owned audio once", () => {
  const f = fixture();
  f.env.unlock();
  f.env.audio.play("pickup", { priority: "local" });
  const resize = [...f.window.listeners.get("resize")][0];
  const visibility = [...f.document.listeners.get("visibilitychange")][0];
  resize();
  resize();
  assert.equal(f.timers.size, 1);
  const pending = [...f.timers.values()][0];
  f.destroy();
  assert.equal(f.game.scale.canvas, null);
  assert.throws(
    () => actualRefresh.call(f.game.scale),
    /null.*style/,
    "stale Phaser refresh itself is unsafe",
  );
  assert.equal(f.timers.size, 0);
  assert.equal(f.window.listeners.get("resize").size, 0);
  assert.equal(f.document.listeners.get("visibilitychange").size, 0);
  assert.equal(f.window["__game"], undefined);
  pending();
  resize();
  visibility();
  f.repeatCleanup();
  assert.equal(f.timers.size, 0);
  assert.equal(f.counts.refresh, 0);
  assert.equal(f.counts.disposeAudio, 1);
  assert.equal(f.counts.scenes, 1);
  assert.equal(f.counts.loops, 1);
  assert.equal(f.env.audio.diagnostics().disposed, true);
  assert.equal(f.env.audio.diagnostics().ownedSources, 0);
  assert.ok(f.env.contexts[0].nodes.every((node) => node.disconnected === 1));
});

test("visibility coalescing stays live before teardown and a replacement DEV owner survives", () => {
  const f = fixture();
  f.document.hidden = true;
  f.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(f.timers.size, 0);
  f.document.hidden = false;
  f.document.dispatchEvent(new Event("visibilitychange"));
  f.window.dispatchEvent(new Event("resize"));
  assert.equal(f.timers.size, 1);
  const [id, callback] = [...f.timers][0];
  f.timers.delete(id);
  callback();
  assert.equal(f.counts.refresh, 1);
  const replacement = {};
  f.window["__game"] = replacement;
  f.destroy();
  assert.equal(f.window["__game"], replacement);
});

test("deferred trailer resolution is inert after destroy; live trailer still boots exactly once", async () => {
  for (const destroyedFirst of [false, true]) {
    const f = fixture("?trailer=1");
    assert.equal(f.counts.imports, 1);
    assert.deepEqual(f.seeds, [7]);
    if (destroyedFirst) f.destroy();
    f.resolveTrailer();
    await settle();
    assert.equal(f.counts.director, destroyedFirst ? 0 : 1);
    if (!destroyedFirst) f.destroy();
    assert.equal(f.counts.disposeAudio, 1);
  }
});

test("normal/trial/explicit-seed boot rules are unchanged; normal runs never import trailer", () => {
  for (const [search, expected] of [
    ["", []],
    ["?seed=83", [83]],
    ["?offline=1&trial=railgun", [7319]],
    ["?offline=1&trial=glaive&seed=17", [17]],
    ["?trial=railgun", []],
  ]) {
    const f = fixture(search);
    assert.deepEqual(f.seeds, expected);
    assert.equal(f.counts.imports, 0);
    f.destroy();
  }
});
