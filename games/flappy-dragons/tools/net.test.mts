import assert from "node:assert/strict";
import { test } from "node:test";

import { RIVAL_TELEPORT_PX, RivalMotion } from "../src/net/rival-motion.ts";
import type { DragonPose } from "../src/net/rival-motion.ts";
import { WORLD_SNAP_PX, WorldFollower } from "../src/net/world-follower.ts";
import { FLAP_VELOCITY, GRAVITY, MAX_TILT, PIPE_SPEED, tiltFor } from "../src/shared/constants.ts";

const FRAME = 1000 / 60;

/** Deterministic jitter in [0, 1) so the tests never flake. */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

// ---- shared scroll -----------------------------------------------------------------

interface Host {
  /** Host clock = local clock + skew. */
  skew: number;
  /** Host scroll at host time `t`. */
  x: (t: number) => number;
}

interface Run {
  /** Guest scroll after each frame. */
  xs: number[];
  /** The host's scroll at each frame's local time. */
  truth: number[];
  snaps: number;
}

/**
 * Drive a guest for `seconds` of 60 Hz frames against `host`, which reports at
 * 4 Hz over a 40–90 ms one-way route; reports are seen on the frame after
 * they land, as the scene polls them.
 */
const follow = (options: {
  follower: WorldFollower;
  host: Host;
  from: number;
  seconds: number;
  start: number;
  flying: boolean;
}): Run => {
  const { follower, host, from } = options;
  const reports: { at: number; t: number; x: number }[] = [];
  for (let k = 0; k * 250 <= options.seconds * 1000 + 250; k += 1) {
    const local = from - 250 + k * 250;
    const t = local + host.skew;
    reports.push({ at: local + 40 + noise(k) * 50, t, x: Math.round(host.x(t)) });
  }
  let next = 0;
  let x = options.start;
  const run: Run = { snaps: 0, truth: [], xs: [] };
  for (let now = from + FRAME; now <= from + options.seconds * 1000; now += FRAME) {
    while (next < reports.length && (reports[next]?.at ?? Infinity) <= now) {
      const report = reports[next];
      if (report) {
        follower.observe(report.t, report.x, now);
      }
      next += 1;
    }
    x = follower.advance(x, FRAME, now, options.flying);
    run.snaps += follower.snapped ? 1 : 0;
    run.xs.push(x);
    run.truth.push(host.x(now + host.skew));
  }
  return run;
};

const steadyHost = (skew: number, x0: number): Host => ({
  skew,
  x: (t) => x0 + (PIPE_SPEED * (t - (10_000 + skew))) / 1000,
});

test("a guest's scroll never runs backwards while it folds in a host that lost time", () => {
  const follower = new WorldFollower();
  const synced = follow({
    flying: true,
    follower,
    from: 10_000,
    host: steadyHost(-7000, 2000),
    seconds: 2,
    start: 0,
  });
  assert.equal(synced.snaps, 1, "only the first report snaps");
  // Then the host's scroll falls 300 px behind its pace (a stalled host on an
  // older build), while the guest is still scrolling where the old pace was.
  const lagging = steadyHost(-7000, 2000 - 300);
  const run = follow({
    flying: true,
    follower,
    from: 12_000,
    host: lagging,
    seconds: 14,
    start: synced.xs.at(-1) ?? 0,
  });
  assert.equal(run.snaps, 0, "300 px is drift, not a snap");
  let prev = synced.xs.at(-1) ?? 0;
  for (const x of run.xs) {
    const step = x - prev;
    // Pipes may slow by the fold cap (40 px/s) but never stop or reverse.
    assert.ok(step >= ((PIPE_SPEED - 40) * FRAME) / 1000 - 1e-9, `frame step ${step}`);
    assert.ok(step <= ((PIPE_SPEED + 40) * FRAME) / 1000 + 1e-9, `frame step ${step}`);
    prev = x;
  }
  // Settled on the host's line, behind it by about the route's fastest trip.
  const error = (run.xs.at(-1) ?? 0) - (run.truth.at(-1) ?? 0);
  assert.ok(error < 0 && error > -20, `settled error ${error}`);
});

test("a guest adopts the first report and gross errors at once, and a reseed outright", () => {
  const follower = new WorldFollower();
  assert.equal(follower.advance(100, FRAME, 1000, true), 100 + (PIPE_SPEED * FRAME) / 1000);
  assert.equal(follower.snapped, false, "dead-reckons until the host reports");
  follower.observe(50_000, 5000, 1000);
  assert.equal(follower.advance(100, FRAME, 1000, true), 5000);
  assert.equal(follower.snapped, true, "the first report lands at once");
  // A report a trunk spacing and more behind is a different course position.
  follower.observe(50_250, 5000, 1250);
  const x = follower.advance(5000 + 0.15 * 250 + WORLD_SNAP_PX + 50, FRAME, 1250, true);
  assert.equal(follower.snapped, true);
  assert.ok(Math.abs(x - 5000) < 1, `adopted ${x}`);
  // A reseed: even a small error is taken at once — the course is new.
  follower.resync();
  follower.observe(50_500, 0, 1500);
  assert.equal(follower.advance(30, FRAME, 1500, true), 0);
  assert.equal(follower.snapped, true);
});

