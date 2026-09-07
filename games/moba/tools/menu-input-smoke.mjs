import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { HEROES } from "../src/data/heroes.ts";
import { PhysicalGamepad } from "../../../packages/gamepad/src/physical.ts";

const source = readFileSync(new URL("../src/scenes/menu-scene.ts", import.meta.url), "utf8");
function method(name) {
  const text = source.match(
    new RegExp(`^  (?:(?:private|override) )?${name}\\([^]*?^  }`, "m"),
  )?.[0];
  assert.ok(text, `actual ${name}`);
  return text;
}
const names = [
  "onMenuKeyDown",
  "onMenuKeyUp",
  "update",
  "moveFocus",
  "focusPlay",
  "confirmFocus",
  "beginMatch",
  "paintFocus",
  "select",
];
const createMenu = new Function(
  "HEROES",
  "notifyGameStarted",
  stripTypeScriptTypes(`class Menu extends Object { ${names.map(method).join("\n")} }`) +
    ";return Menu;",
);
function display() {
  return {
    visible: false,
    width: 200,
    y: 600,
    setVisible(value) {
      this.visible = value;
      return this;
    },
    setStrokeStyle(...value) {
      this.stroke = value;
      return this;
    },
    setText(value) {
      this.text = value;
      return this;
    },
    setScale(value) {
      this.scale = value;
      return this;
    },
    setTexture(value) {
      this.texture = value;
      return this;
    },
    setY(value) {
      this.y = value;
      return this;
    },
  };
}
function fixture(offline = false, columns = 6) {
  const calls = { notified: 0, matches: [] },
    timers = [];
  const Menu = createMenu(HEROES, () => calls.notified++);
  const scene = new Menu();
  Object.assign(scene, {
    selected: HEROES[0].id,
    cardColumns: columns,
    focus: { kind: "champion" },
    menuLive: true,
    starting: false,
    keyboardConfirmArmed: true,
    padConfirmArmed: false,
    cards: HEROES.map((hero) => ({ id: hero.id, ring: display() })),
    actions: (offline ? [false] : [false, true]).map((online) => ({
      online,
      color: online ? "red" : "blue",
      button: display(),
      label: display(),
      ring: display(),
    })),
    navigationHint: display(),
    scale: new EventEmitter(),
    events: new EventEmitter(),
    input: { keyboard: new EventEmitter() },
    queueRelayout() {},
    preview(id) {
      this.previewed = id;
    },
    time: {
      delayedCall(delay, callback) {
        const timer = {
          delay,
          callback,
          removed: false,
          remove() {
            this.removed = true;
          },
        };
        timers.push(timer);
        return timer;
      },
    },
    scene: {
      start(key, args) {
        calls.matches.push({ key, ...args });
      },
    },
  });
  scene.scale.width = 1280;
  const keyDown = (key, repeat = false) => {
    const event = {
      key,
      repeat,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    scene.onMenuKeyDown(event);
    return event;
  };
  const press = (key) => {
    keyDown(key);
    scene.onMenuKeyUp({ key });
  };
  return { scene, calls, timers, keyDown, press };
}

test("all6 original cards remain reachable in row and three-column layouts", () => {
  for (const columns of [6, 3]) {
    const { scene, press } = fixture(false, columns);
    for (const hero of HEROES) {
      assert.equal(scene.selected, hero.id);
      press("ArrowRight");
    }
    assert.equal(scene.selected, HEROES[0].id);
    press("ArrowRight");
    press("ArrowUp");
    assert.equal(scene.selected, HEROES[1].id, "Top-row Up preserves its column");
    if (columns === 3) {
      press("ArrowDown");
      assert.equal(scene.selected, HEROES[4].id);
      press("ArrowUp");
      assert.equal(scene.selected, HEROES[1].id);
    }
    scene.select(HEROES[5].id);
    press("ArrowDown");
    assert.equal(scene.focus.kind, "action");
    assert.equal(scene.focus.action.online, false);
    press("ArrowUp");
    assert.equal(scene.focus.kind, "champion");
    assert.equal(scene.selected, HEROES[5].id);
  }
});

test("Enter first focuses Bots, repeat cannot launch, next deliberate press launches once at80ms", () => {
  const f = fixture();
  f.press("ArrowRight");
  f.keyDown("Enter");
  assert.equal(f.scene.focus.kind, "action");
  assert.equal(f.scene.focus.action.online, false);
  assert.equal(f.calls.notified, 0);
  f.keyDown("Enter", true);
  f.keyDown("Enter");
  assert.equal(f.calls.notified, 0);
  f.scene.onMenuKeyUp({ key: "Enter" });
  f.keyDown("Enter");
  f.scene.beginMatch(f.scene.actions[1]);
  f.press("ArrowRight");
  assert.equal(f.calls.notified, 1);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 80);
  assert.equal(f.calls.matches.length, 0);
  f.timers[0].callback();
  assert.deepEqual(f.calls.matches, [{ key: "Game", heroId: HEROES[1].id, online: false }]);
});

