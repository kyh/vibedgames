import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

function compile(path) {
  return stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), "utf8"), {
    mode: "transform",
  })
    .replace(/^import[^;]*;\s*/gm, "")
    .replace(/^export /gm, "");
}

function fixture() {
  const calls = new Map();
  const count = (name) => calls.set(name, (calls.get(name) ?? 0) + 1);
  class Surface extends EventTarget {
    listeners = new Map();
    addEventListener(type, fn, options) {
      const set = this.listeners.get(type) ?? new Set();
      set.add(fn);
      this.listeners.set(type, set);
      const normalized = options === true || options === false ? { capture: options } : options;
      super.addEventListener(type, fn, normalized);
      normalized?.signal?.addEventListener("abort", () => set.delete(fn), { once: true });
    }
    removeEventListener(type, fn, options) {
      this.listeners.get(type)?.delete(fn);
      super.removeEventListener(
        type,
        fn,
        options === true || options === false ? { capture: options } : options,
      );
    }
  }
  class Element extends Surface {
    isContentEditable = false;
    nativeControl = false;
    closest() {
      return this.nativeControl ? this : null;
    }
    appendChild() {}
    setAttribute() {}
    remove() {
      count("canvas.remove");
    }
  }
  const window = new Surface();
  Object.assign(window, {
    parent: window,
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    location: { search: "" },
  });
  const elements = new Map([
    ["game", new Element()],
    ["sound-toggle", new Element()],
  ]);
  const document = { getElementById: (id) => elements.get(id) };
  const embed = new Function(
    "window",
    "HTMLElement",
    "GAME_PAUSED_MESSAGE",
    "GAME_STARTED_MESSAGE",
    "isPauseGameMessage",
    `${compile("../../../packages/embed/src/game.ts")}; return { setPauseHandlers, notifyGameStarted, pauseGame, resumeGame, isPausable };`,
  )(window, Element, "paused", "started", () => false);
  let loop, retainedLoop, retainedPause, touchConfig;
  class Renderer {
    info = { autoReset: true, render: { calls: 11, triangles: 7632 }, reset() {} };
    domElement = new Element();
    setPixelRatio() {}
    setSize() {
      count("renderer.size");
    }
    setAnimationLoop(next) {
      loop = next;
      if (next) retainedLoop = next;
    }
    dispose() {
      count("renderer.dispose");
    }
    forceContextLoss() {
      count("renderer.loss");
    }
  }
  class Timer {
    update() {
      count("timer.update");
    }
    getDelta() {
      return 0.016;
    }
    dispose() {
      count("timer.dispose");
    }
  }
  class Game {
    inputPaused = false;
    hasLiveOpponent() {
      return false;
    }
    requestPause() {
      this.inputPaused = true;
      count("game.pause");
    }
    requestResume() {
      this.inputPaused = false;
      count("game.resume");
    }
    diagnostics() {
      return { frame: 1 };
    }
    update() {
      count("game.update");
    }
    isScreenInverted() {
      return false;
    }
    resize() {
      count("game.resize");
    }
    handleHandPosition() {
      count("game.hand");
    }
    handleGestureConfirm() {
      count("game.confirm");
      if (!this.inputPaused) count("game.action");
    }
    seed() {
      count("game.seed");
    }
    setTestState() {
      count("game.state");
    }
    setReducedMotion() {
      count("game.motion");
    }
    dispose() {
      count("game.dispose");
    }
  }
  class Dither {
    setInverted() {}
    setSize() {}
    render() {
      count("dither.render");
    }
    dispose() {
      count("dither.dispose");
    }
  }
  const deps = {
    window,
    document,
    HTMLElement: Element,
    THREE: { WebGLRenderer: Renderer, Timer },
    createTouchControls(config) {
      touchConfig = config;
      return {
        sync() {},
        destroy() {
          count("touch.dispose");
        },
      };
    },
    setPauseHandlers(handlers) {
      retainedPause = handlers;
      return embed.setPauseHandlers(handlers);
    },
    disposeSound() {
      count("sound.dispose");
    },
    isMuted: () => false,
    resumeSound() {
      count("sound.unlock");
    },
    setMuted() {
      count("sound.mute");
    },
    setSoundPaused() {
      count("sound.pause");
    },
    createHandCamera: () => ({
      enable() {
        count("camera.enable");
      },
      stop() {
        count("camera.stop");
      },
    }),
    createPongPauseOverlay: () => ({
      show() {
        count("overlay.show");
      },
      hide() {
        count("overlay.hide");
      },
    }),
    DitherPass: Dither,
    GameScene: Game,
    DITHER_PIXEL: 2,
    MAX_DT: 0.05,
    COARSE_INPUT: false,
  };
  const source = compile("../src/main.ts")
    .replaceAll("import.meta.env.DEV", "true")
    .replace("import.meta.hot?.dispose(dispose);", "");
  new Function(...Object.keys(deps), source)(...Object.values(deps));
  const dispose = window.__pongDispose;
  return {
    window,
    elements,
    calls,
    embed,
    dispose,
    retainedLoop,
    retainedPause,
    touchConfig,
    loop: () => loop,
  };
}

