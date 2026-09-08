import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { Engine } from "../src/game/engine.ts";
import { CameraRig } from "../src/render/camera-rig.ts";

const source = readFileSync(
  process.env.TETRIS_MAIN_SOURCE ?? new URL("../src/main.ts", import.meta.url),
  "utf8",
);
const shared = readFileSync(
  new URL("../../../packages/embed/src/game.ts", import.meta.url),
  "utf8",
);
const scene = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const shift = scene.match(/^  shiftWallClock\(pausedMs: number\): void \{[^]*?^  }/m)?.[0];
assert.ok(shift);
const shiftWallClock = new Function(
  `${stripTypeScriptTypes(`class ClockOwner {${shift}}`)};return ClockOwner.prototype.shiftWallClock;`,
)();
const compile = (text) =>
  stripTypeScriptTypes(text)
    .replace(/^import\s[^;]+;\n/gm, "")
    .replace(/^export /gm, "");
class Surface extends EventTarget {
  listeners = new Map();
  children = [];
  removes = 0;
  addEventListener(type, callback, options) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
    super.addEventListener(type, callback, options);
  }
  removeEventListener(type, callback, options) {
    const listeners = this.listeners.get(type);
    listeners?.delete(callback);
    if (listeners?.size === 0) this.listeners.delete(type);
    super.removeEventListener(
      type,
      callback,
      options === true || options === false ? { capture: options } : options,
    );
  }
  listener(type) {
    return [...(this.listeners.get(type) ?? [])][0];
  }
  appendChild(child) {
    this.children.push(child);
  }
  remove() {
    this.removes++;
  }
}
function setup(coarse = false) {
  const calls = [],
    container = new Surface(),
    window = new Surface();
  Object.assign(window, { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 3 });
  const messages = [];
  window.parent = { postMessage: (message) => messages.push(message) };
  const embed = new Function(
    "window",
    "HTMLElement",
    "GAME_PAUSED_MESSAGE",
    "GAME_STARTED_MESSAGE",
    "isPauseGameMessage",
    `${compile(shared)};return {setPauseHandlers,notifyGameStarted,pauseGame,resumeGame,isPausable};`,
  )(window, Surface, "paused", "started", () => false);
  let now = 1000,
    handlers = {},
    hotDispose;
  class Renderer {
    domElement = new Surface();
    loop = null;
    disposed = false;
    frames = 0;
    setPixelRatio(ratio) {
      calls.push(["dpr", ratio]);
    }
    setSize(width, height) {
      calls.push(["size", width, height]);
    }
    setAnimationLoop(loop) {
      this.loop = loop;
      calls.push(["loop", loop === null ? null : "live"]);
    }
    render() {
      assert.equal(this.disposed, false);
      this.frames++;
    }
    dispose() {
      this.disposed = true;
      calls.push("renderer");
    }
    forceContextLoss() {
      calls.push("context-loss");
      this.domElement.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    }
  }
  class Timer {
    update() {
      calls.push("timer-update");
    }
    getDelta() {
      return 0.02;
    }
    reset() {
      calls.push("timer-reset");
    }
    dispose() {
      calls.push("timer");
    }
  }
  class Game {
    engine = new Engine();
    rig = new CameraRig(16 / 9);
    collapseStartedAt = 500;
    poseActions = {};
    scene = {};
    camera = {};
    disposed = false;
    updates = 0;
    attachPoseControls(controls) {
      this.poseControls = controls;
    }
    diagnostics() {
      assert.equal(this.disposed, false);
      return { updates: this.updates };
    }
    update(dt) {
      assert.equal(dt, 0.02);
      this.updates++;
      this.engine.tick(dt * 1000, this.rig.isInMotion(now));
    }
    resize(aspect) {
      assert.equal(this.disposed, false);
      calls.push(["resize", aspect]);
    }
    setPresentationPaused(paused) {
      calls.push(["game-pause", paused]);
    }
    shiftWallClock(gap) {
      calls.push(["clock-shift", gap]);
      shiftWallClock.call(this, gap);
    }
    dispose() {
      assert.equal(this.disposed, false);
      this.disposed = true;
      calls.push("game");
    }
  }
  class Controls {
    handlePose = () => {};
    setActionsPaused(paused) {
      calls.push(["pose-pause", paused]);
    }
  }
  class Camera {
    starts = 0;
    start() {
      this.starts++;
      return Promise.resolve();
    }
    destroy() {
      calls.push("camera");
    }
  }
  const deps = {
    THREE: { WebGLRenderer: Renderer, Timer, SRGBColorSpace: "srgb" },
    document: { getElementById: (id) => (id === "game" ? container : null) },
    window,
    GameScene: Game,
    PoseControls: Controls,
    PoseCamera: Camera,
    isCoarsePointer: () => coarse,
    setSoundPaused: (paused) => calls.push(["sound-pause", paused]),
    soundDiagnostics: () => ({ ownedSources: 0 }),
    disposeSound: () => calls.push("sound"),
    pauseOverlay: {
      show: () => calls.push("overlay-show"),
      hide: () => calls.push("overlay-hide"),
      showRecovery: () => calls.push("recovery-show"),
      hideRecovery: () => calls.push("recovery-hide"),
    },
    setPauseHandlers: (next) => {
      handlers = next;
      return embed.setPauseHandlers(next);
    },
    isPausable: embed.isPausable,
    pauseGame: embed.pauseGame,
    performance: { now: () => now },
    MAX_DT: 0.05,
    meta: {
      env: { DEV: true },
      hot: {
        dispose: (callback) => {
          hotDispose = callback;
        },
      },
    },
  };
  const code = stripTypeScriptTypes(source)
    .replace(/^import\s[^;]+;\n/gm, "")
    .replaceAll("import.meta", "meta");
  new Function(...Object.keys(deps), code)(...Object.values(deps));
  return {
    calls,
    container,
    window,
    embed,
    messages,
    time: (value) => {
      now = value;
    },
    handlers: () => handlers,
    hotDispose: () => hotDispose,
  };
}

