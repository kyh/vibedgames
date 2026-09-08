import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { compile, Element } from "./camera-harness.mjs";

const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const member = (name) => {
  const prefix = `^  (?:private )?(?:readonly )?${name}`;
  const found =
    new RegExp(`${prefix}\\([^]*?^  }`, "m").exec(source)?.[0] ??
    new RegExp(`${prefix}[^\\n]*=> \\{[^]*?^  };`, "m").exec(source)?.[0] ??
    new RegExp(`${prefix}[^\\n]*= \\[[^]*?^  ];`, "m").exec(source)?.[0] ??
    new RegExp(`${prefix}[^\\n]*;`, "m").exec(source)?.[0];
  assert.ok(found, `actual ${name}`);
  return found;
};
function phaserMethod(file, name, dependencies) {
  const text = readFileSync(new URL(`../node_modules/phaser/src/${file}`, import.meta.url), "utf8");
  const body = new RegExp(`${name}: function \\([^)]*\\)\\s*\\{([\\s\\S]*?)\\r?\\n    \\}`).exec(
    text,
  )?.[1];
  assert.ok(body, `installed Phaser ${name}`);
  return new Function(...Object.keys(dependencies), `return function(){${body}};`)(
    ...Object.values(dependencies),
  );
}
const events = { SHUTDOWN: "shutdown", DESTROY: "destroy" };
const destroySystems = phaserMethod("scene/Systems.js", "destroy", {
  Events: events,
  CONST: { DESTROYED: 9 },
});
const destroyGame = phaserMethod("core/Game.js", "runDestroy", {
  Events: events,
  CanvasPool: { remove() {} },
});
function sceneFixture(window = {}) {
  const elements = new Map(),
    calls = {
      flap: 0,
      begin: 0,
      mute: 0,
      net: 0,
      touch: 0,
      phrase: 0,
      countdown: 0,
      unwatch: 0,
    };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
  };
  const deps = {
    Phaser: { Scenes: { Events: events }, Scale: { Events: { RESIZE: "resize" } } },
    document,
    window,
    TOUCH: false,
    CONTROLS: [],
    ensureControlsStyle() {},
    buildControls: () => null,
    watchControlContext: () => () => calls.unwatch++,
  };
  const names = [
    "externalReleased",
    "onPointerInput",
    "onFlapKey",
    "onMuteKey",
    "onStartInput",
    "bindExternalInput",
    "releaseExternal",
    "buildStartScreen",
    "handleInput",
    "cancelPhrase",
  ];
  const code = stripTypeScriptTypes(`class ActualScene {${names.map(member).join("\n")} }`);
  const ActualScene = new Function(...Object.keys(deps), `${code};return ActualScene;`)(
    ...Object.values(deps),
  );
  const scene = new ActualScene(),
    input = new EventEmitter(),
    keyboard = new EventEmitter(),
    scale = new EventEmitter(),
    bus = new EventEmitter();
  input.keyboard = keyboard;
  Object.assign(scene, {
    input,
    scale,
    events: bus,
    presentationPaused: false,
    started: true,
    countingDown: false,
    phase: "playing",
    muted: false,
    startEl: document.getElementById("start"),
    resultsEl: document.getElementById("flight-result"),
    gatesEl: document.getElementById("flight-gates"),
    layout() {},
    flap: () => calls.flap++,
    beginPlay: () => calls.begin++,
    setMuted: () => calls.mute++,
    net: { destroy: () => calls.net++ },
    touchControls: { destroy: () => calls.touch++, sync() {} },
    phraseTimer: { remove: () => calls.phrase++ },
    countdownTimer: { remove: () => calls.countdown++ },
  });
  scene.buildStartScreen();
  scene.bindExternalInput();
  scale.on("resize", scene.layout);
  bus.once("shutdown", scene.releaseExternal);
  bus.once("destroy", scene.releaseExternal);
  return { scene, calls, input, keyboard, scale, bus, elements };
}
test("scene release runs once on shutdown or actual Phaser destroy after displays/input plugins are gone", () => {
  assert.match(member("create"), /once\(Phaser\.Scenes\.Events\.SHUTDOWN, this\.releaseExternal\)/);
  assert.match(member("create"), /once\(Phaser\.Scenes\.Events\.DESTROY, this\.releaseExternal\)/);
  for (const shutdownFirst of [false, true]) {
    const f = sceneFixture(),
      g = f.scene;
    g.gatesEl.hidden = false;
    const countdown = new Element();
    countdown.classList.add("show", "pop");
    countdown.textContent = "2";
    f.elements.set("countdown", countdown);
    if (shutdownFirst) f.bus.emit("shutdown");
    // DisplayList and KeyboardPlugin were registered earlier than user create.
    f.input.keyboard = null;
    for (const field of ["bird", "readyImg", "overImg", "titleDragon"])
      Object.defineProperty(g, field, {
        get() {
          throw new Error("dead display access");
        },
      });
    destroySystems.call({ events: f.bus, settings: {} });
    g.releaseExternal();
    assert.equal(g.externalReleased, true);
    assert.equal(g.gatesEl.hidden, true);
    assert.equal(countdown.textContent, "");
    assert.equal(countdown.classList.contains("show"), false);
    assert.equal(countdown.classList.contains("pop"), false);
    for (const owner of ["net", "touch", "phrase", "countdown", "unwatch"])
      assert.equal(f.calls[owner], 1);
    assert.equal(f.input.listenerCount("pointerdown"), 0);
    assert.equal(f.scale.listenerCount("resize"), 0);
    assert.ok([...f.elements.values()].every((element) => element.listenerCount === 0));
    g.onStartInput();
    g.onPointerInput();
    g.onFlapKey({ repeat: false });
    g.onMuteKey({ repeat: false });
    assert.deepEqual([f.calls.begin, f.calls.flap, f.calls.mute], [0, 0, 0]);
  }
});
test("ordinary pointer and keyboard input stays live until its scene owner releases", () => {
  const f = sceneFixture();
  f.keyboard.emit("keydown-SPACE", { repeat: false });
  f.keyboard.emit("keydown-UP", { repeat: false });
  f.keyboard.emit("keydown-SPACE", { repeat: true });
  f.input.emit("pointerdown");
  assert.equal(f.calls.flap, 3);
  f.keyboard.emit("keyup", { key: "d" });
  f.keyboard.emit("keyup", { key: "d" });
  assert.equal(f.calls.begin, 1, "title keyboard listener is once-only");
  f.scene.releaseExternal();
  assert.equal(f.keyboard.eventNames().length, 0);
  f.input.emit("pointerdown");
  f.keyboard.emit("keydown-UP", { repeat: false });
  assert.equal(f.calls.flap, 3);
});
test("actual main final Game order closes camera/window/timer/pause owners without accessing SceneManager", () => {
  const window = new Element(),
    document = new Element(),
    timers = new Map(),
    calls = [];
  let hooks = {},
    pose = null,
    serial = 0,
    sceneGone = false;
  class GameScene {
    poseJump() {
      calls.push("pose");
    }
    isOnline() {
      return true;
    }
    setPresentationPaused(value) {
      calls.push(`pause:${value}`);
    }
  }
  const gameScene = new GameScene();
  class BootScene {
    active = false;
  }
  class Game {
    events = new EventEmitter();
    scene = {
      getScene() {
        assert.equal(sceneGone, false);
        return gameScene;
      },
      isActive() {
        assert.equal(sceneGone, false);
        return true;
      },
      destroy() {
        sceneGone = true;
      },
    };
    scale = {
      refresh() {
        assert.equal(sceneGone, false);
        calls.push("refresh");
      },
    };
    loop = { sleep: () => calls.push("sleep"), wake: () => calls.push("wake"), destroy() {} };
    renderer = null;
  }
  const deps = {
    Phaser: { Game, WEBGL: 1, Scale: { RESIZE: 1 }, Core: { Events: events } },
    setPauseHandlers: (next) => {
      hooks = next;
      return () => {
        hooks = {};
      };
    },
    CONTROLS: [],
    initPoseCamera: (callback) => {
      pose = callback;
    },
    disposePoseCamera: () => calls.push("camera:dispose"),
    createFlappyPauseOverlay: () => ({ show() {}, hide: () => calls.push("overlay:hide") }),
    BootScene,
    GameScene,
    window,
    document,
    setTimeout: (callback) => {
      timers.set(++serial, callback);
      return serial;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const code = compile("../src/main.ts").replaceAll("import.meta.env.DEV", "true");
  const game = new Function(...Object.keys(deps), `${code};return game;`)(...Object.values(deps));
  hooks.onPause();
  pose(1, false);
  assert.equal(calls.includes("pose"), false);
  assert.equal(calls.includes("sleep"), false);
  hooks.onResume();
  pose(1, false);
  assert.equal(calls.filter((call) => call === "pose").length, 1);
  window.dispatchEvent(new Event("resize"));
  const staleResize = [...timers.values()][0],
    oldHooks = hooks;
  destroyGame.call(game);
  assert.equal(timers.size, 0);
  assert.deepEqual(hooks, {});
  assert.equal(window.listenerCount, 0);
  assert.equal(document.listenerCount, 0);
  assert.equal(calls.filter((call) => call === "camera:dispose").length, 1);
  staleResize();
  oldHooks.onPause();
  oldHooks.onResume();
  pose(1, false);
  window.dispatchEvent(new Event("resize"));
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(timers.size, 0);
  assert.equal(calls.includes("refresh"), false);
  assert.equal(calls.filter((call) => call === "pose").length, 1);
});

test("scene cleanup removes only its own published scene", () => {
  for (const replaced of [false, true]) {
    const window = {};
    const f = sceneFixture(window);
    const next = { scene: {}, net: {} };
    f.scene.diagnostics = () => ({ frame: 1 });
    const getter = replaced ? () => ({ frame: 2 }) : f.scene.diagnostics;
    Object.defineProperty(window, "__GAME_DIAGNOSTICS__", { configurable: true, get: getter });
    window.__fb = replaced ? next : { scene: f.scene, net: f.scene.net };
    f.scene.releaseExternal();
    assert.equal(window.__fb, replaced ? next : undefined);
    assert.equal(
      Object.getOwnPropertyDescriptor(window, "__GAME_DIAGNOSTICS__")?.get,
      replaced ? getter : undefined,
    );
  }
});

test("actual main releases the real embed key gate and preserves a newer pause and pose owner", () => {
  for (const replacement of [false, true]) {
    class Surface extends Element {
      addEventListener(type, cb, options) {
        super.addEventListener(
          type,
          cb,
          options === true || options === false ? { capture: options } : options,
        );
      }
      removeEventListener(type, cb, options) {
        super.removeEventListener(
          type,
          cb,
          options === true || options === false ? { capture: options } : options,
        );
      }
    }
    const window = new Surface(),
      document = new Surface();
    window.parent = window;
    const source = stripTypeScriptTypes(
      readFileSync(new URL("../../../packages/embed/src/game.ts", import.meta.url), "utf8"),
      { mode: "transform" },
    )
      .replace(/^import[^;]*;\s*/gm, "")
      .replace(/^export /gm, "");
    const embed = new Function(
      "window",
      "HTMLElement",
      "GAME_PAUSED_MESSAGE",
      "GAME_STARTED_MESSAGE",
      "isPauseGameMessage",
      source + "; return {setPauseHandlers,notifyGameStarted,pauseGame,resumeGame,isPausable};",
    )(window, Element, "paused", "started", () => false);
    class GameScene {
      isOnline() {
        return false;
      }
      setPresentationPaused() {}
    }
    const scene = new GameScene();
    class Game {
      events = new EventEmitter();
      scene = { getScene: () => scene, isActive: () => true };
      scale = { refresh() {} };
      loop = { sleep() {}, wake() {} };
    }
    let closed = 0,
      resumed = 0;
    const deps = {
      Phaser: { Game, WEBGL: 1, Scale: { RESIZE: 1 }, Core: { Events: events } },
      setPauseHandlers: embed.setPauseHandlers,
      CONTROLS: [],
      initPoseCamera() {},
      disposePoseCamera: () => closed++,
      createFlappyPauseOverlay: () => ({ show() {}, hide() {} }),
      BootScene: class {},
      GameScene,
      window,
      document,
      setTimeout,
      clearTimeout,
    };
    const code = compile("../src/main.ts").replaceAll("import.meta.env.DEV", "true");
    const game = new Function(...Object.keys(deps), code + "; return game;")(
      ...Object.values(deps),
    );
    embed.notifyGameStarted();
    embed.pauseGame();
    assert.equal(window.listenerRecords.get("keyup").size, 1);
    const nextPose = () => {};
    let release;
    if (replacement) {
      release = embed.setPauseHandlers({ onResume: () => resumed++ });
      window.__fbPoseJump = nextPose;
    }
    game.events.emit("destroy");
    game.events.emit("destroy");
    assert.equal(closed, 1);
    assert.equal(window.__fbPoseJump, replacement ? nextPose : undefined);
    assert.equal(window.listenerRecords.get("keyup").size, replacement ? 1 : 0);
    embed.resumeGame();
    assert.equal(resumed, replacement ? 1 : 0);
    assert.equal(embed.isPausable(), replacement);
    release?.();
  }
});
