import assert from "node:assert/strict";
import { test } from "node:test";

import {
  screenSpacePosition,
  screenSpaceTransform,
  type CameraView,
  type ScreenSpaceTransform,
} from "../src/screen-space.js";

/**
 * Phaser's transform for a `scrollFactor(0)` object, measured off the
 * framebuffer in Chrome (Phaser 4.2.1) rather than derived from the docs: a dot
 * drawn at local (309, 768) through bomberman's portrait camera
 * (393x852, zoom 0.81875) rendered at canvas (288.6, 706), and three other
 * sample points agreed to within the 0.5px centroid convention.
 *
 *   canvas = pivot + R(rotation) * zoom * (local - pivot)
 */
function throughCamera(view: CameraView, x: number, y: number): [number, number] {
  const px = view.width * view.originX;
  const py = view.height * view.originY;
  const dx = (x - px) * view.zoom;
  const dy = (y - py) * view.zoom;
  const cos = Math.cos(view.rotation);
  const sin = Math.sin(view.rotation);
  return [px + dx * cos - dy * sin, py + dx * sin + dy * cos];
}

/** A game object's own ITRS, applied to a point in its local space. */
function throughObject(t: ScreenSpaceTransform, x: number, y: number): [number, number] {
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return [t.x + (x * cos - y * sin) * t.scale, t.y + (x * sin + y * cos) * t.scale];
}

/** What `setScrollFactor(0)` alone gives you: no counter-transform at all. */
const UNPINNED: ScreenSpaceTransform = { x: 0, y: 0, rotation: 0, scale: 1 };

const PORTRAIT: CameraView = {
  width: 393,
  height: 852,
  originX: 0.5,
  originY: 0.5,
  zoom: 0.81875,
  rotation: 0,
};
const LANDSCAPE: CameraView = { ...PORTRAIT, width: 852, height: 393, zoom: 0.6463815789473685 };

/** Every zoom the affected games reach: moba 0.55, bomberman 0.65–0.82,
 *  starfall's phone floor, desktop 1, and bomberman's 2.4 ceiling. */
const ZOOMS = [0.55, 0.6, 0.6463815789473685, 0.81875, 1, 1.5, 2.4];
const ROLLS = [0, 0.04, -0.09, Math.PI / 6];
const POINTS: [number, number][] = [
  [0, 0],
  [309, 768],
  [84, 84],
  [196.5, 426],
  [392, 851],
];

test("a pinned overlay draws where it hit-tests, at every zoom and roll", () => {
  for (const view of [PORTRAIT, LANDSCAPE]) {
    for (const zoom of ZOOMS) {
      for (const rotation of ROLLS) {
        const camera: CameraView = { ...view, zoom, rotation };
        const pin = screenSpaceTransform(camera);
        for (const [x, y] of POINTS) {
          const [cx, cy] = throughCamera(camera, ...throughObject(pin, x, y));
          const drift = Math.hypot(cx - x, cy - y);
          assert.ok(
            drift < 1e-6,
            `zoom ${zoom} roll ${rotation}: (${x}, ${y}) drew at (${cx}, ${cy}), off by ${drift}`,
          );
        }
      }
    }
  }
});

test("a sibling object lands on the canvas point it was given", () => {
  const camera: CameraView = { ...PORTRAIT, rotation: 0.11 };
  const pin = screenSpaceTransform(camera);
  for (const [x, y] of POINTS) {
    const at = screenSpacePosition(pin, x, y);
    const [cx, cy] = throughCamera(camera, at.x, at.y);
    assert.ok(Math.hypot(cx - x, cy - y) < 1e-6, `label for (${x}, ${y}) drew at (${cx}, ${cy})`);
  }
});

test("setScrollFactor(0) alone misses the hit target whenever zoom != 1", () => {
  // The bug this guards: bomberman anchors its bomb button at (309, 768) with a
  // 52px hit radius, so any drift past 52px makes the visible button a decoy.
  const [x, y] = [309, 768];
  const radius = 52;
  for (const view of [PORTRAIT, LANDSCAPE]) {
    const target = view === PORTRAIT ? [x, y] : [y, x];
    const [tx, ty] = [target[0] ?? 0, target[1] ?? 0];
    const [cx, cy] = throughCamera(view, ...throughObject(UNPINNED, tx, ty));
    assert.ok(
      Math.hypot(cx - tx, cy - ty) > radius,
      `unpinned overlay at zoom ${view.zoom} drew (${tx}, ${ty}) at (${cx}, ${cy}) — inside the hit circle, so this test proves nothing`,
    );
  }
  // ...and at zoom 1 it is harmless, which is why desktop never caught it.
  const flat: CameraView = { ...PORTRAIT, zoom: 1 };
  const [fx, fy] = throughCamera(flat, ...throughObject(UNPINNED, x, y));
  assert.deepEqual([fx, fy], [x, y]);
});

test("a zero zoom cannot produce a non-finite transform", () => {
  const pin = screenSpaceTransform({ ...PORTRAIT, zoom: 0 });
  assert.ok(Number.isFinite(pin.x) && Number.isFinite(pin.y) && Number.isFinite(pin.scale));
});
