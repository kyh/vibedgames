import assert from "node:assert/strict";
import { test } from "node:test";

import { VirtualGamepad } from "../src/core.js";

/**
 * lunerfall's real geometry: a 586x270 canvas with the action cluster in the
 * bottom-right corner. (500, 200) is the dead gap between DASH and JUMP — a
 * thumb that reached for a button and missed.
 */
const CLUSTER_LEFT = 480;
const CLUSTER_TOP = 170;

function pad(region?: (p: { x: number; y: number }) => boolean): VirtualGamepad {
  const gamepad = new VirtualGamepad({
    stick: { radius: 40, deadZone: 8, knobRadius: 14, region },
    buttons: [{ id: "jump", radius: 21, position: () => ({ x: 556, y: 236 }) }],
  });
  gamepad.setViewport(586, 270);
  return gamepad;
}

test("without a region, any free touch anchors the stick", () => {
  const gamepad = pad();
  gamepad.pointerDown(1, 500, 200);
  gamepad.pointerMove(1, 460, 200);
  const stick = gamepad.getStick();
  assert.equal(stick.active, true);
  assert.equal(stick.dx, -40);
});

test("a touch outside the stick region is ignored, not turned into movement", () => {
  const outsideCluster = (p: { x: number; y: number }): boolean =>
    p.x < CLUSTER_LEFT || p.y < CLUSTER_TOP;
  const gamepad = pad(outsideCluster);
  gamepad.pointerDown(1, 500, 200);
  gamepad.pointerMove(1, 460, 200);
  assert.equal(gamepad.getStick().active, false);
  assert.equal(gamepad.isTouching, false);
});

test("a region still lets the stick anchor everywhere else", () => {
  const outsideCluster = (p: { x: number; y: number }): boolean =>
    p.x < CLUSTER_LEFT || p.y < CLUSTER_TOP;
  const gamepad = pad(outsideCluster);
  gamepad.pointerDown(1, 120, 200);
  gamepad.pointerMove(1, 80, 200);
  const stick = gamepad.getStick();
  assert.equal(stick.active, true);
  assert.equal(stick.magnitude, 1);
});

test("a region never blocks a fixed button inside it", () => {
  const gamepad = pad(() => false);
  gamepad.pointerDown(1, 556, 236);
  assert.equal(gamepad.isButtonDown("jump"), true);
});

test("stick geometry stays a plain tuning record", () => {
  const geom = pad(() => true).getStickGeometry();
  assert.deepEqual(geom, { radius: 40, deadZone: 8, knobRadius: 14 });
});
