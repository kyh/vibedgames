import assert from "node:assert/strict";
import { test } from "node:test";

import type { SenderClock } from "@vibedgames/multiplayer";

import { COURSE_SNAP_PX, courseStart, courseX, followCourse } from "../src/net/course.ts";
import { RIVAL_DELAY_MS, RIVAL_TELEPORT_PX, RivalMotion } from "../src/net/rival-motion.ts";
import type { DragonPose } from "../src/net/rival-motion.ts";
import { FLAP_VELOCITY, GRAVITY, MAX_TILT, PIPE_SPEED, tiltFor } from "../src/shared/constants.ts";

const FRAME = 1000 / 60;

/** Deterministic jitter in [0, 1) so the tests never flake. */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

// ---- shared scroll -----------------------------------------------------------------

test("a race carries the host's course on from where it stands, at PIPE_SPEED on the room's clock", () => {
  const now = 1_760_000_000_000;
  const start = courseStart(1234.5, now);
  assert.ok(Math.abs(courseX(start, now) - 1234.5) < 0.1, "no jump as the race begins");
  // Every screen reads the one start on the one clock: a second on, each is
  // PIPE_SPEED further — however its frames fell, whoever hosts by then.
  assert.ok(Math.abs(courseX(start, now + 1000) - (1234.5 + PIPE_SPEED)) < 0.1);
});

/** A flying guest's scroll, frame by frame, following the room's `start` from `x` at room time `from`. */
const ride = (start: number, x: number, from: number, frames: number): number[] => {
  const xs: number[] = [];
  let at = x;
  for (let f = 1; f <= frames; f += 1) {
    at = followCourse(at, courseX(start, from + f * FRAME), true);
    xs.push(at);
  }
  return xs;
};

test("back into a race the host held, a flying guest's pipes halt, never reverse, then ride the room's clock", () => {
  const before = courseStart(0, 10_000);
  const x = courseX(before, 20_000);
  // The host's course stood still for 2 s while we were away: the race it
  // starts again on seeing us is 300 px behind where we flew on to.
  const after = before + 2000;
  const xs = ride(after, x, 20_000, 180);
  let prev = x;
  let held = 0;
  for (const next of xs) {
    assert.ok(next >= prev, `ran backwards by ${prev - next}`);
    held += next === prev ? 1 : 0;
    prev = next;
  }
  assert.ok(Math.abs(held * FRAME - 2000) <= 2 * FRAME, `held ${held * FRAME} ms`);
  assert.equal(xs.at(-1), courseX(after, 20_000 + 180 * FRAME), "then exactly on the room's line");
});

test("a course a trunk spacing behind, any course ahead, and any while not flying are adopted at once", () => {
  assert.equal(followCourse(2000, 2000 - COURSE_SNAP_PX, true), 2000 - COURSE_SNAP_PX);
  assert.equal(followCourse(2000, 2300, true), 2300);
  assert.equal(followCourse(2000, 1700, false), 1700);
});

// ---- rival dragons ---------------------------------------------------------------

/** The room's server clock as one receiver measures it: local time + `offset`. */
const roomClock = (offset: number): SenderClock => ({
  now: (local = 0) => local + offset,
  synced: true,
});

const pose = (y: number, vy = 0, live = true): DragonPose => ({ live, vy, y });

/** Height (y down) `t` ms after a full flap from y = 300. */
const arc = (t: number): number => 300 + (FLAP_VELOCITY * t) / 1000 + (GRAVITY * t * t) / 2e6;

/** One rival sample: stamped `t` (server time), landing at our local time `at`. */
interface Arrival {
  at: number;
  t: number;
  p: DragonPose;
}

/** A rival's flap at server time 0, sampled at NET_TICK_HZ, landing `route(i)` ms after each stamp. */
const flapArrivals = (route: (i: number) => number): Arrival[] => {
  const arrivals: Arrival[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const t = i * 50;
    const vy = FLAP_VELOCITY + (GRAVITY * t) / 1000;
    arrivals.push({ at: t + route(i), p: pose(Math.round(arc(t)), Math.round(vy)), t });
  }
  return arrivals;
};

test("a rival's flap-and-dive renders as a smooth arc despite jittery arrivals", () => {
  // Server time = our clock − 5 s; our round trip 100 ms. A sample takes its
  // sender's hop up and ours down: 100–145 ms after its stamp.
  const offset = -5000;
  const motion = new RivalMotion(roomClock(offset), () => 100);
  const arrivals = flapArrivals((i) => -offset + 100 + noise(i) * 45);
  let next = 0;
  const ys: number[] = [];
  for (let now = -offset; now < -offset + 1100; now += FRAME) {
    while (next < arrivals.length && (arrivals[next]?.at ?? Infinity) <= now) {
      const arrival = arrivals[next];
      if (arrival) {
        motion.push(arrival.t, 0, arrival.p);
      }
      next += 1;
    }
    // Drawn from once the flap is under way on the render clock (a relay
    // plus 100 ms behind): rising, over the top, into the dive.
    if (now >= -offset + 400) {
      const drawn = motion.sample(now);
      assert.ok(drawn);
      ys.push(drawn.y);
    }
  }
  assert.ok((ys[0] ?? 0) < 300 && (ys.at(-1) ?? 0) > 300, "rose, then dived");
  // True per-frame motion changes by GRAVITY·frame² ≈ 0.5 px a frame (1.5 px
  // at a sample boundary); drawing the newest sample instead moves 0 px, then
  // 15–35 px at once.
  for (let i = 2; i < ys.length; i += 1) {
    const step = (ys[i] ?? 0) - (ys[i - 1] ?? 0);
    const before = (ys[i - 1] ?? 0) - (ys[i - 2] ?? 0);
    assert.ok(Math.abs(step - before) < 4, `frame ${i}: step ${step} after ${before}`);
  }
});

