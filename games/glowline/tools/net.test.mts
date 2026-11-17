// The wire format and the host handover, under Node: a pose survives the trip,
// and a client promoted to host picks the bots up where the rows left them.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BotField, botKey } from "../src/net/bot-field.ts";
import type { BotFrame } from "../src/net/bot-field.ts";
import { encodePose, readPose } from "../src/net/pose.ts";
import { spawnKart, stepKart } from "../src/sim/kart.ts";
import { TRACKS } from "../src/sim/track.ts";

const DT = 1 / 60;
const [track] = TRACKS;
assert.ok(track);

const frame = (count: number, now: number): BotFrame => ({
  count,
  dt: DT,
  leaderProg: null,
  now,
  others: new Map(),
  ownerAt: () => 0,
  racing: true,
  slotOf: () => 2,
  time: now / 1000,
  track,
});

test("a pose survives the wire, and junk rows are refused", () => {
  const kart = spawnKart(track, 2);
  for (let i = 0; i < 120; i += 1) {
    stepKart(kart, { brake: 0, drift: false, steer: 0.2, throttle: 1 }, track, DT, 0, 1);
  }
  const report = readPose(encodePose(kart, 12_345.6, 7));
  assert.ok(report);
  assert.equal(report.t, 12_346);
  assert.equal(report.round, 7);
  assert.ok(Math.abs(report.x - kart.x) < 0.01);
  assert.ok(Math.abs(report.z - kart.z) < 0.01);
  assert.ok(Math.abs(report.prog - kart.prog) < 0.01);
  assert.equal(readPose(null), null);
  assert.equal(readPose({ t: 1, x: 2 }), null);
  assert.equal(readPose({ a: "0", t: 1, x: 2, z: 3 }), null);
});

test("the host's bots advance, and only the first `count` of them", () => {
  const field = new BotField();
  field.reset(track, 1);
  for (let i = 0; i < 300; i += 1) {
    field.step(frame(3, i * DT * 1000));
  }
  const poses = new Map(field.poses(true, undefined, 5, 1));
  assert.equal(poses.size, 5);
  for (let index = 0; index < 5; index += 1) {
    const pose = poses.get(botKey(index));
    assert.ok(pose);
    // 5 s of racing is well past the line for a stepped bot; an idle one is still on the grid.
    assert.equal(pose.prog > 60, index < 3, `bot ${index} at ${pose.prog}`);
  }
});

test("a new host carries the bots on from the last rows", () => {
  const old = new BotField();
  old.reset(track, 1);
  for (let i = 0; i < 600; i += 1) {
    old.step(frame(5, i * DT * 1000));
  }
  const rows = old.rows(5, 10_000, 1);
  const before = new Map(old.poses(true, undefined, 5, 1));

  const next = new BotField();
  next.adopt(track, rows, 1);
  const adopted = new Map(next.poses(true, undefined, 5, 1));
  for (const [key, pose] of before) {
    const mine = adopted.get(key);
    assert.ok(mine);
    assert.ok(Math.hypot(mine.x - pose.x, mine.z - pose.z) < 0.02, `${key} moved on handover`);
    assert.ok(Math.abs(mine.prog - pose.prog) < 0.02);
    assert.ok(Math.abs(mine.speed - pose.speed) < 0.05);
    assert.equal(mine.drift, pose.drift, `${key} lost its drift on handover`);
    assert.equal(mine.boosting, pose.boosting, `${key} lost its boost on handover`);
    assert.ok(Math.abs(mine.charge - pose.charge) < 0.01);
  }
  for (let i = 0; i < 120; i += 1) {
    next.step(frame(5, 10_000 + i * DT * 1000));
  }
  for (const [key, pose] of next.poses(true, undefined, 5, 1)) {
    assert.ok(pose.prog > (before.get(key)?.prog ?? 0) + 20, `${key} stalled after handover`);
  }
});
