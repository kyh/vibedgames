import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import * as constants from "../src/shared/constants.ts";
const source = readFileSync(new URL("../src/input/pose-control.ts", import.meta.url), "utf8");
function harness(text = source) {
  let now = 0;
  const events = [];
  const deps = { ...constants, performance: { now: () => now } };
  const code = stripTypeScriptTypes(
    text.replace(/^import[^;]*;\n/gm, "").replaceAll("export ", ""),
  );
  const Subject = new Function(...Object.keys(deps), `${code};return PoseControls`)(
    ...Object.values(deps),
  );
  const actions = Object.fromEntries(
    ["steer", "orbit", "rotate", "hold", "power", "catchCollapse"].map((name) => [
      name,
      (...args) => {
        events.push([now, name, ...args]);
        return true;
      },
    ]),
  );
  const control = new Subject(actions);
  return {
    control,
    events,
    feed(p) {
      now += 1000 / 60;
      control.handlePose(p, null);
    },
  };
}
function pose(kind = "neutral", frame = 0) {
  const points = {
    nose: [50, 20],
    left_shoulder: [35, 40],
    right_shoulder: [65, 40],
    left_hip: [40, 75],
    right_hip: [60, 75],
    left_wrist: [30, 65],
    right_wrist: [70, 65],
  };
  if (kind === "left") points.nose[0] = 68;
  if (kind === "right") points.nose[0] = 32;
  if (kind === "twist") {
    points.left_shoulder[0] = 44;
    points.right_shoulder[0] = 56;
  }
  if (kind === "hold") {
    points.left_wrist = [70, 55];
    points.right_wrist = [30, 55];
  }
  if (kind === "power") {
    points.left_wrist = [5, 40];
    points.right_wrist = [95, 40];
  }
  if (kind === "catch") {
    points.left_wrist[1] = 5;
    points.right_wrist[1] = 5;
  }
  if (kind === "circle")
    points.left_wrist = [30 + 14 * Math.cos(frame * 0.3), 20 + 14 * Math.sin(frame * 0.3)];
  return {
    width: 100,
    height: 100,
    keypoints: Object.entries(points).map(([name, [x, y]]) => ({ name, x, y, score: 1 })),
  };
}
function trace(text) {
  const h = harness(text);
  const kinds = [
    "neutral",
    "left",
    "right",
    "twist",
    "hold",
    "power",
    "neutral",
    "catch",
    "neutral",
    "circle",
  ];
  for (let i = 0; i < 2400; i++) h.feed(pose(kinds[Math.floor(i / 60) % kinds.length], i));
  return h.events;
}
test("original 2400-frame multichannel pose detector trace stays exact", () => {
  const events = trace(source);
  const hash = createHash("sha256").update(JSON.stringify(events)).digest("hex");
  assert.equal(events.length, 2413);
  assert.equal(hash, "dd60fe7ad7710dc71a9b8cc4195f9b6051ffda0529f28f25ac9197eda0c2b8d1");
  if (process.env.TETRIS_BASELINE_POSE) {
    assert.deepEqual(events, trace(readFileSync(process.env.TETRIS_BASELINE_POSE, "utf8")));
  }
  assert.equal(new Set(events.map((e) => e[1])).size, 6);
});
test("paused and held-resume gestures stay neutral until body returns to neutral", () => {
  const h = harness();
  for (let i = 0; i < 60; i++) h.feed(pose());
  h.events.length = 0;
  h.control.setActionsPaused(true);
  for (let i = 0; i < 120; i++)
    h.feed(pose(["power", "hold", "twist", "catch", "circle"][i % 5], i));
  h.control.setActionsPaused(false);
  for (let i = 0; i < 120; i++) h.feed(pose("power"));
  assert.deepEqual(h.events, []);
  h.feed(pose());
  h.feed(pose());
  h.feed(pose("power"));
  assert.equal(h.events.filter((e) => e[1] === "power").length, 1);
  h.feed(pose());
  h.feed(pose("catch"));
  assert.equal(h.events.filter((e) => e[1] === "catchCollapse").length, 1);
});