test("Online requires an explicit focused choice; offline menus cannot reach it", () => {
  for (const offline of [false, true]) {
    const f = fixture(offline);
    f.press("Enter");
    f.press("ArrowRight");
    assert.equal(f.scene.focus.action.online, !offline);
    f.press("Enter");
    f.timers[0].callback();
    assert.equal(f.calls.matches[0].online, !offline);
  }
  const pointer = fixture();
  pointer.scene.select(HEROES[5].id);
  pointer.scene.beginMatch(pointer.scene.actions[1]);
  pointer.timers[0].callback();
  assert.equal(pointer.calls.matches[0].heroId, HEROES[5].id);
  assert.equal(pointer.calls.matches[0].online, true, "Existing pointer start stays one action");
});

test("real PhysicalGamepad edges navigate and require release before both confirmations", () => {
  const f = fixture(false, 3);
  const pressed = new Set([0]);
  let connected = true;
  const snapshot = () => [
    {
      connected,
      axes: [0, 0],
      buttons: Array.from({ length: 16 }, (_, i) => ({
        pressed: pressed.has(i),
        value: Number(pressed.has(i)),
      })),
    },
  ];
  f.scene.pad = new PhysicalGamepad({ poll: snapshot });
  f.scene.update();
  f.scene.update();
  assert.equal(f.scene.focus.kind, "champion", "Held entry A is not an action");
  const press = (button) => {
    pressed.clear();
    f.scene.update();
    pressed.add(button);
    f.scene.update();
  };
  press(15);
  assert.equal(f.scene.selected, HEROES[1].id);
  f.scene.update();
  assert.equal(f.scene.selected, HEROES[1].id, "Held D-pad does not cycle every frame");
  press(13);
  assert.equal(f.scene.selected, HEROES[4].id);
  press(0);
  assert.equal(f.scene.focus.action.online, false);
  f.scene.update();
  assert.equal(f.calls.notified, 0);
  press(1);
  assert.equal(f.scene.focus.kind, "champion");
  press(0);
  press(15);
  assert.equal(f.scene.focus.action.online, true);
  connected = false;
  f.scene.update();
  connected = true;
  pressed.clear();
  pressed.add(0);
  f.scene.update();
  assert.equal(f.calls.notified, 0, "Reconnect with held A remains quiet");
  press(0);
  assert.equal(f.calls.notified, 1);
});

test("actual paired release cancels launch and removes keyboard/pad owners across3cycles", () => {
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
  for (const ending of ["shutdown", "shutdown", "destroy"]) {
    const f = fixture();
    f.scene.input.keyboard.on("keydown", f.scene.onMenuKeyDown);
    f.scene.input.keyboard.on("keyup", f.scene.onMenuKeyUp);
    const pad = new PhysicalGamepad({ poll: () => [] });
    f.scene.pad = pad;
    bind.call(f.scene);
    f.scene.beginMatch(f.scene.actions[0]);
    f.scene.events.emit(ending);
    f.scene.events.emit(ending);
    assert.equal(f.timers[0].removed, true);
    f.timers[0].callback();
    assert.equal(f.calls.matches.length, 0, "No stale launch after leaving Menu");
    assert.equal(f.scene.pad, null);
    assert.equal(f.scene.input.keyboard.listenerCount("keydown"), 0);
    assert.equal(f.scene.input.keyboard.listenerCount("keyup"), 0);
    assert.equal(f.scene.scale.listenerCount("resize"), 0);
    assert.equal(f.scene.events.listenerCount("destroy"), 0);
    f.scene.confirmFocus();
    assert.equal(f.calls.notified, 1, "Retained handler cannot launch again");
  }
});
