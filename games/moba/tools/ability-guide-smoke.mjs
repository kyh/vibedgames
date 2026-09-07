import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { HERO_BY_ID } from "../src/data/heroes.ts";
import { abilityExplanation, experienceProgress } from "../src/render/hud-presentation.ts";
import { createWorld, spawnHero } from "../src/sim/world.ts";

const source = readFileSync(new URL("../src/scenes/hud-scene.ts", import.meta.url), "utf8");
function method(name) {
  const body = source.match(new RegExp(`^  (?:private )?${name}\\([^]*?^  }`, "m"))?.[0];
  assert.ok(body, `actual ${name}`);
  return body;
}

// A small DOM event boundary, not a layout/native-click emulation. Browser QA
// separately verifies real default activation, scrolling and Phaser input.
class Element {
  constructor(document) {
    this.document = document;
  }
  children = [];
  listeners = new Map();
  attributes = new Map();
  style = {};
  dataset = {};
  hidden = false;
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  setAttribute(key, value) {
    this.attributes.set(key, value);
  }
  addEventListener(key, fn) {
    this.listeners.set(key, [...(this.listeners.get(key) ?? []), fn]);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
  }
  focus() {
    this.document.activeElement = this;
  }
  dispatch(type, data = {}) {
    const event = {
      type,
      target: this,
      stopped: false,
      defaultPrevented: false,
      shiftKey: false,
      ...data,
      stopPropagation() {
        this.stopped = true;
      },
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (let node = this; node; node = node.parent) {
      for (const listener of node.listeners.get(type) ?? []) listener(event);
      if (event.stopped) break;
    }
    return event;
  }
}

function fixture() {
  const document = { activeElement: null, createElement: () => new Element(document) };
  document.body = new Element(document);
  document.head = new Element(document);
  const Guide = new Function(
    "document",
    "KEYS",
    "FONT",
    "HERO_BY_ID",
    "abilityExplanation",
    "experienceProgress",
    stripTypeScriptTypes(
      `class Guide { ${["buildAbilityGuide", "closeAbilityGuide", "refreshAbilityGuide", "refreshGuideOverflow", "layoutAbilityGuide"].map(method).join("\n")} }`,
    ) + ";return Guide;",
  )(
    document,
    ["Q", "W", "E", "R"],
    "sans-serif",
    HERO_BY_ID,
    abilityExplanation,
    experienceProgress,
  );
  const scene = new Guide();
  const unit = spawnHero(createWorld(501), "ironvow", "radiant", "local", false, 0);
  const calls = { clear: 0 };
  scene.gs = {
    player: unit,
    uiBlocking: false,
    matchResult: null,
    controlsPaused: false,
    clearHudInput() {
      calls.clear++;
    },
  };
  scene.shopOpen = false;
  scene.boardOpen = false;
  scene.buildAbilityGuide();
  return { scene, calls, document, unit };
}

test("actual guide consumes inspection input and releases ordinary controls on close", () => {
  const { scene, calls, document, unit } = fixture();
  const guide = scene.guide;
  guide.toggle.dispatch("click");
  assert.equal(scene.gs.uiBlocking, true);
  assert.equal(calls.clear, 1);
  assert.equal(document.activeElement, guide.close);
  const original = JSON.stringify(unit);
  for (const key of ["Q", "W", "E", "R"]) {
    assert.equal(guide.close.dispatch("keydown", { key, shiftKey: true }).stopped, true);
    assert.equal(guide.selected, key);
    assert.equal(guide.close.dispatch("keyup", { key }).stopped, true);
  }
  assert.equal(JSON.stringify(unit), original, "Inspecting never spends points or casts");
  assert.equal(guide.close.dispatch("pointerdown").stopped, true);
  assert.equal(guide.close.dispatch("keydown", { key: "m" }).stopped, false);
  assert.equal(
    guide.close.dispatch("keydown", { key: "Tab", shiftKey: true }).defaultPrevented,
    true,
  );
  assert.equal(document.activeElement.className, "guide-copy");
  assert.equal(document.activeElement.dispatch("keydown", { key: "Tab" }).defaultPrevented, true);
  assert.equal(document.activeElement, guide.close);
  guide.close.dispatch("keydown", { key: "Escape" });
  assert.equal(guide.panel.hidden, true);
  assert.equal(scene.gs.uiBlocking, false);
  assert.equal(calls.clear, 2);
  assert.equal(document.activeElement, guide.toggle);
  assert.equal(guide.toggle.dispatch("keyup", { key: "Escape" }).stopped, true);
  for (const key of ["ArrowRight", "q", "Escape"]) {
    assert.equal(guide.toggle.dispatch("keydown", { key }).stopped, false);
    assert.equal(guide.toggle.dispatch("keyup", { key }).stopped, false);
  }
  for (const key of ["Enter", " "]) {
    const event = guide.toggle.dispatch("keydown", { key });
    assert.equal(event.stopped, true);
    assert.equal(event.defaultPrevented, false, "Native button activation remains available");
  }
  scene.closeAbilityGuide();
  assert.equal(calls.clear, 2, "Repeated close has no input side effect");
});

test("paused/result admission and exact shutdown/destroy binding keep one native owner", () => {
  const f = fixture();
  f.scene.gs.controlsPaused = true;
  f.scene.guide.toggle.dispatch("click");
  f.scene.gs.controlsPaused = false;
  f.scene.gs.matchResult = {};
  f.scene.guide.toggle.dispatch("click");
  assert.equal(f.calls.clear, 0);
  f.scene.gs.matchResult = null;
  const binding = method("create").match(
    /this\.scale\.on[^]*?this\.events\.once\(Phaser\.Scenes\.Events\.DESTROY, release\);/,
  )?.[0];
  assert.ok(binding);
  const bind = new Function(
    "Phaser",
    stripTypeScriptTypes(`function bind(){${binding}}`) + ";return bind;",
  )({
    Scale: { Events: { RESIZE: "resize" } },
    Scenes: { Events: { SHUTDOWN: "shutdown", DESTROY: "destroy" } },
  });
  f.scene.scale = new EventEmitter();
  f.scene.events = new EventEmitter();
  f.scene.layout = () => {};
  for (const event of ["shutdown", "shutdown", "destroy"]) {
    const old = f.scene.guide;
    assert.equal(f.document.body.children.length, 1);
    assert.equal(f.document.head.children.length, 1);
    bind.call(f.scene);
    f.scene.events.emit(event);
    f.scene.events.emit(event);
    assert.equal(f.scene.guide, null);
    assert.equal(f.document.body.children.length, 0);
    assert.equal(f.document.head.children.length, 0);
    assert.equal(f.scene.events.listenerCount("destroy"), 0);
    assert.equal(f.scene.scale.listenerCount("resize"), 0);
    old.toggle.dispatch("click");
    assert.equal(f.calls.clear, 0, "Retained dead DOM cannot issue input");
    if (event !== "destroy") f.scene.buildAbilityGuide();
  }
});

test("overflow cue follows remaining content without resizing the panel", () => {
  const { scene } = fixture();
  const guide = scene.guide;
  Object.assign(guide.copy, { scrollHeight: 300, clientHeight: 80, scrollTop: 0 });
  guide.toggle.dispatch("click");
  assert.equal(guide.more.style.visibility, "visible");
  guide.copy.scrollTop = 220;
  guide.copy.dispatch("scroll");
  assert.equal(guide.more.style.visibility, "hidden");
  guide.copy.scrollTop = 0;
  guide.copy.scrollHeight = 80;
  guide.copy.dispatch("scroll");
  assert.equal(guide.more.style.visibility, "hidden");
  assert.equal(guide.panel.style.maxHeight, undefined, "Overflow state never changes panel bounds");
});
