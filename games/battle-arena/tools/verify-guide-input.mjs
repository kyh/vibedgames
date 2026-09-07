import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { AbilityGuide } from "../src/render/ability-guide.ts";
import { Controls } from "../src/input/controls.ts";
import { notifyGameStarted, setPauseHandlers } from "../../../packages/embed/src/game.ts";

// Real guide/Controls/PhysicalGamepad and embed capture callbacks; a tiny native
// element collaborator supplies dialog state/focus. Native propagation/layout
// and pointer-lock permission remain browser acceptance, not this fixture.
class Element extends EventTarget {
  constructor(tagName = "DIV") {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.open = false;
    this.isConnected = true;
    this.attributes = new Map();
    this.classList = { toggle() {} };
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  setAttribute(key, value) {
    this.attributes.set(key, value);
  }
  focus() {
    document.activeElement = this;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  remove() {
    this.isConnected = false;
  }
  requestPointerLock() {
    return Promise.resolve();
  }
}
globalThis.HTMLElement = Element;
globalThis.window = new EventTarget();
window.parent = window;
globalThis.document = {
  body: new Element(),
  head: new Element(),
  activeElement: new Element("button"),
  pointerLockElement: null,
  exitPointerLock() {},
  createElement: (tag) => new Element(tag),
  getElementById: () => null,
};
let buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { getGamepads: () => [{ connected: true, axes: [0, 0, 0, 0], buttons }] },
});
const controls = new Controls(new Element("canvas"));
controls.resetInput();
const phases = [];
let pauses = 0,
  resumes = 0,
  overlay = false;
const loops = [];
// Only the two actual scene methods needed here; importing the boot-dependent
// GameScene directly would require Vite's import.meta.env in a Node fixture.
const sceneSource = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const sceneMethod = (signature) => {
  const at = sceneSource.indexOf(signature);
  assert.ok(at >= 0);
  return sceneSource.slice(at, sceneSource.indexOf("\n  }", at) + 4);
};
const SceneInput = new Function(
  `${stripTypeScriptTypes(`class SceneInput {${sceneMethod("  get isGuideOpen()")}\n${sceneMethod("  private resetHeldInput()")} }`)}\nreturn SceneInput;`,
)();
const scene = Object.assign(new SceneInput(), {
  controls,
  touch: null,
  hud: { consumeItemTaps: () => [] },
  pauseAudio() {
    pauses++;
    this.guide.close();
  },
  resumeAudio() {
    resumes++;
  },
});
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const start = main.indexOf("  setPauseHandlers({");
assert.ok(start >= 0);
const binding = main.slice(start, main.indexOf("\n  });", start) + "\n  });".length);
new Function(
  "setPauseHandlers",
  "activeScene",
  "pauseOverlay",
  "view",
  "timer",
  "matchLoop",
  `let onlineMatch=false;let froze=false;\n${stripTypeScriptTypes(binding)}`,
)(
  setPauseHandlers,
  scene,
  {
    show: () => {
      overlay = true;
    },
    hide: () => {
      overlay = false;
    },
  },
  { renderer: { setAnimationLoop: (loop) => loops.push(loop) } },
  { reset() {} },
  () => {},
);
scene.guide = new AbilityGuide((open) => {
  phases.push(open);
  scene.resetHeldInput();
  controls.setMouseMode(open);
});
notifyGameStarted();
const escape = () => {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperties(event, {
    key: { value: "Escape" },
    code: { value: "Escape" },
    repeat: { value: false },
  });
  window.dispatchEvent(event);
};
scene.guide.show("knight");
assert.equal(scene.isGuideOpen, true);
escape();
assert.equal(scene.isGuideOpen, false);
assert.equal(pauses, 0, "first Escape closes only the actual guide");
assert.equal(overlay, false);
assert.deepEqual(loops, [], "offline render/sim loop not stopped by guide close");
assert.deepEqual(phases, [true, false]);
escape();
assert.equal(pauses, 1, "next Escape still pauses normally");
assert.equal(overlay, true);
assert.equal(loops[0], null);
escape();
assert.equal(resumes, 1);
assert.equal(overlay, false);
scene.guide.show("knight");
const cancel = new Event("cancel", { cancelable: true });
scene.guide.dialog.dispatchEvent(cancel);
assert.equal(cancel.defaultPrevented, true);
assert.equal(scene.isGuideOpen, false);
assert.equal(pauses, 1, "native cancel owns only dialog state");

// A held menu confirm is already sampled when a new match starts.
buttons[0] = { pressed: true, value: 1 };
controls.resetInput();
controls.update(1 / 60);
assert.equal(controls.consumeJump(), false);
buttons[0] = { pressed: false, value: 0 };
controls.update(1 / 60);
buttons[0] = { pressed: true, value: 1 };
controls.update(1 / 60);
assert.equal(controls.consumeJump(), true, "fresh A retains original hop");
buttons[0] = { pressed: false, value: 0 };
scene.guide.show("knight");
buttons[1] = { pressed: true, value: 1 };
scene.guide.update();
assert.equal(scene.guide.open, false);
controls.update(1 / 60);
assert.equal(controls.consumeDash(), false, "guide B dismissal cannot become a dash");
buttons[1] = { pressed: false, value: 0 };
controls.update(1 / 60);
buttons[1] = { pressed: true, value: 1 };
controls.update(1 / 60);
assert.equal(controls.consumeDash(), true);
buttons[1] = { pressed: false, value: 0 };
const inspectKey = new Event("keydown", { cancelable: true });
Object.defineProperties(inspectKey, {
  code: { value: "KeyH" },
  key: { value: "h" },
  repeat: { value: false },
});
window.dispatchEvent(inspectKey);
assert.equal(controls.consumeGuide(), true, "H offers inspection without an attack binding");
scene.guide.show("knight");
window.dispatchEvent(inspectKey);
assert.equal(scene.guide.open, false);
assert.equal(controls.consumeGuide(), false, "closing H cannot reopen on the next frame");
buttons[10] = { pressed: true, value: 1 };
controls.update(1 / 60);
assert.equal(controls.consumeGuide(), true, "L3 reaches the same inspection queue");
scene.guide.show("knight");
buttons[10] = { pressed: false, value: 0 };
scene.guide.update();
buttons[10] = { pressed: true, value: 1 };
scene.guide.update();
assert.equal(scene.guide.open, false);
controls.update(1 / 60);
assert.equal(controls.consumeGuide(), false, "closing L3 requires release before reopening");
scene.guide.dispose();
scene.guide.dispose();
controls.dispose();
setPauseHandlers({});
assert.equal(scene.guide.dialog.isConnected, false);
console.log(
  "PASS: actual main/guide/embed Escape priority; native cancel; real pad held-A, guide-B, H and L3 rearm (6 groups)",
);