test("actual wrapper gates scene and pose; duplicate pause does not shorten preserved wall clocks", () => {
  const h = setup(),
    game = h.window["__tetris"],
    renderer = h.window["__renderer"];
  assert.equal(h.window["__camera"].starts, 1);
  const descriptor = Object.getOwnPropertyDescriptor(h.window, "__GAME_DIAGNOSTICS__");
  renderer.loop(1000);
  assert.equal(game.updates, 1);
  const { onPause, onResume } = h.handlers();
  onPause();
  h.time(1700);
  onPause();
  renderer.loop(1700);
  assert.equal(game.updates, 1);
  assert.equal(renderer.frames, 2);
  assert.ok(
    h.calls.findIndex((call) => Array.isArray(call) && call[0] === "game-pause") <
      h.calls.indexOf("overlay-show"),
  );
  assert.deepEqual(
    h.calls.filter((call) => Array.isArray(call) && call[0].endsWith("-pause")),
    [
      ["game-pause", true],
      ["pose-pause", true],
      ["sound-pause", true],
    ],
  );
  h.time(3000);
  onResume();
  onResume();
  renderer.loop(3000);
  assert.equal(game.updates, 2);
  assert.deepEqual(
    h.calls.filter((call) => Array.isArray(call) && call[0] === "clock-shift"),
    [["clock-shift", 2000]],
  );
  assert.deepEqual(
    h.calls.filter((call) => Array.isArray(call) && call[0].endsWith("-pause")).slice(-3),
    [
      ["pose-pause", false],
      ["game-pause", false],
      ["sound-pause", false],
    ],
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(h.window, "__GAME_DIAGNOSTICS__").get,
    descriptor.get,
  );
  h.window["__tetrisDispose"]();
});

test("actual final app owner stops rendering first and remains inert after HMR/retained callbacks", () => {
  for (let run = 0; run < 3; run++) {
    const h = setup(run % 2 === 0),
      renderer = h.window["__renderer"];
    assert.equal(h.window["__camera"].starts, run % 2 === 0 ? 0 : 1);
    assert.equal(h.container.listeners.size, 1);
    assert.equal(h.window.listeners.size, 3); // resize plus embed's module listeners
    const frame = renderer.loop,
      resize = h.window.listener("resize"),
      { onPause, onResume } = h.handlers();
    const getter = Object.getOwnPropertyDescriptor(h.window, "__GAME_DIAGNOSTICS__").get;
    assert.equal(h.hotDispose(), h.window["__tetrisDispose"]);
    h.calls.length = 0;
    h.window["__tetrisDispose"]();
    h.hotDispose()();
    assert.deepEqual(h.calls, [
      ["loop", null],
      "recovery-hide",
      "overlay-hide",
      "camera",
      ["pose-pause", true],
      "game",
      "sound",
      "timer",
      "renderer",
      "context-loss",
    ]);
    const after = structuredClone(h.calls);
    frame(9999);
    resize();
    onPause();
    onResume();
    assert.deepEqual(h.calls, after);
    assert.equal(h.container.listeners.size, 0);
    assert.equal(h.window.listeners.size, 2, "only inert module message/Escape listeners remain");
    assert.equal(renderer.domElement.listeners.size, 0);
    assert.equal(renderer.domElement.removes, 1);
    assert.equal(Object.getOwnPropertyDescriptor(h.window, "__GAME_DIAGNOSTICS__"), undefined);
    assert.equal(h.window["__tetris"], undefined);
    assert.equal(h.window["__tetrisDispose"], undefined);
    assert.deepEqual(getter(), {
      disposed: true,
      audio: { ownedSources: 0 },
    });
  }
});

