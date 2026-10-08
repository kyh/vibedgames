import assert from "node:assert/strict";
import { test } from "node:test";

import { FixedRate } from "../src/fixed-rate.js";
import { Interpolator, lerp, lerpAngle } from "../src/interpolation.js";
import { Reconciler } from "../src/prediction.js";
import { RemoteClock } from "../src/remote-clock.js";

interface Pose {
  x: number;
}

const lerpPose = (a: Pose, b: Pose, k: number): Pose => ({ x: lerp(a.x, b.x, k) });

/** Deterministic jitter in [0, 1) so the tests never flake. */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

const sendTimes = (frameMs: number, hz: number, seconds: number): number[] => {
  const rate = new FixedRate(hz);
  const fired: number[] = [];
  for (let t = frameMs; t <= seconds * 1000; t += frameMs) {
    if (rate.due(frameMs)) {
      fired.push(t);
    }
  }
  return fired;
};

test("FixedRate holds its rate on any display instead of drifting down", () => {
  for (const fps of [30, 60, 75, 120, 144]) {
    const fired = sendTimes(1000 / fps, 20, 10);
    assert.ok(Math.abs(fired.length - 200) <= 1, `${fps} fps fired ${fired.length}/200`);
  }
  // 20 Hz at 60 fps is exactly every third frame — not alternating 4 and 5.
  const fired = sendTimes(1000 / 60, 20, 2);
  for (let i = 1; i < fired.length; i += 1) {
    const gap = (fired[i] ?? 0) - (fired[i - 1] ?? 0);
    assert.ok(Math.abs(gap - 50) < 0.01, `gap ${gap}`);
  }
});

test("FixedRate fires once after a stall rather than bursting the backlog", () => {
  const rate = new FixedRate(20);
  assert.equal(rate.due(5000), true);
  assert.equal(rate.due(0), false, "no backlog burst");
  let fired = 0;
  for (let i = 0; i < 60; i += 1) {
    fired += rate.due(1000 / 60) ? 1 : 0;
  }
  assert.ok(fired === 19 || fired === 20, `resumes at rate (${fired})`);
});

test("RemoteClock estimates the offset from the fastest arrival and slews revisions", () => {
  const clock = new RemoteClock();
  // Sender clock runs 10 s behind ours; one-way latency 40–90 ms.
  clock.observe(0, 10_090);
  clock.observe(50, 10_100);
  clock.observe(100, 10_140);
  // Best offset seen: 10 040 (the 40 ms packet).
  assert.equal(clock.now(10_200), 160);
  // A faster packet revises the estimate by 30 ms; 100 ms later only 10% of
  // that elapsed time (10 ms) has been absorbed — playback sped up, not jumped.
  clock.observe(150, 10_160);
  assert.equal(clock.now(10_300), 270);
  // A new sender (host migration) is seconds off: adopted at once.
  clock.reset();
  clock.observe(5000, 10_400);
  assert.equal(clock.now(10_400), 5000);
});

test("Interpolator renders jittery 20 Hz updates as steady motion", () => {
  const interp = new Interpolator<Pose>({ delayMs: 100, lerp: lerpPose });
  // Units per ms on the sender's clock.
  const speed = 0.2;
  // Receiver clock = sender clock + skew + latency.
  const skew = 7000;
  const arrivals: { t: number; at: number }[] = [];
  for (let i = 0; i < 80; i += 1) {
    const t = i * 50;
    arrivals.push({ at: t + skew + 60 + noise(i) * 45, t });
  }
  let next = 0;
  let prev: number | null = null;
  const steps: number[] = [];
  for (let at = skew + 500; at < skew + 3900; at += 1000 / 60) {
    while (next < arrivals.length && (arrivals[next]?.at ?? Infinity) <= at) {
      const arrival = arrivals[next];
      if (arrival) {
        interp.push(arrival.t, { x: arrival.t * speed }, arrival.at);
      }
      next += 1;
    }
    const pose = interp.sample(at);
    assert.ok(pose);
    if (prev !== null) {
      steps.push(pose.x - prev);
    }
    prev = pose.x;
  }
  const expected = speed * (1000 / 60);
  for (const step of steps) {
    // Within 15% of true per-frame motion: no surges, stalls or reversals.
    assert.ok(Math.abs(step - expected) < expected * 0.15, `frame step ${step} vs ${expected}`);
  }
});

test("Interpolator extrapolates a late update briefly, then holds", () => {
  const interp = new Interpolator<Pose>({ delayMs: 100, lerp: lerpPose, maxExtrapolateMs: 100 });
  for (const [t, x, at] of [
    [0, 0, 1000],
    [50, 10, 1050],
  ] as const) {
    interp.push(t, { x }, at);
  }
  // Render time = local − 1000 − 100. At local 1250 it is 150: 100 past the newest.
  assert.equal(interp.sample(1250)?.x, 30);
  // Far past: capped at 100 ms of extrapolation.
  assert.equal(interp.sample(2000)?.x, 30);
  assert.equal(interp.push(50, { x: 99 }, 2000), false, "duplicate stamp dropped");
  assert.equal(interp.latest?.x, 10);
});

