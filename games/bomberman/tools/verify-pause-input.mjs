import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { VirtualGamepad, stickDirection4 } from "../../../packages/gamepad/src/core.ts";

const require = createRequire(import.meta.url);
const phaserRoot = dirname(require.resolve("phaser/package.json"));
const Key = require(join(phaserRoot, "src/input/keyboard/keys/Key.js"));
const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const method = (name) => {
  const found = new RegExp(`^  (?:(?:private|override) )?(?:get )?${name}\\([^]*?^  }`, "m").exec(
    source,
  )?.[0];
  assert.ok(found, name);
  return found;
};
const parser = /^function readPlayerState\([^]*?^}/m.exec(source)?.[0];
assert.ok(parser);
const code = stripTypeScriptTypes(
  `
const isJsonNumber = Number.isFinite;
${parser}
class Inputs extends Object {
${["setPresentationPaused", "flushNeutralInput", "live", "amHost", "myId", "peers", "freezable", "netUpdateMyState", "netSendEvent", "bindInput", "handleInput", "readDir", "requestBomb", "requestRestart", "settleMoving", "update"].map(method).join("\n")}
}`,
  { mode: "strip" },
);
const Inputs = new Function(
  "stickDirection4",
  "attachVirtualGamepad",
  "Phaser",
  "window",
  "audioDiagnostics",
  "simNow",
  "isMuted",
  "setMuted",
  "BOMB_BUTTON_INSET",
  "BOMB_BUTTON_RADIUS",
  "TILE",
  "DIR_VECT",
  `${code};return Inputs;`,
)(
  stickDirection4,
  (scene, options) => {
    scene.touchBomb = options.onButtonDown;
    return scene.gamepad;
  },
  { BlendModes: { NORMAL: 0 }, Input: { Events: { POINTER_DOWN: "pointerdown" } } },
  {},
  () => ({}),
  () => 1000,
  () => true,
  () => {},
  62,
  46,
  64,
  { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] },
);

const fresh = () => {
  const keys = new Map();
  const listeners = new Map();
  const pointerListeners = new Map();
  const events = [];
  const writes = [];
  const buttons = new Set();
  let nextEdges = new Set();
  let frameEdges = new Set();
  const virtual = new VirtualGamepad({
    buttons: [{ id: "bomb", position: () => ({ x: 300, y: 300 }) }],
  });
  virtual.setViewport(400, 400);
  const keyboard = {
    on: (event, callback) => listeners.set(event, callback),
    addKey: (code) => {
      if (!keys.has(code)) keys.set(code, new Key(null, keys.size));
      return keys.get(code);
    },
    resetKeys: () => {
      for (const key of keys.values()) key.reset();
    },
  };
  const scene = Object.assign(new Inputs(), {
    offline: false,
    controlsPaused: false,
    neutralInputPending: false,
    padActionsArmed: true,
    padMovementArmed: true,
    started: true,
    queuedDir: null,
    moving: false,
    moveCooldown: 0,
    localBombSeq: 1,
    myCol: 1,
    myRow: 1,
    myDir: "down",
    lastMoveAt: 0,
    time: { now: 1000 },
    frame: 0,
    netDirty: false,
    hostTicks: 0,
    renders: 0,
    players: new Map(),
    blastSprites: new Map(),
    bombSprites: new Map(),
    input: { keyboard, on: (name, callback) => pointerListeners.set(name, callback) },
    gamepad: {
      pad: virtual,
      getStick: () => virtual.getStick(),
      update: () => virtual.nextFrame(),
    },
    pad: {
      connected: true,
      stick: virtual.getStick(),
      getStick() {
        return this.stick;
      },
      update: () => {
        frameEdges = nextEdges;
        nextEdges = new Set();
      },
      isButtonDown: (name) => buttons.has(name),
      justPressed: (name) => frameEdges.has(name),
    },
    client: {
      connectionStatus: "connected",
      playerId: "me",
      isHost: true,
      players: {
        me: { id: "me", state: { col: 1, row: 1, moving: true } },
        guest: { id: "guest", state: { col: 17, row: 13 } },
      },
      updateMyState(patch) {
        writes.push(patch);
        Object.assign(this.players[this.playerId].state, patch);
      },
      sendEvent: (event, payload) => events.push([event, payload]),
    },
    shared: () => ({ deaths: {}, bombs: {}, blasts: {}, winner: null }),
    isAlive: () => true,
    passable: () => true,
    bombAt: () => false,
    myStats: () => ({ speed: 175 }),
    myColorIdx: () => 0,
    tweenPlayer() {},
    maybeGoOffline() {},
    syncSharedClock() {}, // clock ownership has its own actual-method regression
    updateCamera() {},
    updateBattleFeel() {
      this.renders++;
    },
    onUpdate() {},
    hostTick() {
      this.hostTicks++;
    },
    beginPlay() {
      this.started = true;
    },
  });
  scene.bindInput();
  return {
    scene,
    keys,
    listeners,
    pointerListeners,
    virtual,
    writes,
    events,
    press: (name) => {
      if (!buttons.has(name)) nextEdges.add(name);
      buttons.add(name);
    },
    release: (name) => buttons.delete(name),
  };
};
let groups = 0;
const group = (name, run) => {
  run();
  groups++;
  console.log(`✓ ${name}`);
};

