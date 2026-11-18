import assert from "node:assert/strict";
import { test } from "node:test";

import { screenSpacePosition, screenSpaceTransform } from "../src/screen-space.js";
import type { CameraView, ScreenSpaceTransform } from "../src/screen-space.js";

const throughCamera: (view: CameraView, x: number, y: number) => [number, number] = (
  view,
  x,
  y,
) => {
  const px = view.width * view.originX;
  const py = view.height * view.originY;
  const dx = (x - px) * view.zoom;
  const dy = (y - py) * view.zoom;
  const cos = Math.cos(view.rotation);
  const sin = Math.sin(view.rotation);

  return [px + dx * cos - dy * sin, py + dx * sin + dy * cos];
};

const throughObject: (t: ScreenSpaceTransform, x: number, y: number) => [number, number] = (
  t,
  x,
  y,
) => {
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);

  return [t.x + (x * cos - y * sin) * t.scale, t.y + (x * sin + y * cos) * t.scale];
};

const UNPINNED: ScreenSpaceTransform = { rotation: 0, scale: 1, x: 0, y: 0 };

const PORTRAIT: CameraView = {
  height: 852,
  originX: 0.5,
  originY: 0.5,
  rotation: 0,
  width: 393,
  zoom: 0.81875,
};

const LANDSCAPE: CameraView = { ...PORTRAIT, height: 393, width: 852, zoom: 0.6463815789473685 };

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
        const camera: CameraView = { ...view, rotation, zoom };
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

  const flat: CameraView = { ...PORTRAIT, zoom: 1 };
  const [fx, fy] = throughCamera(flat, ...throughObject(UNPINNED, x, y));
  assert.deepEqual([fx, fy], [x, y]);
});

test("a zero zoom cannot produce a non-finite transform", () => {
  const pin = screenSpaceTransform({ ...PORTRAIT, zoom: 0 });
  assert.ok(Number.isFinite(pin.x) && Number.isFinite(pin.y) && Number.isFinite(pin.scale));
});
