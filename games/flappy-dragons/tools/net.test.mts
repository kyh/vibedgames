import assert from "node:assert/strict";
import { test } from "node:test";

import { COURSE_SNAP_PX, courseStart, courseX, followCourse } from "../src/net/course.ts";
import { RIVAL_TELEPORT_PX, RivalMotion } from "../src/net/rival-motion.ts";
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

/** Server time (ms since the epoch) at a test's t = 0: rivals stamp with it, and it shares no epoch with our clock. */
const T0 = 1_760_000_000_000;

const pose = (y: number, vy = 0, live = true): DragonPose => ({ live, vy, y });

/** Height (y down) `t` ms after a full flap from y = 300. */
const arc = (t: number): number => 300 + (FLAP_VELOCITY * t) / 1000 + (GRAVITY * t * t) / 2e6;

/** A steady climb, 1 px per this many ms: the height drawn reads back the moment drawn at. */
const CLIMB_MS_PER_PX = 10;

test("a rival's flap-and-dive renders as a smooth arc over a long, jittery relay", () => {
  const motion = new RivalMotion();
  // A flap at server time T0. Each sample lands 150–195 ms after its stamp
  // (the sender's hop up and ours down), by our clock: past the moment a
  // fixed 100 ms behind the server clock would draw.
  const arrivals: { at: number; t: number }[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const t = i * 50;
    arrivals.push({ at: 5000 + t + 150 + noise(i) * 45, t });
  }
  let next = 0;
  const ys: number[] = [];
  for (let now = 5000; now < 6200; now += FRAME) {
    while (next < arrivals.length && (arrivals[next]?.at ?? Infinity) <= now) {
      const arrival = arrivals[next];
      if (arrival) {
        const vy = FLAP_VELOCITY + (GRAVITY * arrival.t) / 1000;
        motion.push(T0 + arrival.t, 0, pose(Math.round(arc(arrival.t)), Math.round(vy)), now);
      }
      next += 1;
    }
    // Drawn from once the flap is under way on the render clock (~100 ms
    // behind the fastest arrival): rising, over the top, into the dive.
    if (now >= 5500) {
      const drawn = motion.sample(now);
      assert.ok(drawn);
      ys.push(drawn.y);
    }
  }
  assert.ok((ys[0] ?? 0) < 300 && (ys.at(-1) ?? 0) > 300, "rose, then dived");
  // True per-frame motion changes by GRAVITY·frame² ≈ 0.5 px a frame (1.5 px
  // at a sample boundary); drawing the newest sample instead moves 0 px, then
  // 15–35 px at once, and running dry past it holds, then jumps.
  for (let i = 2; i < ys.length; i += 1) {
    const step = (ys[i] ?? 0) - (ys[i - 1] ?? 0);
    const before = (ys[i - 1] ?? 0) - (ys[i - 2] ?? 0);
    assert.ok(Math.abs(step - before) < 4, `frame ${i}: step ${step} after ${before}`);
  }
});

test("a crash flies on into the wreck and greys out mid-blend, without skipping ahead", () => {
  const motion = new RivalMotion();
  const samples: [number, DragonPose][] = [
    [0, pose(100, 200)],
    [50, pose(110, 290)],
    [100, pose(120, 380)],
    [150, pose(124, 380, false)],
    [200, pose(124, 380, false)],
  ];
  for (const [t, p] of samples) {
    motion.push(T0 + t, 0, p, t + 1000);
  }
  // Every sample landed 1 s after its stamp by our clock; drawn 100 ms behind that.
  const early = motion.sample(1000 + 100 + 120);
  const late = motion.sample(1000 + 100 + 130);
  assert.ok(early && late);
  assert.equal(early.live, true);
  assert.equal(late.live, false);
  assert.ok(Math.abs(early.y - 121.6) < 1e-9, `early y ${early.y}`);
  assert.ok(Math.abs(late.y - 122.4) < 1e-9, `late y ${late.y}`);
});