group("actual Phaser keys and touch bindings clear on both pause edges", () => {
  const { scene, keys, virtual, listeners, writes } = fresh();
  keys.get("RIGHT").onDown({ timeStamp: 100 });
  listeners.get("keydown-RIGHT")();
  virtual.pointerDown(1, 50, 50);
  virtual.pointerMove(1, 100, 50);
  virtual.pointerDown(2, 300, 300);
  assert.equal(stickDirection4(virtual.getStick()), "right");
  scene.moving = true;
  scene.moveCooldown = 90;
  scene.setPresentationPaused(true);
  assert.equal(scene.queuedDir, null);
  assert.equal(scene.moving, false);
  assert.equal(scene.moveCooldown, 0);
  assert.equal(keys.get("RIGHT").isDown, false);
  assert.equal(keys.get("RIGHT").repeats, 0);
  assert.equal(keys.get("RIGHT").isUp, true);
  assert.equal(virtual.isTouching, false);
  assert.equal(virtual.isButtonDown("bomb"), false);
  assert.deepEqual(writes, [{ moving: false }]);
  virtual.pointerMove(1, 140, 50);
  assert.equal(
    stickDirection4(virtual.getStick()),
    null,
    "old finger cannot resurrect its binding",
  );
  listeners.get("keydown-LEFT")();
  assert.equal(scene.queuedDir, null);
  scene.setPresentationPaused(true);
  assert.equal(writes.length, 1, "repeated same pause is inert");
  scene.setPresentationPaused(false);
  assert.equal(scene.readDir(), null);
  assert.equal(writes.length, 2);
});

group("neutral waits for connected identity and valid position, then publishes once", () => {
  for (const state of [
    undefined,
    {},
    { col: "1", row: 1 },
    { col: 1 },
    { col: 1, row: Infinity },
  ]) {
    const { scene, writes } = fresh();
    scene.client.connectionStatus = "disconnected";
    scene.client.playerId = null;
    scene.setPresentationPaused(true);
    assert.equal(scene.neutralInputPending, true);
    scene.client.connectionStatus = "connected";
    scene.flushNeutralInput();
    assert.equal(writes.length, 0);
    scene.client.playerId = "me";
    scene.client.players.me = state ? { state } : undefined;
    scene.flushNeutralInput();
    assert.equal(writes.length, 0);
    assert.equal(scene.neutralInputPending, true);
    scene.client.players.me = { state: { col: 1, row: 1 } };
    scene.flushNeutralInput();
    scene.flushNeutralInput();
    assert.deepEqual(writes, [{ moving: false }]);
    assert.equal(scene.neutralInputPending, false);
  }
});

group("paused keyboard/touch/controller actions and restart are rejected", () => {
  const { scene, listeners, pointerListeners, events, press } = fresh();
  scene.setPresentationPaused(true);
  for (const key of ["SPACE", "B", "R"]) listeners.get(`keydown-${key}`)();
  scene.touchBomb("bomb");
  scene.restartableSince = 0;
  pointerListeners.get("pointerdown")({ wasTouch: true });
  scene.requestBomb();
  scene.requestRestart();
  press("a");
  press("start");
  press("right");
  scene.update(0, 70);
  assert.deepEqual(events, []);
  assert.equal(scene.localBombSeq, 1);
  assert.deepEqual([scene.myCol, scene.myRow], [1, 1]);
  scene.setPresentationPaused(false);
  scene.client.connectionStatus = "disconnected";
  scene.requestBomb();
  scene.requestRestart();
  assert.deepEqual(events, [], "disconnected identity cannot submit actions");
});

