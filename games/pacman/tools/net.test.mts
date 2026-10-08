import assert from "node:assert/strict";
import { test } from "node:test";

import { PELLET_KEYS, decodeEaten, encodeEaten } from "../src/net/board-codec";
import { PacTrack, lerpPose, readPacSample } from "../src/net/pac-track";
import type { PacSample } from "../src/net/pac-track";

/** Deterministic jitter in [0, 1), so the tests never flake. */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

const FRAME_MS = 1000 / 60;
/** The receiver's clock runs this far ahead of the sender's; the one-way trip adds 60–100 ms. */
const SKEW_MS = 50_000;
const arrival = (t: number, i = 0): number => t + SKEW_MS + 60 + noise(i) * 40;

/** A rival walking along a row at pac speed (5 cells/s), reporting every 50 ms. */
const walk = (count: number, from: { x: number; z: number; t: number }): PacSample[] =>
  Array.from({ length: count }, (_, i) => ({
    spawn: 1,
    t: from.t + i * 50,
    x: from.x + i * 0.25,
    z: from.z,
  }));

test("the board codec round-trips any eaten set in one short string", () => {
  const empty = encodeEaten(new Set());
  assert.equal(empty.length, Math.ceil(PELLET_KEYS.length / 6));
  assert.ok(empty.length <= 64, `${empty.length} characters`);
  assert.deepEqual(decodeEaten(empty), []);
  assert.deepEqual(decodeEaten(encodeEaten(new Set(PELLET_KEYS))), PELLET_KEYS);
  for (let seed = 1; seed <= 40; seed += 1) {
    const eaten = new Set(PELLET_KEYS.filter((_, i) => noise(seed * 1000 + i) < seed / 41));
    assert.deepEqual(new Set(decodeEaten(encodeEaten(eaten))), eaten, `seed ${seed}`);
  }
});

test("the board codec ignores keys and characters that are not pellet cells", () => {
  // (0,0) is a wall, (1,1) a pellet.
  assert.deepEqual(decodeEaten(encodeEaten(new Set(["0,0", "nope", "1,1"]))), ["1,1"]);
  assert.deepEqual(decodeEaten("!*~ "), []);
  // Characters past the pellet list carry no cells.
  assert.deepEqual(decodeEaten(`${encodeEaten(new Set())}____`), []);
});

test("only a player in the round with a position is a rival", () => {
  assert.equal(readPacSample({}), null);
  assert.equal(readPacSample({ active: false, score: 40, t: 5, x: 1, z: 1 }), null);
  assert.equal(readPacSample({ score: 40, t: 5, x: 1, z: 1 }), null, "no flag: not in the round");
  assert.equal(readPacSample({ active: true, t: 5 }), null, "no position yet");
  assert.equal(readPacSample({ active: true, t: "5", x: 1, z: 1 }), null);
  assert.deepEqual(readPacSample({ active: true, t: 5, x: 2, z: 3 }), {
    spawn: 0,
    t: 5,
    x: 2,
    z: 3,
  });
  assert.deepEqual(readPacSample({ active: true, score: 30, spawn: 4, t: 5, x: 2, z: 3 }), {
    spawn: 4,
    t: 5,
    x: 2,
    z: 3,
  });
});

test("a rival walking the maze renders as steady motion from jittery 20 Hz reports", () => {
  const track = new PacTrack();
  const reports = walk(80, { t: 10_000, x: 1, z: 1 });
  let next = 0;
  let prev: number | null = null;
  const expected = 5 * (FRAME_MS / 1000);
  // Past the first few reports, which only fill the buffer.
  const settled = arrival(10_000) + 300;
  const end = arrival(10_000 + 79 * 50) - 300;
  for (let at = arrival(10_000); at < end; at += FRAME_MS) {
    while (next < reports.length && arrival(reports[next]?.t ?? Infinity, next) <= at) {
      next += 1;
    }
    // As the game does: each frame feeds the newest report that has arrived
    // (reports bunched into one frame collapse to the last; a repeat is ignored).
    const newest = reports[next - 1];
    if (newest) {
      track.push(newest, at);
    }
    const pose = track.sample(at);
    assert.ok(pose);
    assert.equal(pose.z, 1);
    if (prev !== null && at >= settled) {
      const step = pose.x - prev;
      // Within 15% of the true per-frame motion: no surges, stalls or reversals.
      assert.ok(Math.abs(step - expected) < expected * 0.15, `frame step ${step} vs ${expected}`);
    }
    prev = pose.x;
  }
});