function key(window, type, value) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    key: { value },
    code: { value: value === "Escape" ? "Escape" : `Key${value.toUpperCase()}` },
    repeat: { value: false },
  });
  window.dispatchEvent(event);
}
function blocked(window) {
  const event = new Event("keyup");
  let stopped = false;
  event.stopPropagation = () => {
    stopped = true;
  };
  window.dispatchEvent(event);
  return stopped;
}
function graphics(renderer, type) {
  const event = new Event(type, { cancelable: true });
  renderer.domElement.dispatchEvent(event);
  return event;
}

test("native-context event path freezes the real engine and rejects resume until restored", () => {
  const h = setup(),
    game = h.window["__tetris"],
    renderer = h.window["__renderer"];
  game.engine.startGame(() => 0.42);
  h.embed.notifyGameStarted();
  renderer.loop(1000);
  const before = JSON.stringify(game.engine),
    frames = renderer.frames;
  assert.equal(graphics(renderer, "webglcontextlost").defaultPrevented, true);
  const messages = h.messages.length;
  for (let i = 1; i <= 150; i++) {
    h.time(1000 + i * 20);
    renderer.loop(1000 + i * 20);
  }
  key(h.window, "keydown", "Escape");
  key(h.window, "keyup", "Escape");
  key(h.window, "keydown", "p");
  key(h.window, "keyup", "p");
  h.embed.resumeGame();
  assert.equal(JSON.stringify(game.engine), before);
  assert.equal(renderer.frames, frames, "Three's lost rendering cannot hide ongoing simulation");
  assert.equal(h.messages.length, messages, "unavailable display never announces resumed play");
  assert.equal(blocked(h.window), true);
  assert.equal(h.window["__GAME_DIAGNOSTICS__"].graphics, "lost");
  assert.equal(h.calls.filter((call) => call === "recovery-show").length, 1);
  h.time(5000);
  graphics(renderer, "webglcontextrestored");
  renderer.loop(5000);
  assert.equal(JSON.stringify(game.engine), before);
  assert.equal(h.window["__GAME_DIAGNOSTICS__"].paused, true);
  assert.equal(h.embed.isPausable(), false);
  assert.equal(h.calls.at(-2), "overlay-show");
  h.time(5500);
  h.embed.resumeGame();
  renderer.loop(5500);
  assert.equal(game.updates, 2);
  assert.equal(game.collapseStartedAt, 500 + 4500);
  assert.deepEqual(
    h.calls.filter((call) => Array.isArray(call) && call[0] === "clock-shift"),
    [["clock-shift", 4500]],
  );
  assert.equal(h.calls.filter((call) => call === "timer-reset").length, 1);
  assert.equal(blocked(h.window), false);
  h.window["__tetrisDispose"]();
});

test("prior pause and repeated losses preserve one original catch/orbit clock gap", () => {
  const h = setup(),
    game = h.window["__tetris"],
    renderer = h.window["__renderer"];
  game.engine.startGame(() => 0.42);
  game.engine.state.status = "collapsing";
  game.collapseStartedAt = 900;
  game.rig.orbit(1, 900);
  const deadline = game.rig.inMotionUntil;
  h.embed.notifyGameStarted();
  h.embed.pauseGame();
  h.time(2000);
  graphics(renderer, "webglcontextlost");
  graphics(renderer, "webglcontextlost");
  h.time(3000);
  graphics(renderer, "webglcontextrestored");
  graphics(renderer, "webglcontextrestored");
  assert.equal(game.collapseStartedAt, 900);
  assert.equal(game.rig.inMotionUntil, deadline);
  h.time(4000);
  graphics(renderer, "webglcontextlost");
  h.time(4500);
  graphics(renderer, "webglcontextrestored");
  assert.equal(h.window["__GAME_DIAGNOSTICS__"].paused, true);
  h.time(7000);
  h.embed.resumeGame();
  assert.equal(game.engine.state.status, "collapsing");
  assert.equal(game.collapseStartedAt, 6900);
  assert.equal(game.rig.inMotionUntil, deadline + 6000);
  assert.equal(game.rig.isInMotion(deadline + 5999), true);
  assert.equal(game.rig.isInMotion(deadline + 6000), false);
  assert.deepEqual(
    h.calls.filter((call) => Array.isArray(call) && call[0] === "clock-shift"),
    [["clock-shift", 6000]],
  );
  assert.equal(h.calls.filter((call) => call === "recovery-show").length, 2);
  h.window["__tetrisDispose"]();
});