test("main releases the paused embed owner, listeners and every final resource once", () => {
  const f = fixture();
  f.retainedLoop(1);
  const hooks = f.window.__GAME_TEST_HOOKS__;
  const hand = f.window.__pongHand;
  f.window.dispatchEvent(new Event("load"));
  f.window.dispatchEvent(new Event("resize"));
  f.window.dispatchEvent(new Event("pagehide"));
  assert.equal(f.calls.get("game.dispose"), undefined, "BFCache leaves match recoverable");
  f.embed.notifyGameStarted();
  f.embed.pauseGame();
  assert.equal(f.window.listeners.get("keyup").size, 1);
  f.dispose();
  f.dispose();
  assert.equal(f.window.listeners.get("keyup").size, 0);
  assert.equal(f.embed.isPausable(), false);
  assert.equal(f.loop(), null);
  for (const name of [
    "__pong",
    "__pongHand",
    "__pongCamera",
    "__pongDispose",
    "__GAME_TEST_HOOKS__",
    "__GAME_DIAGNOSTICS__",
  ])
    assert.equal(name in f.window, false, name);
  for (const name of [
    "game.dispose",
    "renderer.dispose",
    "renderer.loss",
    "canvas.remove",
    "timer.dispose",
    "dither.dispose",
    "camera.stop",
    "sound.dispose",
    "touch.dispose",
  ])
    assert.equal(f.calls.get(name), 1, name);
  assert.equal(f.window.listeners.get("resize").size, 0);
  assert.equal(f.window.listeners.get("pointerdown").size, 0);
  for (const element of f.elements.values())
    for (const listeners of element.listeners.values()) assert.equal(listeners.size, 0);
  const after = new Map(f.calls);
  f.retainedLoop(2);
  f.retainedPause.onPause();
  f.retainedPause.onResume();
  f.touchConfig.mute.set(true);
  hand(0.5);
  hooks.seed(1);
  hooks.setState("active-play");
  hooks.setReducedMotion(true);
  hooks.setPausedForScreenshot(false);
  hooks.hand(0.2);
  f.window.dispatchEvent(new Event("resize"));
  f.window.dispatchEvent(new Event("pointerdown"));
  assert.deepEqual(f.calls, after, "late callbacks cannot revive a released match");
});

test("old main disposal preserves a replacement pause owner and replacement globals", () => {
  const f = fixture();
  f.retainedLoop(1);
  let resumed = 0;
  const releaseReplacement = f.embed.setPauseHandlers({ onResume: () => resumed++ });
  f.embed.notifyGameStarted();
  f.embed.pauseGame();
  const replacement = {};
  const names = [
    "__pong",
    "__pongHand",
    "__pongCamera",
    "__pongDispose",
    "__GAME_TEST_HOOKS__",
    "__GAME_DIAGNOSTICS__",
  ];
  for (const name of names) f.window[name] = replacement;
  f.dispose();
  f.retainedLoop(2);
  for (const name of names) assert.equal(f.window[name], replacement, name);
  assert.equal(f.window.listeners.get("keyup").size, 1);
  f.embed.resumeGame();
  assert.equal(resumed, 1);
  assert.equal(f.embed.isPausable(), true);
  releaseReplacement();
});

test("fresh Space uses fist action; repeats, pause resume and focused controls cannot leak an action", () => {
  const f = fixture();
  const key = (type, repeat = false, target = f.window) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      code: { value: "Space" },
      repeat: { value: repeat },
      target: { value: target },
    });
    f.window.dispatchEvent(event);
    return event;
  };
  try {
    assert.equal(key("keydown").defaultPrevented, true);
    assert.equal(f.calls.get("game.action"), 1);
    assert.equal(key("keydown", true).defaultPrevented, true);
    assert.equal(f.calls.get("game.confirm"), 1);
    const control = f.elements.get("sound-toggle");
    control.nativeControl = true;
    assert.equal(key("keydown", false, control).defaultPrevented, false);
    control.nativeControl = false;
    control.isContentEditable = true;
    assert.equal(key("keydown", false, control).defaultPrevented, false);
    assert.equal(f.calls.get("game.confirm"), 1);
    f.embed.notifyGameStarted();
    f.embed.pauseGame();
    key("keydown");
    assert.equal(f.calls.get("game.action"), 1, "same action delegates to the scene pause guard");
    key("keyup");
    f.embed.resumeGame(); // Overlay rendering/key binding is stubbed in this main-owner fixture.
    assert.equal(f.calls.get("game.resume"), 1);
    key("keydown", true);
    assert.equal(f.calls.get("game.action"), 1, "held resume key cannot become a fresh shot");
    key("keyup");
    key("keydown");
    assert.equal(f.calls.get("game.action"), 2);
    f.dispose();
    key("keydown");
    assert.equal(f.calls.get("game.action"), 2, "input ownership ends at disposal");
  } finally {
    f.dispose();
  }
});
