import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { CharacterAction } from "../src/render/character-action.ts";
import { environment, settle } from "./audio-harness.mjs";

const require = createRequire(import.meta.url);
const phaserRoot = dirname(require.resolve("phaser/package.json"));
const EventEmitter = require(join(phaserRoot, "src/events/EventEmitter.js"));
const Systems = require(join(phaserRoot, "src/scene/Systems.js"));
const SceneManager = require(join(phaserRoot, "src/scene/SceneManager.js"));
const SceneEvents = require(join(phaserRoot, "src/scene/events/index.js"));
const GameEvents = require(join(phaserRoot, "src/core/events/index.js"));

// Execute installed Phaser lifecycle bodies without booting a GPU/DOM. The
// actual SceneManager/Systems/EventEmitter modules own event order below.
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
const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const start = source.indexOf("    let cleanedUp = false;");
assert.ok(start >= 0);
const end = source.indexOf("\n\n    if (import.meta.env.DEV)", start);
assert.ok(end > start);
const register = new Function(
  "Phaser",
  "disposeAudio",
  `${stripTypeScriptTypes(source.slice(start, end), { mode: "strip" })};return cleanupScene;`,
);

const makeScene = ({ offline = false, delayed = false } = {}) => {
  const env = environment({ delayed });
  env.audio.unlockAudio();
  if (!delayed) env.audio.sfx.win("won");
  const counts = {
    audio: 0,
    virtual: 0,
    physical: 0,
    touch: 0,
    watch: 0,
    network: 0,
    sprites: 0,
    action: 0,
  };
  const events = new EventEmitter();
  const scale = new EventEmitter();
  const keyboard = new EventEmitter();
  const uiEvents = new AbortController();
  const action = new CharacterAction();
  const pose = { col: 1, row: 1, dir: "down", moving: false };
  action.victory(0, pose);
  const player = {
    action: {
      reset: () => {
        counts.action++;
        action.reset();
      },
    },
    get sprite() {
      return assert.fail("cleanup must not touch destroyed sprites");
    },
    get body() {
      return assert.fail("cleanup must not touch destroyed containers");
    },
  };
  const scene = {
    events,
    scale,
    input: { keyboard },
    uiEvents,
    offline,
    applyZoom() {},
    onStartKeyUp() {},
    gamepad: { destroy: () => counts.virtual++ },
    pad: { destroy: () => counts.physical++ },
    touchControls: { destroy: () => counts.touch++ },
    unwatchControls: () => counts.watch++,
    client: { destroy: () => counts.network++ },
    battleFx: { clear: () => assert.fail("display-list FX are already destroyed") },
    sparkEmitter: { killAll: () => assert.fail("emitter already destroyed") },
    players: new Map([["me", player]]),
    deathSeen: new Set(["me"]),
    bombSprites: new Map([["bomb", {}]]),
    blastSprites: new Map([["blast", []]]),
    blastSeen: new Set(["blast"]),
    powerupObjs: new Map([["pickup", {}]]),
    tileObjs: [[{}]],
    tileKind: [["wall"]],
    winnerAction: { id: "me", at: 0 },
    characterTime: 1000,
  };
  const sys = new Systems(scene, { key: "Game" });
  sys.events = events;
  scene.sys = sys;
  // Display-list hooks are installed before Game.create's external cleanup.
  const display = {
    events,
    list: [{ destroy: () => counts.sprites++ }],
  };
  events.once(SceneEvents.SHUTDOWN, () => displayShutdown.call(display));
  events.once(SceneEvents.DESTROY, () => displayShutdown.call(display));
  scale.on("resize", scene.applyZoom, scene);
  keyboard.on("keyup", scene.onStartKeyUp, scene);
  const cleanup = register.call(
    scene,
    {
      Scenes: { Events: SceneEvents },
      Scale: { Events: { RESIZE: "resize" } },
    },
    () => {
      counts.audio++;
      env.audio.disposeAudio();
    },
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
  return {
    env,
    counts,
    scene,
    sys,
    events,
    game,
    cleanup,
    action,
    pose,
    uiEvents,
    scale,
    keyboard,
  };
};

const check = (fixture) => {
  const { env, counts, scene, events, action, pose, uiEvents, scale, keyboard } = fixture;
  assert.equal(counts.audio, 1);
  assert.equal(counts.virtual + counts.physical + counts.touch, 3);
  assert.equal(counts.watch, 1);
  assert.equal(counts.network, scene.offline ? 0 : 1);
  assert.equal(counts.sprites, 1);
  assert.equal(counts.action, 1);
  assert.equal(action.sample(1000, pose, true), null);
  assert.equal(uiEvents.signal.aborted, true);
  assert.equal(scale.listenerCount("resize"), 0);
  assert.equal(keyboard.listenerCount("keyup"), 0);
  assert.equal(events.listenerCount(SceneEvents.SHUTDOWN), 0);
  assert.equal(events.listeners(SceneEvents.DESTROY).includes(fixture.cleanup), false);
  assert.equal(
    scene.players.size + scene.bombSprites.size + scene.blastSprites.size + scene.powerupObjs.size,
    0,
  );
  assert.equal(scene.tileObjs.length + scene.tileKind.length + scene.deathSeen.size, 0);
  assert.equal(scene.blastSeen.size, 0);
  assert.equal(scene.battleFx, null);
  assert.equal(scene.sparkEmitter, null);
  assert.equal(scene.winnerAction, null);
  assert.equal(scene.characterTime, 0);
  assert.equal(env.audio.audioDiagnostics().voices, 0);
  assert.equal(env.audio.audioDiagnostics().scheduledVoices, 0);
  assert.equal(env.audio.audioDiagnostics().mixNodes, 0);
  assert.equal(env.contexts[0].state, "closed");
  assert.equal(env.contexts[0].closed, 1);
};

let groups = 0;
for (const offline of [false, true]) {
  const fixture = makeScene({ offline });
  assert.ok(fixture.env.audio.audioDiagnostics().voices > 0);
  assert.ok(fixture.env.audio.audioDiagnostics().scheduledVoices > 0);
  let shutdowns = 0;
  fixture.events.on(SceneEvents.SHUTDOWN, () => shutdowns++);
  requestDestroy.call(fixture.game, false);
  assert.equal(fixture.game.pendingDestroy, true);
  runDestroy.call(fixture.game);
  await settle();
  assert.equal(shutdowns, 0, "real Game.destroy path skips scene SHUTDOWN");
  fixture.cleanup();
  check(fixture);
  groups++;
}

{
  const fixture = makeScene();
  fixture.sys.shutdown();
  fixture.cleanup();
  check(fixture);
  requestDestroy.call(fixture.game, false);
  runDestroy.call(fixture.game);
  check(fixture);
  groups++;
}

{
  const fixture = makeScene({ delayed: true });
  assert.equal(fixture.env.audio.audioDiagnostics().contextTransition, true);
  requestDestroy.call(fixture.game, false);
  runDestroy.call(fixture.game);
  for (const operation of fixture.env.contexts[0].operations) operation.finish();
  await settle();
  check(fixture);
  groups++;
}

console.log(
  `✓ ${groups} scene cleanup groups: actual Phaser destroy/shutdown order, pending audio close, idempotent external release, no dead sprite access`,
);