test("title recovery returns to the original idle title without a phantom shared start", () => {
  const h = setup(),
    game = h.window["__tetris"],
    renderer = h.window["__renderer"];
  const original = JSON.stringify(game.engine);
  graphics(renderer, "webglcontextlost");
  h.time(1500);
  renderer.loop(1500);
  h.embed.resumeGame();
  graphics(renderer, "webglcontextrestored");
  assert.equal(JSON.stringify(game.engine), original);
  assert.equal(game.engine.state.status, "title");
  assert.equal(h.window["__GAME_DIAGNOSTICS__"].paused, false);
  assert.equal(h.embed.isPausable(), false);
  assert.deepEqual(h.messages, []);
  assert.equal(
    h.calls.includes("overlay-show"),
    false,
    "no dead shared resume shell before first START",
  );
  h.window["__tetrisDispose"]();
});

test("lost-context teardown releases shared keys and guards every retained callback", () => {
  const h = setup(),
    renderer = h.window["__renderer"];
  h.embed.notifyGameStarted();
  const loss = renderer.domElement.listener("webglcontextlost");
  const restore = renderer.domElement.listener("webglcontextrestored");
  const frame = renderer.loop;
  graphics(renderer, "webglcontextlost");
  assert.equal(blocked(h.window), true);
  h.window["__tetrisDispose"]();
  const after = structuredClone(h.calls),
    messages = h.messages.length;
  loss(new Event("webglcontextlost", { cancelable: true }));
  restore();
  frame(9000);
  h.handlers().onResume();
  assert.deepEqual(h.calls, after);
  assert.equal(h.messages.length, messages);
  assert.equal(blocked(h.window), false);
  for (const name of [
    "__tetris",
    "__pose",
    "__camera",
    "__renderer",
    "__tetrisDispose",
    "__GAME_DIAGNOSTICS__",
  ])
    assert.equal(Object.getOwnPropertyDescriptor(h.window, name), undefined);
  let resumed = 0;
  const release = h.embed.setPauseHandlers({ onResume: () => resumed++ });
  h.embed.notifyGameStarted();
  h.embed.pauseGame();
  h.embed.resumeGame();
  assert.equal(resumed, 1);
  release();
});

test("old app disposal preserves replacement pause and exact replacement globals", () => {
  const h = setup();
  const dispose = h.window["__tetrisDispose"];
  const replacement = {};
  for (const name of ["__tetris", "__pose", "__camera", "__renderer", "__tetrisDispose"])
    h.window[name] = replacement;
  const replacementGetter = () => replacement;
  Object.defineProperty(h.window, "__GAME_DIAGNOSTICS__", {
    configurable: true,
    get: replacementGetter,
  });
  let resumed = 0;
  const release = h.embed.setPauseHandlers({ onResume: () => resumed++ });
  h.embed.notifyGameStarted();
  h.embed.pauseGame();
  dispose();
  assert.equal(blocked(h.window), true);
  for (const name of ["__tetris", "__pose", "__camera", "__renderer", "__tetrisDispose"])
    assert.equal(h.window[name], replacement);
  assert.equal(
    Object.getOwnPropertyDescriptor(h.window, "__GAME_DIAGNOSTICS__").get,
    replacementGetter,
  );
  h.embed.resumeGame();
  assert.equal(resumed, 1);
  release();
});

test("actual recovery DOM owns no resume path and releases its pointer seal once", () => {
  class Element extends Surface {
    style = {};
    attributes = new Map();
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
    append(...children) {
      this.children.push(...children);
    }
  }
  const body = new Element();
  const document = { createElement: () => new Element(), body };
  const sealSource = readFileSync(
    new URL("../../../packages/embed/src/pointer-seal.ts", import.meta.url),
    "utf8",
  );
  const sealPointerEvents = new Function(`${compile(sealSource)};return sealPointerEvents;`)();
  const overlay = readFileSync(new URL("../src/pause-overlay.ts", import.meta.url), "utf8");
  const { showRecovery, hideRecovery } = new Function(
    "document",
    "PAUSE_OVERLAY_Z",
    "sealPointerEvents",
    `${compile(overlay.slice(overlay.indexOf("let recovery:")))};return {showRecovery,hideRecovery};`,
  )(document, 2147483000, sealPointerEvents);
  for (let cycle = 0; cycle < 3; cycle++) {
    showRecovery();
    showRecovery();
    const root = body.children.at(-1);
    assert.equal(body.children.length, cycle + 1);
    assert.equal(root.id, "tetris-graphics-recovery");
    assert.equal(root.attributes.get("role"), "status");
    assert.equal(root.attributes.get("aria-live"), "polite");
    assert.equal(root.children[1].textContent, "Waiting for the display to recover.");
    const touch = new Event("touchend", { cancelable: true });
    root.dispatchEvent(touch);
    assert.equal(touch.defaultPrevented, true);
    assert.equal(root.listeners.size, 12);
    hideRecovery();
    hideRecovery();
    assert.equal(root.removes, 1);
    assert.equal(root.listeners.size, 0);
  }
});
