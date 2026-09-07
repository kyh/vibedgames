import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
class Surface extends EventTarget {
  listeners = new Map();
  children = [];
  removes = 0;
  addEventListener(type, callback) {
    this.listeners.set(type, callback);
    super.addEventListener(type, callback);
  }
  removeEventListener(type, callback) {
    assert.equal(this.listeners.get(type), callback);
    this.listeners.delete(type);
    super.removeEventListener(type, callback);
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
    }
  }
  class Timer {
    update() {
      calls.push("timer-update");
    }
    getDelta() {
      return 0.02;
    }
    dispose() {
      calls.push("timer");
    }
  }
  class Game {
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
    },
    setPauseHandlers: (next) => {
      handlers = next;
    },
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
    assert.equal(h.window.listeners.size, 1);
    const frame = renderer.loop,
      resize = h.window.listeners.get("resize"),
      { onPause, onResume } = h.handlers();
    const getter = Object.getOwnPropertyDescriptor(h.window, "__GAME_DIAGNOSTICS__").get;
    assert.equal(h.hotDispose(), h.window["__tetrisDispose"]);
    h.calls.length = 0;
    h.window["__tetrisDispose"]();
    h.hotDispose()();
    assert.deepEqual(h.calls, [
      ["loop", null],
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
    assert.deepEqual(h.handlers(), {});
    assert.equal(h.container.listeners.size + h.window.listeners.size, 0);
    assert.equal(renderer.domElement.removes, 1);
    assert.equal(Object.getOwnPropertyDescriptor(h.window, "__GAME_DIAGNOSTICS__").get, getter);
    assert.deepEqual(h.window["__GAME_DIAGNOSTICS__"], {
      disposed: true,
      audio: { ownedSources: 0 },
    });
  }
});