test("a respawn snaps the pac home instead of gliding it back through the walls", () => {
  const track = new PacTrack();
  // Caught a step from home: too close for the jump rule, so the spawn bump must do it.
  const reports = walk(3, { t: 10_000, x: 1.5, z: 1 });
  for (const report of reports) {
    track.push(report, arrival(report.t));
  }
  const home = { spawn: 2, t: 10_000 + 3 * 50, x: 1, z: 1 };
  track.push(home, arrival(home.t));
  assert.deepEqual(track.sample(arrival(home.t)), { x: 1, z: 1 });
  // Later reports from home blend from home, never from the old corridor.
  const after = { ...home, t: home.t + 50, x: 1.25 };
  track.push(after, arrival(after.t));
  const pose = track.sample(arrival(after.t) + 25);
  assert.ok(pose && pose.x >= 1 && pose.x <= 1.25 && pose.z === 1, JSON.stringify(pose));
});

test("a jump past the neighbouring cell snaps; a step into it blends", () => {
  const jumped = new PacTrack();
  for (const report of walk(6, { t: 10_000, x: 7, z: 1 })) {
    jumped.push(report, arrival(report.t));
  }
  // Same spawn, five cells away: a teleport, not motion.
  const far = { spawn: 1, t: 10_300, x: 3, z: 5 };
  jumped.push(far, arrival(far.t));
  assert.deepEqual(jumped.sample(arrival(far.t)), { x: 3, z: 5 });

  const stepped = new PacTrack();
  for (let i = 0; i < 5; i += 1) {
    const still = { spawn: 1, t: 10_000 + i * 50, x: 3, z: 1 };
    stepped.push(still, arrival(still.t));
  }
  // Bunched behind a stall, the next report already reaches the next cell.
  const late = { spawn: 1, t: 10_300, x: 3.75, z: 1 };
  stepped.push(late, arrival(late.t));
  // 100 ms behind the sender's clock: halfway between t 10 200 (x 3) and 10 300.
  const mid = stepped.sample(arrival(10_250) + 100)?.x ?? Number.NaN;
  assert.ok(mid > 3 && mid < 3.75, `blends across the step (${mid})`);
});

test("a late report carries the pac on to the next cell centre and no further", () => {
  assert.deepEqual(lerpPose({ x: 2.5, z: 1 }, { x: 2.75, z: 1 }, 0.5), { x: 2.625, z: 1 });
  // Plain extrapolation would reach 3.25 — past the centre it stops on.
  assert.deepEqual(lerpPose({ x: 2.5, z: 1 }, { x: 2.75, z: 1 }, 3), { x: 3, z: 1 });
  assert.deepEqual(lerpPose({ x: 4, z: 6.5 }, { x: 4, z: 6.25 }, 3), { x: 4, z: 6 });
  // Already on a centre: nothing to carry on to.
  assert.deepEqual(lerpPose({ x: 2.75, z: 1 }, { x: 3, z: 1 }, 2), { x: 3, z: 1 });

  const track = new PacTrack();
  for (const report of walk(4, { t: 10_000, x: 2, z: 1 })) {
    track.push(report, arrival(report.t));
  }
  // The newest report (x 2.75) is overdue by far more than the extrapolation window.
  assert.deepEqual(track.sample(arrival(10_150) + 1000), { x: 3, z: 1 });
});