group("held pad needs release before fresh move/action after resume", () => {
  const { scene, press, release, events } = fresh();
  press("right");
  press("a");
  press("start");
  scene.setPresentationPaused(true);
  scene.update(0, 70);
  scene.setPresentationPaused(false);
  for (let i = 0; i < 4; i++) scene.update(i, 70);
  assert.deepEqual([scene.myCol, scene.myRow], [1, 1]);
  assert.equal(scene.padMovementArmed, false);
  assert.equal(scene.padActionsArmed, false);
  assert.deepEqual(events, []);
  release("right");
  release("a");
  release("start");
  scene.update(5, 70);
  assert.equal(scene.padMovementArmed, true);
  assert.equal(scene.padActionsArmed, true);
  press("right");
  press("a");
  scene.update(6, 70);
  assert.deepEqual([scene.myCol, scene.myRow], [2, 1]);
  assert.equal(events.filter(([name]) => name === "place_bomb").length, 1);
  scene.update(7, 70);
  assert.equal(events.length, 1, "held action has no repeated press edge");
});

group("analog neutral rearm and fresh keyboard/touch still move normally", () => {
  const { scene, keys, listeners, virtual } = fresh();
  scene.pad.stick = { ...scene.pad.stick, active: true, inDeadZone: false, angle: 0 };
  scene.setPresentationPaused(true);
  scene.setPresentationPaused(false);
  scene.update(0, 70);
  assert.equal(scene.myCol, 1);
  assert.equal(scene.padMovementArmed, false);
  scene.pad.stick = { ...scene.pad.stick, active: false, inDeadZone: true };
  scene.update(1, 70);
  assert.equal(scene.padMovementArmed, true);
  keys.get("DOWN").onDown({ timeStamp: 200 });
  listeners.get("keydown-DOWN")();
  scene.update(2, 70);
  assert.equal(scene.myRow, 2);
  keys.get("DOWN").reset();
  virtual.pointerDown(3, 60, 60);
  virtual.pointerMove(3, 120, 60);
  scene.moveCooldown = 0;
  scene.update(3, 70);
  assert.equal(scene.myCol, 2);
});

group("actual paused host update still renders and ticks the shared arena", () => {
  const { scene } = fresh();
  scene.setPresentationPaused(true);
  for (let i = 0; i < 10; i++) scene.update(i, 70);
  assert.equal(scene.hostTicks, 10);
  assert.equal(scene.renders, 10);
  assert.equal(scene.frame, 10);
  assert.deepEqual([scene.myCol, scene.myRow], [1, 1]);
  scene.client.isHost = false;
  scene.update(11, 70);
  assert.equal(scene.hostTicks, 10, "paused guest never takes over simulation");
});

group("actual wrapper callbacks preserve online ticking and offline sleep", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const script = stripTypeScriptTypes(main.slice(main.indexOf("let froze = false;")), {
    mode: "strip",
  });
  for (const solo of [false, true]) {
    const { scene } = fresh();
    if (solo) delete scene.client.players.guest;
    const calls = [];
    let handlers;
    const game = {
      scene: { getScene: () => scene },
      loop: { sleep: () => calls.push("sleep"), wake: () => calls.push("wake") },
      sound: {
        pauseAll: () => calls.push("sound-pause"),
        resumeAll: () => calls.push("sound-resume"),
      },
    };
    scene.pauseSimulation = () => {
      calls.push("clock-pause");
      game.loop.sleep();
    };
    scene.resumeSimulation = () => {
      calls.push("clock-resume");
      game.loop.wake();
    };
    new Function("game", "setPauseHandlers", "createBombermanPauseOverlay", "pauseAudio", script)(
      game,
      (value) => {
        handlers = value;
      },
      () => ({ show: () => calls.push("show"), hide: () => calls.push("hide") }),
      (paused) => calls.push(`audio-${paused}`),
    );
    handlers.onPause();
    assert.equal(scene.controlsPaused, true);
    assert.equal(calls.includes("sleep"), solo);
    assert.equal(calls.includes("clock-pause"), solo);
    handlers.onResume();
    assert.equal(scene.controlsPaused, false);
    assert.equal(calls.includes("wake"), solo);
    assert.equal(calls.includes("clock-resume"), solo);
    assert.deepEqual(
      calls.filter((call) => call.startsWith("audio-")),
      ["audio-true", "audio-false"],
    );
  }
});

// Shared key ownership is exercised through the complete shell + game module
// in packages/embed/tools/pause-key-smoke.mjs. This caller owns neutral resume.
group("resuming presentation cannot replay released movement or actions", () => {
  const { scene, events } = fresh();
  scene.setPresentationPaused(true);
  scene.setPresentationPaused(false);
  assert.equal(scene.controlsPaused, false);
  scene.update(0, 70);
  assert.deepEqual([scene.myCol, scene.myRow], [1, 1]);
  assert.deepEqual(events, []);
});

console.log(
  `✓ ${groups} pause input groups; actual game methods/Key/VirtualGamepad, explicit network and DOM collaborators`,
);
