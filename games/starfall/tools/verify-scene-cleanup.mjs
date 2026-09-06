import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { environment, settle } from "./audio-harness.mjs";
import { networkFixture, sceneSource } from "./network-harness.mjs";

const require = createRequire(import.meta.url);
const phaserRoot = dirname(require.resolve("phaser/package.json"));
const EventEmitter = require(join(phaserRoot, "src/events/EventEmitter.js"));
const Systems = require(join(phaserRoot, "src/scene/Systems.js"));
const SceneManager = require(join(phaserRoot, "src/scene/SceneManager.js"));
const SceneEvents = require(join(phaserRoot, "src/scene/events/index.js"));
const GameEvents = require(join(phaserRoot, "src/core/events/index.js"));
const phaserMethod = (file, name, context) => {
  const source = readFileSync(join(phaserRoot, "src", file), "utf8");
  const found = new RegExp(`^    ${name}: (function[^]*?^    })`, "m").exec(source)?.[1];
  assert.ok(found, `${file}:${name}`);
  return new Function(...Object.keys(context), `return (${found});`)(...Object.values(context));
};
const displayShutdown = phaserMethod("gameobjects/DisplayList.js", "shutdown", { SceneEvents });
const requestDestroy = phaserMethod("core/Game.js", "destroy", {});
const runDestroy = phaserMethod("core/Game.js", "runDestroy", {
  Events: GameEvents,
  CanvasPool: { remove: () => assert.fail("no canvas in this lifecycle fixture") },
});
const start = sceneSource.indexOf("    let cleanedUp = false;");
const end = sceneSource.indexOf("\n\n    this.installDevHooks();", start);
assert.ok(start >= 0 && end > start);
const register = new Function(
  "Phaser",
  "sfx",
  "setPauseHandlers",
  "pauseOverlay",
  `${stripTypeScriptTypes(sceneSource.slice(start, end), { mode: "strip" })};return cleanupScene;`,
);
const barrierSource = readFileSync(
  new URL("../src/render/energy-barrier.ts", import.meta.url),
  "utf8",
);
const barrierCode = stripTypeScriptTypes(barrierSource.replace(/^import[^;]+;$/gm, ""), {
  mode: "transform",
}).replace(/^export /gm, "");
const Phaser = {
  Scenes: { Events: SceneEvents },
  Scale: { Events: { RESIZE: "resize" } },
  BlendModes: { ADD: 1 },
};
const EnergyBarrier = new Function("Phaser", `${barrierCode};return EnergyBarrier;`)(Phaser);
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const disposeMain = main.match(/^game.events.once\(Phaser.Core.Events.DESTROY,[^\n]+$/m)?.[0];
assert.ok(disposeMain, "actual final game audio disposal binding");

const make = async ({ offline = false, delayed = false } = {}) => {
  const network = networkFixture();
  if (offline) network.client.destroy();
  else network.sync(network.empty());
  const env = environment({ delayed, initial: delayed ? "suspended" : "running" });
  env.unlock();
  if (!delayed) {
    await settle();
    env.audio.setMusicMode("boss");
    env.audio.setBattleBeat("crest");
    env.audio.play("boss_phase");
    assert.ok(env.audio.diagnostics().ownedSources > 0);
  }
  const counts = {
    virtual: 0,
    physical: 0,
    touch: 0,
    watch: 0,
    hidden: 0,
    sprites: 0,
    audioClear: 0,
  };
  const events = new EventEmitter();
  const scale = new EventEmitter();
  scale.width = 1280;
  scale.height = 720;
  const keyboard = new EventEmitter();
  const display = { events, list: [] };
  const scene = Object.assign(network.scene, {
    offline,
    events,
    scale,
    input: { keyboard },
    onViewportChange() {},
    onStartKeyUp() {},
    gamepad: { destroy: () => counts.virtual++ },
    pad: { destroy: () => counts.physical++ },
    touchControls: { destroy: () => counts.touch++ },
    unwatchControls: () => counts.watch++,
    add: {
      graphics: () => {
        const g = {
          scene,
          destroy() {
            assert.ok(this.scene, "no second access to a destroyed display node");
            counts.sprites++;
            this.scene = undefined;
          },
        };
        for (const name of [
          "setDepth",
          "setBlendMode",
          "setScrollFactor",
          "clear",
          "fillStyle",
          "fillRect",
        ])
          g[name] = () => {
            assert.ok(g.scene, "no drawing after destruction");
            return g;
          };
        display.list.push(g);
        return g;
      },
    },
  });
  const sys = new Systems(scene, { key: "Game" });
  sys.events = events;
  scene.sys = sys;
  // Installed display lifecycle owns ordering: external cleanup runs after
  // display-list nodes have already been destroyed.
  events.once(SceneEvents.SHUTDOWN, () => displayShutdown.call(display));
  events.once(SceneEvents.DESTROY, () => displayShutdown.call(display));
  scene.barrier = new EnergyBarrier(scene);
  scale.on("resize", scene.onViewportChange, scene);
  keyboard.on("keyup", scene.onStartKeyUp, scene);
  let handlers = { onPause() {}, onResume() {} };
  const cleanup = register.call(
    scene,
    Phaser,
    {
      clearTransient: () => {
        counts.audioClear++;
        env.audio.clearTransient();
      },
    },
    (next) => {
      handlers = next;
    },
    { hide: () => counts.hidden++ },
  );
  const systemScene = new Systems({}, { key: "system" });
  systemScene.events = new EventEmitter();
  const manager = Object.assign(Object.create(SceneManager.prototype), {
    scenes: [{ sys }],
    systemScene: { sys: systemScene },
    _pending: [],
    _start: [],
    _queue: [],
  });
  const game = {
    scene: manager,
    events: new EventEmitter(),
    renderer: null,
    canvas: null,
    domContainer: null,
    loop: { destroy() {} },
    pendingDestroy: false,
  };
  new Function("game", "Phaser", "sfx", disposeMain)(
    game,
    { Core: { Events: GameEvents } },
    env.audio,
  );
  return {
    network,
    env,
    counts,
    scene,
    events,
    scale,
    keyboard,
    game,
    sys,
    cleanup,
    handlers: () => handlers,
  };
};
const check = (f, final = true) => {
  assert.deepEqual(f.counts, {
    virtual: 1,
    physical: 1,
    touch: 1,
    watch: 1,
    hidden: 1,
    sprites: 2,
    audioClear: 1,
  });
  assert.deepEqual(f.handlers(), {});
  assert.equal(f.scene.unwatchControls, null);
  assert.equal(f.events.listeners(SceneEvents.SHUTDOWN).includes(f.cleanup), false);
  assert.equal(f.events.listeners(SceneEvents.DESTROY).includes(f.cleanup), false);
  assert.equal(f.scale.listenerCount("resize"), 0);
  assert.equal(f.keyboard.listenerCount("keyup"), 0);
  assert.equal(f.network.timers.size, 0, "real SDK heartbeat owner stopped");
  assert.equal(f.network.socket.closed, 1);
  assert.equal(f.network.client.listeners.size, 0);
  f.scale.emit("resize");
  const audio = f.env.audio.diagnostics();
  assert.equal(audio.ownedSources, 0);
  assert.equal(audio.scheduledSources, 0);
  assert.equal(audio.schedulerCount, 0);
  assert.equal(audio.musicMode, "silent");
  assert.equal(audio.disposed, final);
};
let groups = 0;
for (const offline of [false, true]) {
  const f = await make({ offline });
  let shutdowns = 0;
  f.events.on(SceneEvents.SHUTDOWN, () => shutdowns++);
  requestDestroy.call(f.game, false);
  runDestroy.call(f.game);
  await settle();
  assert.equal(shutdowns, 0, "actual Game.destroy skips scene SHUTDOWN");
  f.cleanup();
  check(f);
  assert.equal(f.env.contexts[0].closed, 1);
  groups++;
}
{
  const f = await make();
  f.sys.shutdown();
  f.cleanup();
  check(f, false);
  requestDestroy.call(f.game, false);
  runDestroy.call(f.game);
  await settle();
  check(f);
  groups++;
}
{
  const f = await make({ delayed: true });
  assert.equal(f.env.audio.diagnostics().contextTransition, true);
  requestDestroy.call(f.game, false);
  runDestroy.call(f.game);
  for (const operation of f.env.contexts[0].operations) operation.finish();
  await settle();
  check(f);
  assert.equal(f.env.contexts[0].closed, 1);
  groups++;
}
console.log(`Starfall scene cleanup: ${groups} actual Phaser/SDK/audio groups passed`);