test("a respawn or a jump no flight covers appears at once instead of gliding", () => {
  const motion = new RivalMotion();
  for (let i = 0; i <= 4; i += 1) {
    motion.push(T0 + i * 50, 0, pose(600, 0, false), i * 50 + 1000);
  }
  // Respawned into the hover: a new life, 400 px up.
  motion.push(T0 + 250, 1, pose(200, 0, false), 1250);
  assert.equal(motion.sample(1250)?.y, 200, "appears at the respawn point");
  assert.equal(motion.sample(1290)?.y, 200, "and holds there, no glide back");

  // A flight step blends; a step past RIVAL_TELEPORT_PX in one tick does not.
  const flight = new RivalMotion();
  const dive = 240 + RIVAL_TELEPORT_PX + 10;
  for (const [t, y] of [
    [0, 200],
    [50, 240],
  ]) {
    flight.push(T0 + t, 0, pose(y), t + 1000);
  }
  const mid = flight.sample(1050 + 100 - 25)?.y ?? Number.NaN;
  assert.ok(mid > 200 && mid < 240, `blended ${mid}`);
  flight.push(T0 + 100, 0, pose(dive), 1100);
  assert.equal(flight.sample(1100)?.y, dive);
});

test("back from a drop by a slower route, a rival is drawn as far behind as before", () => {
  // A rival on a steady climb. Our connection drops for half a second and
  // comes back by a route 80 ms slower (a phone off wifi). Timed by the old
  // route's faster trips, the dragon ran dry for a second, trailed half as
  // far for the next two and a half, then 50 ms too far from there on.
  const motion = new RivalMotion();
  const DROP = 6000;
  const BACK = 6500;
  const END = 13_000;
  const arrivals: { at: number; t: number }[] = [];
  let last = 0;
  for (let t = 0; t < END; t += 50) {
    const at = Math.max(last, t + (t < DROP ? 30 : 110) + noise(t) * 20);
    // What was in flight when the socket closed is lost with it.
    if (at < DROP || (t >= DROP && at >= BACK)) {
      arrivals.push({ at, t });
      last = at;
    }
  }
  let next = 0;
  let newest = Number.NaN;
  let relearned = false;
  /** Per frame: how far behind the newest sample in hand the dragon is drawn (ms). */
  const trail: { at: number; ms: number }[] = [];
  for (let now = 0; now < END; now += FRAME) {
    if (now >= BACK && !relearned) {
      // GameScene, as the room readmits us.
      motion.relearn();
      relearned = true;
    }
    // Polled once a frame: of what landed since the last, the newest.
    let landed: { at: number; t: number } | undefined;
    while (next < arrivals.length && (arrivals[next]?.at ?? Infinity) <= now) {
      landed = arrivals[next];
      next += 1;
    }
    if (landed) {
      motion.push(T0 + landed.t, 0, pose(landed.t / CLIMB_MS_PER_PX), now);
      newest = landed.t;
    }
    const drawn = motion.sample(now);
    if (drawn) {
      trail.push({ at: now, ms: newest - drawn.y * CLIMB_MS_PER_PX });
    }
  }
  const mean = (from: number, to: number): number => {
    const span = trail.filter((f) => f.at >= from && f.at < to);
    return span.reduce((sum, f) => sum + f.ms, 0) / span.length;
  };
  const before = mean(DROP - 1500, DROP);
  assert.ok(before > 50, `trails the fast route by ${before} ms`);
  // From half a second after the return, every half second keeps the delay.
  for (let from = BACK + 500; from < END; from += 500) {
    const after = mean(from, from + 500);
    assert.ok(
      Math.abs(after - before) < 15,
      `${(from - BACK) / 1000} s back: trails by ${after} ms, ${before} before the drop`,
    );
    const dry = trail.filter((f) => f.at >= from && f.at < from + 500 && f.ms < 0).length;
    assert.equal(dry, 0, `${(from - BACK) / 1000} s back: ${dry} frames drawn past the newest`);
  }
});

test("rivals pitch from their interpolated speed, bounded like your own dragon", () => {
  assert.equal(tiltFor(FLAP_VELOCITY), -MAX_TILT);
  assert.equal(tiltFor(0), 0);
  assert.equal(tiltFor(10_000), MAX_TILT);
  assert.ok(tiltFor(300) > 0 && tiltFor(300) < MAX_TILT);
});
