import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { VirtualGamepad } from "../../../packages/gamepad/src/core.ts";
import { PhysicalGamepad } from "../../../packages/gamepad/src/physical.ts";
import { fixture, loadClass, neutral } from "./checkpoint-harness.mjs";
const require = createRequire(import.meta.url),
  root = dirname(require.resolve("phaser/package.json"));
const Key = require(join(root, "src/input/keyboard/keys/Key.js"));
const JustDown = require(join(root, "src/input/keyboard/keys/JustDown.js"));
const KeyCodes = require(join(root, "src/input/keyboard/keys/KeyCodes.js"));
let padButtons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false }));
const physical = new PhysicalGamepad({
  poll: () => [
    {
      connected: true,
      index: 0,
      id: "fixture",
      mapping: "standard",
      buttons: padButtons,
      axes: [0, 0],
    },
  ],
});
const Input = loadClass("../src/sys/input.ts", "Input", {
  Phaser: { Input: { Keyboard: { KeyCodes, JustDown } } },
  PhysicalGamepad: function PhysicalOwner() {
    return physical;
  },
});
const keys = new Map(),
  virtual = new VirtualGamepad({ buttons: [{ id: "atk", position: () => ({ x: 300, y: 300 }) }] });
virtual.setViewport(400, 400);
const gp = {
  pad: virtual,
  getStick: () => virtual.getStick(),
  justPressed: (id) => virtual.justPressed(id),
  isButtonDown: (id) => virtual.isButtonDown(id),
};
const controls = new Input(
  {
    input: {
      keyboard: {
        addKey: (code) => {
          const key = new Key(null, code);
          keys.set(code, key);
          return key;
        },
      },
    },
  },
  gp,
);
const f = fixture();
f.scene.controls = controls;
keys.get(KeyCodes.RIGHT).onDown({ timeStamp: 10 });
keys.get(KeyCodes.J).onDown({ timeStamp: 10 });
virtual.pointerDown(1, 300, 300);
virtual.nextFrame();
padButtons[2] = { pressed: true, value: 1, touched: true };
controls.update();
assert.equal(controls.sample().right, true);
assert.equal(controls.sample().attackPressed, true);
f.scene.player.buffer({ ...neutral, right: true, attackPressed: true });
f.scene.setControlsPaused(true);
assert.equal(virtual.isTouching, false);
assert.equal(keys.get(KeyCodes.RIGHT).isDown, false);
assert.equal(f.scene.player.body.checkpoint().attackBuf, 0);
assert.equal(controls.sample().attackPressed, false);
f.scene.setControlsPaused(false);
controls.update();
virtual.nextFrame();
assert.equal(
  controls.sample().attackPressed,
  false,
  "held physical button and previous touch cannot replay on resume",
);
assert.equal(controls.sample().right, false);
padButtons[2] = { pressed: false, value: 0, touched: false };
controls.update();
padButtons[2] = { pressed: true, value: 1, touched: true };
controls.update();
assert.equal(controls.sample().attackPressed, true, "fresh physical edge still works");
const before = f.scene.remote.x;
f.session.players.right.state.input = { ...neutral, left: true, j: 0, d: 0, a: 0, s: 0 };
f.scene.setControlsPaused(true);
f.scene.update(0, 50);
assert.ok(f.scene.remote.x < before, "online partner keeps moving while local controls paused");
assert.equal(f.scene.player.body.checkpoint().hRight, false);
controls.destroy();
console.log(
  "PASS actual Phaser key / VirtualGamepad / PhysicalGamepad pause reset and live partner simulation",
);
