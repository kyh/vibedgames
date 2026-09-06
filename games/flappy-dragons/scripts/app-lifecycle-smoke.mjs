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
function sceneFixture() {
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
      challenge: 0,
      retry: 0,
      normal: 0,
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
    TOUCH: false,
    CONTROLS: [],
    ensureControlsStyle() {},
    buildControls: () => null,
    watchControlContext: () => () => calls.unwatch++,
  };
  const names = [
    "externalReleased",
    "routePointerEvents",
    "stopRoutePointer",
    "stopRouteKey",
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
    challengeStartEl: document.getElementById("challenge-start"),
    routeRetryEl: document.getElementById("route-retry"),
    routeNormalEl: document.getElementById("route-normal"),
    resultsEl: document.getElementById("flight-result"),
    routeHud: document.getElementById("route-hud"),
    onChallengeStart: () => calls.challenge++,
    onRouteRetry: () => calls.retry++,
    onRouteNormal: () => calls.normal++,
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
    g.routeHud.hidden = false;
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
    assert.equal(g.routeHud.hidden, true);
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
test("native route button Space/Enter and pointer events stay local without suppressing native activation", () => {
  const f = sceneFixture();
  for (const [element, action] of [
    [f.scene.challengeStartEl, "challenge"],
    [f.scene.routeRetryEl, "retry"],
    [f.scene.routeNormalEl, "normal"],
  ]) {
    for (const key of ["Enter", " "]) {
      for (const type of ["keydown", "keyup"]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "key", { value: key });
        element.dispatchEvent(event);
        assert.equal(event.cancelBubble, true);
        assert.equal(event.defaultPrevented, false);
      }
      element.click();
    }
    assert.equal(f.calls[action], 2);
    for (const type of ["pointerdown", "pointerup", "pointermove", "pointercancel"]) {
      const event = new Event(type, { bubbles: true });
      element.dispatchEvent(event);
      assert.equal(event.cancelBubble, true);
    }
  }
  assert.deepEqual([f.calls.flap, f.calls.begin], [0, 0]);
  f.keyboard.emit("keydown-SPACE", { repeat: false });
  assert.equal(f.calls.flap, 1);
  f.keyboard.emit("keyup", { key: "d" });
  assert.equal(f.calls.begin, 1);
  f.scene.releaseExternal();
  assert.equal(f.keyboard.eventNames().length, 0);
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