test("Interpolator holds an idle entity instead of gliding across a send gap", () => {
  const interp = new Interpolator<Pose>({ delayMs: 100, lerp: lerpPose });
  for (let i = 0; i <= 4; i += 1) {
    interp.push(i * 50, { x: 0 }, 1000 + i * 50);
  }
  // Sender went quiet for 5 s while still, then moved 10 units in one interval.
  interp.push(5200, { x: 10 }, 6200);
  // Halfway through the gap in render time it must still be at rest.
  assert.equal(interp.sample(6100 + 100 - 2600)?.x, 0);
  // One interval before the new stamp it starts moving.
  const mid = interp.sample(1000 + 5175 + 100)?.x ?? Number.NaN;
  assert.ok(mid > 0 && mid < 10, `moving within the last interval (${mid})`);
});

test("lerpAngle takes the short way round", () => {
  const a = Math.PI - 0.1;
  const b = -Math.PI + 0.1;
  const mid = lerpAngle(a, b, 0.5);
  assert.ok(Math.abs(Math.abs(mid) - Math.PI) < 1e-9, `mid ${mid}`);
});

/**
 * Drive a predicted body at constant speed for `moveFrames`, then stand still.
 * The host reports where the body was `lagMs` ago, plus `hostOffset` of real
 * divergence; `aligned` passes the matching local time to `reconcile`.
 */
interface RunResult {
  x: number;
  truth: number;
}

const run = (options: {
  reconciler: Reconciler;
  lagMs: number;
  frames: number;
  moveFrames?: number;
  hostOffset?: number;
  aligned?: boolean;
}): RunResult => {
  const frame = 1000 / 60;
  const speed = 0.006;
  const moveFrames = options.moveFrames ?? options.frames;
  const pathAt = (at: number): number => Math.min(Math.max(0, at), moveFrames * frame) * speed;
  let x = 0;
  // The body stood at spawn before it moved; games step() every frame, idle too.
  options.reconciler.step(x, 0, frame, 0);
  for (let i = 1; i <= options.frames; i += 1) {
    const at = i * frame;
    if (i <= moveFrames) {
      x += speed * frame;
    }
    if (i % 3 === 0) {
      const hostAt = at - options.lagMs;
      const hostX = pathAt(hostAt) + (options.hostOffset ?? 0);
      options.reconciler.reconcile(hostX, 0, options.aligned ? hostAt : undefined);
    }
    const fix = options.reconciler.step(x, 0, frame, at);
    x += fix.x;
  }
  return { truth: pathAt(options.frames * frame), x };
};

test("Reconciler leaves a body alone while the host lags along the same path", () => {
  const reconciler = new Reconciler({ deadZone: 0.01, snapDistance: 2 });
  const { x, truth } = run({ frames: 180, lagMs: 150, reconciler });
  assert.ok(Math.abs(x - truth) < 1e-6, `no phantom correction (${x - truth})`);
});

test("Reconciler leaves a body alone in time-aligned mode too", () => {
  const reconciler = new Reconciler({ deadZone: 0.01, snapDistance: 2 });
  const { x, truth } = run({ aligned: true, frames: 180, lagMs: 150, reconciler });
  assert.ok(Math.abs(x - truth) < 1e-6, `no phantom correction (${x - truth})`);
});

test("Reconciler eases out a real divergence exactly once", () => {
  const reconciler = new Reconciler({ deadZone: 0.01, snapDistance: 2 });
  const { x, truth } = run({ aligned: true, frames: 180, hostOffset: 0.5, lagMs: 150, reconciler });
  // The host says the body is 0.5 ahead; after converging it is 0.5 ahead —
  // not 1.0, which is what re-measuring against an unshifted history yields.
  assert.ok(Math.abs(x - truth - 0.5) < 0.01, `converged to the offset (${x - truth})`);
});

test("Reconciler without timing still settles an along-track error once the body stops", () => {
  const reconciler = new Reconciler({ deadZone: 0.01, snapDistance: 2 });
  // Moving, a host copy 0.5 ahead along the path is indistinguishable from
  // latency; standing still for longer than the history it is not.
  const { x, truth } = run({
    frames: 240,
    hostOffset: 0.5,
    lagMs: 150,
    moveFrames: 60,
    reconciler,
  });
  assert.ok(Math.abs(x - truth - 0.5) < 0.01, `settled after stopping (${x - truth})`);
});

test("Reconciler snaps a large error in one frame and forgets on clear", () => {
  const reconciler = new Reconciler({ deadZone: 0.01, snapDistance: 1 });
  reconciler.step(0, 0, 16, 0);
  reconciler.reconcile(5, 0);
  assert.deepEqual(reconciler.step(0, 0, 16, 16), { x: 5, y: 0 });
  reconciler.clear();
  reconciler.reconcile(9, 9);
  assert.deepEqual(reconciler.step(0, 0, 16, 32), { x: 0, y: 0 }, "nothing recorded yet");
});