test("rivals flying in formation stay in formation, however different their routes", () => {
  // One flight streamed by two rivals; one route lands in 60 ms, the other
  // in 140. Per-sender clocks drew the slow one 80 ms behind; on the room's
  // clock both stamps mean the same moment.
  const clock = roomClock(-5000);
  const near = new RivalMotion(clock, () => 100);
  const far = new RivalMotion(clock, () => 100);
  const routes: [RivalMotion, Arrival[]][] = [
    [near, flapArrivals(() => 5000 + 60)],
    [far, flapArrivals(() => 5000 + 140)],
  ];
  for (let now = 5000; now < 6100; now += FRAME) {
    for (const [motion, arrivals] of routes) {
      for (const arrival of arrivals) {
        if (arrival.at <= now && arrival.at > now - FRAME) {
          motion.push(arrival.t, 0, arrival.p);
        }
      }
    }
    if (now >= 5000 + 400) {
      const a = near.sample(now);
      const b = far.sample(now);
      assert.ok(a && b);
      assert.equal(a.y, b.y, `at ${now}`);
    }
  }
});

test("a rival is drawn a round trip plus RIVAL_DELAY_MS behind the room's clock", () => {
  let rtt = Number.NaN;
  const motion = new RivalMotion(roomClock(-1000), () => rtt);
  for (const [t, y] of [
    [0, 100],
    [100, 200],
    [200, 300],
  ]) {
    motion.push(t, 0, pose(y));
  }
  // No round trip measured yet: drawn on the bare clock.
  assert.equal(motion.sample(1000 + RIVAL_DELAY_MS + 100)?.y, 200);
  rtt = 150;
  assert.equal(motion.sample(1000 + RIVAL_DELAY_MS + 150 + 50)?.y, 150);
});

test("a crash flies on into the wreck and greys out mid-blend, without skipping ahead", () => {
  const motion = new RivalMotion(roomClock(-1000), () => 0);
  const samples: [number, DragonPose][] = [
    [0, pose(100, 200)],
    [50, pose(110, 290)],
    [100, pose(120, 380)],
    [150, pose(124, 380, false)],
    [200, pose(124, 380, false)],
  ];
  for (const [t, p] of samples) {
    motion.push(t, 0, p);
  }
  // Drawn 100 ms behind a room clock 1 s behind ours.
  const early = motion.sample(1000 + 100 + 120);
  const late = motion.sample(1000 + 100 + 130);
  assert.ok(early && late);
  assert.equal(early.live, true);
  assert.equal(late.live, false);
  assert.ok(Math.abs(early.y - 121.6) < 1e-9, `early y ${early.y}`);
  assert.ok(Math.abs(late.y - 122.4) < 1e-9, `late y ${late.y}`);
});

test("a respawn or a jump no flight covers appears at once instead of gliding", () => {
  const motion = new RivalMotion(roomClock(-1000), () => 0);
  for (let i = 0; i <= 4; i += 1) {
    motion.push(i * 50, 0, pose(600, 0, false));
  }
  // Respawned into the hover: a new life, 400 px up.
  motion.push(250, 1, pose(200, 0, false));
  assert.equal(motion.sample(1250)?.y, 200, "appears at the respawn point");
  assert.equal(motion.sample(1290)?.y, 200, "and holds there, no glide back");

  // A flight step blends; a step past RIVAL_TELEPORT_PX in one tick does not.
  const flight = new RivalMotion(roomClock(-1000), () => 0);
  const dive = 240 + RIVAL_TELEPORT_PX + 10;
  for (const [t, y] of [
    [0, 200],
    [50, 240],
  ]) {
    flight.push(t, 0, pose(y));
  }
  const mid = flight.sample(1050 + 100 - 25)?.y ?? Number.NaN;
  assert.ok(mid > 200 && mid < 240, `blended ${mid}`);
  flight.push(100, 0, pose(dive));
  assert.equal(flight.sample(1100)?.y, dive);
});

test("rivals pitch from their interpolated speed, bounded like your own dragon", () => {
  assert.equal(tiltFor(FLAP_VELOCITY), -MAX_TILT);
  assert.equal(tiltFor(0), 0);
  assert.equal(tiltFor(10_000), MAX_TILT);
  assert.ok(tiltFor(300) > 0 && tiltFor(300) < MAX_TILT);
});