test("a new host dead-reckons through the handover, then folds in without a snap", () => {
  const follower = new WorldFollower();
  const before = follow({
    flying: true,
    follower,
    from: 10_000,
    host: steadyHost(-7000, 3000),
    seconds: 2,
    start: 0,
  });
  follower.reset();
  let x = before.xs.at(-1) ?? 0;
  for (let i = 0; i < 20; i += 1) {
    const next = follower.advance(x, FRAME, 12_000 + i * FRAME, true);
    assert.ok(Math.abs(next - x - (PIPE_SPEED * FRAME) / 1000) < 1e-9, "pure dead reckoning");
    x = next;
  }
  // The new host's clock is ~50 s away from the old one's; its scroll is the
  // one it tracked as a guest, a few px off.
  const run = follow({
    flying: true,
    follower,
    from: 12_000 + 20 * FRAME,
    host: steadyHost(43_000, 3000 + 12),
    seconds: 6,
    start: x,
  });
  assert.equal(run.snaps, 0, "a handover is not a snap");
  const error = (run.xs.at(-1) ?? 0) - (run.truth.at(-1) ?? 0);
  assert.ok(Math.abs(error) < 20, `settled error ${error}`);
});

test("not flying, a lagging course hurries and a leading one halts — never reverses", () => {
  for (const offset of [300, -300]) {
    const follower = new WorldFollower();
    const synced = follow({
      flying: false,
      follower,
      from: 10_000,
      host: steadyHost(-7000, 2000),
      seconds: 1,
      start: 0,
    });
    const run = follow({
      flying: false,
      follower,
      from: 11_000,
      host: steadyHost(-7000, 2000 + offset),
      seconds: 3,
      start: synced.xs.at(-1) ?? 0,
    });
    assert.equal(run.snaps, 0);
    let prev = synced.xs.at(-1) ?? 0;
    for (const x of run.xs) {
      assert.ok(x - prev >= -1e-9, `ran backwards by ${prev - x}`);
      prev = x;
    }
    // Three seconds is far less than 300 px at the flying cap would take.
    const error = (run.xs.at(-1) ?? 0) - (run.truth.at(-1) ?? 0);
    assert.ok(Math.abs(error) < 20, `offset ${offset}: settled error ${error}`);
  }
});

// ---- rival dragons ---------------------------------------------------------------

const pose = (y: number, vy = 0, live = true): DragonPose => ({ live, vy, y });

/** Height (y down) `t` ms after a full flap from y = 300. */
const arc = (t: number): number => 300 + (FLAP_VELOCITY * t) / 1000 + (GRAVITY * t * t) / 2e6;

test("a rival's flap-and-dive renders as a smooth arc despite jittery arrivals", () => {
  const motion = new RivalMotion();
  // Sender clock = receiver clock − 5 s; one-way 60–105 ms. A flap at t = 0.
  const skew = 5000;
  const arrivals: { at: number; t: number }[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const t = i * 50;
    arrivals.push({ at: t + skew + 60 + noise(i) * 45, t });
  }
  let next = 0;
  const ys: number[] = [];
  for (let now = skew; now < skew + 1100; now += FRAME) {
    while (next < arrivals.length && (arrivals[next]?.at ?? Infinity) <= now) {
      const arrival = arrivals[next];
      if (arrival) {
        const vy = FLAP_VELOCITY + (GRAVITY * arrival.t) / 1000;
        motion.push(arrival.t, 0, pose(Math.round(arc(arrival.t)), Math.round(vy)), now);
      }
      next += 1;
    }
    // Drawn from once the flap is under way on the render clock (~100 ms
    // behind, plus the route): rising, over the top, into the dive.
    if (now >= skew + 400) {
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
    motion.push(t, 0, p, t + 1000);
  }
  // Drawn 100 ms behind a sender clock 1 s behind ours.
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
    motion.push(i * 50, 0, pose(600, 0, false), i * 50 + 1000);
  }
  // Respawned into the hover: a new life, 400 px up.
  motion.push(250, 1, pose(200, 0, false), 1250);
  assert.equal(motion.sample(1250)?.y, 200, "appears at the respawn point");
  assert.equal(motion.sample(1290)?.y, 200, "and holds there, no glide back");

  // A flight step blends; a step past RIVAL_TELEPORT_PX in one tick does not.
  const flight = new RivalMotion();
  const dive = 240 + RIVAL_TELEPORT_PX + 10;
  for (const [t, y] of [
    [0, 200],
    [50, 240],
  ]) {
    flight.push(t, 0, pose(y), t + 1000);
  }
  const mid = flight.sample(1050 + 100 - 25)?.y ?? Number.NaN;
  assert.ok(mid > 200 && mid < 240, `blended ${mid}`);
  flight.push(100, 0, pose(dive), 1100);
  assert.equal(flight.sample(1100)?.y, dive);
});

test("rivals pitch from their interpolated speed, bounded like your own dragon", () => {
  assert.equal(tiltFor(FLAP_VELOCITY), -MAX_TILT);
  assert.equal(tiltFor(0), 0);
  assert.equal(tiltFor(10_000), MAX_TILT);
  assert.ok(tiltFor(300) > 0 && tiltFor(300) < MAX_TILT);
});
