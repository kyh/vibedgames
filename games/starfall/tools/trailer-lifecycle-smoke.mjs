import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const phaserRoot = dirname(require.resolve("phaser/package.json"));
const EventEmitter = require(join(phaserRoot, "src/events/EventEmitter.js"));
const Events = require(join(phaserRoot, "src/core/events/index.js"));
const source = readFileSync(
  process.env.STARFALL_TRAILER_SOURCE ??
    new URL("../src/trailer/trailer-director.ts", import.meta.url),
  "utf8",
);
const entry = /^export function bootTrailerDirector\([^]*?^}/m.exec(source)?.[0];
assert.ok(entry);
const bootSource = stripTypeScriptTypes(entry.replace("export ", ""));
const gameSource = readFileSync(join(phaserRoot, "src/core/Game.js"), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const gameMethod = (name) => {
  const method = new RegExp(`^    ${name}: (function[^]*?^    })`, "m").exec(gameSource)?.[1];
  assert.ok(method);
  return new Function("Events", "CanvasPool", `return (${method});`)(Events, { remove() {} });
};
const destroy = gameMethod("destroy");
const runDestroy = gameMethod("runDestroy");

function fixture(initialActive = false) {
  const timers = new Map();
  let timerId = 0;
  let active = initialActive;
  let sceneDestroyed = false;
  let directed = 0;
  let reads = 0;
  class GameScene {
    key = "Game";
  }
  const scene = new GameScene();
  const game = {
    events: new EventEmitter(),
    renderer: null,
    canvas: null,
    domContainer: null,
    loop: { destroy() {} },
    scene: {
      getScene(key) {
        assert.equal(key, "Game");
        assert.equal(sceneDestroyed, false, "no scene-manager read after final destroy");
        reads++;
        return active ? scene : null;
      },
      isActive: () => active,
      destroy() {
        sceneDestroyed = true;
      },
    },
  };
  const boot = new Function(
    "GameScene",
    "window",
    "direct",
    `${bootSource}; return bootTrailerDirector;`,
  )(
    GameScene,
    {
      setTimeout(callback, delay) {
        assert.equal(delay, 60);
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    (target) => {
      assert.equal(target, scene);
      directed++;
    },
  );
  boot(game);
  return {
    game,
    timers,
    reads: () => reads,
    directed: () => directed,
    activate: () => {
      active = true;
    },
    tick() {
      const [id, callback] = [...timers][0];
      timers.delete(id);
      callback();
    },
    destroy() {
      destroy.call(game, true);
      runDestroy.call(game);
    },
  };
}

test("final Phaser destroy owns a pending trailer boot and fences a dequeued retry", () => {
  const f = fixture();
  assert.equal(f.timers.size, 1);
  const retry = [...f.timers.values()][0];
  const reads = f.reads();
  f.destroy();
  assert.equal(f.timers.size, 0);
  retry();
  assert.equal(f.reads(), reads);
  assert.equal(f.directed(), 0);
  assert.equal(f.game.events.listenerCount(Events.DESTROY), 0);
});

test("preload waits keep one retry; a ready GameScene starts the unchanged director once", () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) {
    f.tick();
    assert.equal(f.timers.size, 1);
  }
  const retry = [...f.timers.values()][0];
  f.activate();
  f.tick();
  assert.equal(f.directed(), 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.game.events.listenerCount(Events.DESTROY), 0);
  retry();
  assert.equal(f.directed(), 1);
  f.destroy();
});

test("already-active trailer boot neither delays staging nor retains a boot listener", () => {
  const f = fixture(true);
  assert.equal(f.directed(), 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.game.events.listenerCount(Events.DESTROY), 0);
  f.destroy();
});
