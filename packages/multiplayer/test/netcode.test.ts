import assert from "node:assert/strict";
import { test } from "node:test";

import { FixedRate } from "../src/fixed-rate.js";
import { Interpolator, lerp, lerpAngle } from "../src/interpolation.js";
import { netStats } from "../src/net-stats.js";
import type { NetProbe } from "../src/net-stats.js";
import { Reconciler } from "../src/prediction.js";
import { RemoteClock } from "../src/remote-clock.js";
import { ServerClock } from "../src/server-clock.js";

interface Pose {
  x: number;
}

const lerpPose = (a: Pose, b: Pose, k: number) => ({ x: lerp(a.x, b.x, k) });

const noise = (i: number) => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;

  return s - Math.floor(s);
};

const sendTimes = (frameMs: number, hz: number, seconds: number) => {
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
  clock.observe(0, 10_090);
  clock.observe(50, 10_100);
  clock.observe(100, 10_140);
  assert.equal(clock.now(10_200), 160);
  clock.observe(150, 10_160);
  assert.equal(clock.now(10_300), 270);
  clock.reset();
  clock.observe(5000, 10_400);
  assert.equal(clock.now(10_400), 5000);
});

test("RemoteClock relearns a new route by easing onto it, not riding the old one", () => {
  const relearned = new RemoteClock();
  const stale = new RemoteClock();

  for (const clock of [relearned, stale]) {
    clock.observe(0, 10_040);
    clock.observe(50, 10_090);
    assert.equal(clock.now(10_100), 60);
  }

  relearned.relearn();

  for (const clock of [relearned, stale]) {
    clock.observe(100, 10_190);
  }

  assert.equal(relearned.now(10_200), 150);
  assert.equal(relearned.now(10_700), 610);
  assert.equal(stale.now(10_700), 660);
});

test("ServerClock reads the offset off the fastest probe and keeps it", () => {
  const clock = new ServerClock();
  assert.equal(clock.synced, false);
  assert.equal(clock.now(500), 500, "the local clock until a probe returns");
  clock.sample(1000, 50_000, 1100);
  assert.equal(clock.synced, true);
  assert.equal(clock.rtt, 100);
  assert.equal(clock.now(1200), 1200 + 48_950);
  clock.sample(2000, 51_400, 2400);
  assert.equal(clock.rtt, 100);
  assert.equal(clock.now(2500), 2500 + 48_950);
});

test("ServerClock settles once a full window of probes is in, after a stalled start", () => {
  const clock = new ServerClock();
  clock.sample(0, 100_040, 3000);
  assert.equal(clock.settled, false);
  assert.equal(clock.rtt, 3000);
  assert.equal(clock.now(3000) - 3000, 98_540);

  for (let i = 1; i < 8; i += 1) {
    clock.sample(3000 + i * 500, 103_040 + i * 500, 3080 + i * 500);
  }

  assert.equal(clock.settled, true);
  assert.equal(clock.rtt, 80);
  assert.equal(clock.now(10_000) - 10_000, 100_000);
});

test("ServerClock slews a small revision and adopts a large one at once", () => {
  const clock = new ServerClock();
  clock.sample(0, 10_100, 200);
  assert.equal(clock.now(1000) - 1000, 10_000);
  clock.sample(1000, 11_060, 1040);
  assert.equal(clock.now(1100) - 1100, 10_010, "10 ms after 100 ms");
  assert.equal(clock.now(1500) - 1500, 10_040, "then settled");
  clock.sample(2000, 13_000, 2000);
  assert.equal(clock.now(2100) - 2100, 11_000);
});

test("Interpolator on a shared clock renders without estimating per sender", () => {
  const clock = new ServerClock();
  clock.sample(0, 1_000_000, 0);
  const interp = new Interpolator<Pose>({ clock, delayMs: 100, lerp: lerpPose });

  for (const [stamp, x, arrival] of [
    [1_000_000, 0, 5],
    [1_000_050, 5, 400],
    [1_000_100, 10, 401],
  ] as const) {
    interp.push(stamp, { x }, arrival);
  }

  assert.equal(interp.sample(175)?.x, 7.5, "server time 1 000 075, drawn 100 ms behind");
});

test("Interpolator counts the frames it draws past the newest update, for __VG_NET__", () => {
  const clock = new ServerClock();
  clock.sample(0, 1_000_000, 0);

  const interp = new Interpolator<Pose>({
    clock,
    delayMs: 100,
    lerp: lerpPose,
    maxExtrapolateMs: 50,
  });

  const before = netStats();

  for (const [stamp, x] of [
    [1_000_000, 0],
    [1_000_100, 10],
  ] as const) {
    interp.push(stamp, { x }, 0);
  }

  for (const localNow of [150, 230, 300]) {
    interp.sample(localNow);
  }

  const after = netStats();
  assert.deepEqual(
    {
      frames: after.frames - before.frames,
      stalled: after.stalled - before.stalled,
      starved: after.starved - before.starved,
      updates: after.updates - before.updates,
    },
    { frames: 3, stalled: 1, starved: 2, updates: 2 },
  );

  const probe: NetProbe | undefined = Object.getOwnPropertyDescriptor(
    globalThis,
    "__VG_NET__",
  )?.value;

  assert.deepEqual(probe?.stats(), after, "the page global reads the same totals");
});

test("Interpolator renders jittery 20 Hz updates as steady motion", () => {
  const interp = new Interpolator<Pose>({ delayMs: 100, lerp: lerpPose });
  const speed = 0.2;
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
    assert.ok(Math.abs(step - expected) < expected * 0.15, `frame step ${step} vs ${expected}`);
  }
});

const stream = (hz: number, seconds: number, jitterMs: number) =>
  Array.from({ length: hz * seconds }, (_, i) => {
    const t = (i * 1000) / hz;

    return { at: t + 7000 + 60 + noise(i) * jitterMs, t };
  });

test("RemoteClock measures the delay a stream needs: its interval plus how late the next update lands", () => {
  const steady = new RemoteClock();

  for (const { at, t } of stream(20, 5, 0)) {
    steady.observe(t, at);
  }

  assert.equal(steady.hold(12_100), 0, "the first estimate eases in from nothing");
  assert.ok(Math.abs(steady.hold(14_100) - 50) < 1, "an even stream needs one interval");

  const jittery = new RemoteClock();

  for (const { at, t } of stream(20, 5, 80)) {
    jittery.observe(t, at);
  }

  jittery.hold(12_100);
  const hold = jittery.hold(14_100);
  assert.ok(hold > 110 && hold < 132, `hold ${hold}`);
});

test("RemoteClock eases a new stream's hold in from its reader's floor", () => {
  const clock = new RemoteClock();

  for (const { at, t } of stream(20, 5, 80)) {
    clock.observe(t, at);
  }

  assert.equal(clock.hold(12_100, 100), 100);
  const next = clock.hold(12_200, 100);
  assert.ok(next > 100 && next <= 110 + 1e-9, `hold ${next}`);
  assert.ok(clock.hold(14_100, 100) > 110, "and gets there");
  const steady = new RemoteClock();

  for (const { at, t } of stream(20, 5, 0)) {
    steady.observe(t, at);
  }

  assert.ok(Math.abs(steady.hold(12_100, 100) - 50) < 1, "an even stream needs one interval");
});

test("RemoteClock's hold ignores idle silences and other entities' copies of a stamp", () => {
  const clock = new RemoteClock();
  const arrivals = stream(20, 3, 0);

  for (const { at, t } of arrivals) {
    clock.observe(t, at);
    clock.observe(t, at + 2);
  }

  for (const { at, t } of stream(20, 1, 0)) {
    clock.observe(t + 5000, at + 5000);
  }

  clock.hold(12_000);
  assert.ok(Math.abs(clock.hold(13_000) - 50) < 1, `hold ${clock.hold(13_000)}`);

  clock.reset();
  assert.equal(clock.hold(13_100), 0, "a reset clock has measured nothing");
});

test("RemoteClock slews a changed hold instead of jumping render time", () => {
  const clock = new RemoteClock();

  for (const { at, t } of stream(20, 5, 0)) {
    clock.observe(t, at);
  }

  clock.hold(11_100);
  const before = clock.hold(12_100);
  assert.ok(Math.abs(before - 50) < 1, `settled at ${before}`);

  for (const { at, t } of stream(20, 5, 160)) {
    clock.observe(t + 5000, at + 5000);
  }

  const after = clock.hold(12_200);
  assert.ok(after - before <= 100 * 0.1 + 1e-9, `moved ${after - before} in 100 ms`);
  assert.ok(clock.hold(22_000) > 150, "and gets there");
});

test("Interpolator renders a jittery stream at the hold it needs, where a fixed delay runs dry", () => {
  const starvedShare = (interp: Interpolator<Pose>, arrivals: { at: number; t: number }[]) => {
    let next = 0;
    let newest = Number.NEGATIVE_INFINITY;
    let frames = 0;
    let starved = 0;

    for (let at = 7000 + 2000; at < 7000 + 9500; at += 1000 / 30) {
      while (next < arrivals.length && (arrivals[next]?.at ?? Infinity) <= at) {
        const arrival = arrivals[next];

        if (arrival) {
          interp.push(arrival.t, { x: arrival.t }, arrival.at);
          newest = Math.max(newest, arrival.t);
        }

        next += 1;
      }

      interp.sample(at);
      frames += 1;

      if (interp.renderTime(at) > newest) {
        starved += 1;
      }
    }

    return starved / frames;
  };

  const arrivals = stream(20, 10, 120);
  const adaptive = starvedShare(new Interpolator<Pose>({ lerp: lerpPose }), arrivals);
  const route = new RemoteClock();

  const fixed = starvedShare(
    new Interpolator<Pose>({
      clock: { now: (t) => route.now(t), observe: (a, b) => route.observe(a, b), synced: true },
      lerp: lerpPose,
    }),
    arrivals,
  );

  assert.ok(adaptive < 0.08, `adaptive starved ${adaptive}`);
  assert.ok(fixed > 0.3, `fixed starved ${fixed}`);
});

test("Interpolator eases a new stream into a hold above its delay instead of stepping back", () => {
  const interp = new Interpolator<Pose>({ lerp: lerpPose });
  const arrivals = stream(20, 6, 120);
  let next = 0;
  let previous = Number.NEGATIVE_INFINITY;
  let backward = 0;

  for (let at = 7000; at < 7000 + 6000; at += 1000 / 60) {
    while (next < arrivals.length && (arrivals[next]?.at ?? Infinity) <= at) {
      const arrival = arrivals[next];

      if (arrival) {
        interp.push(arrival.t, { x: arrival.t }, arrival.at);
      }

      next += 1;
    }

    if (next === 0) {
      continue;
    }

    const renderAt = interp.renderTime(at);

    if (renderAt < previous) {
      backward = Math.max(backward, previous - renderAt);
    }

    previous = renderAt;
  }

  const hold = interp.clock.hold?.(7000 + 6000) ?? 0;
  assert.ok(hold > 100, `the stream needs more than delayMs: ${hold}`);
  assert.equal(backward, 0, `render time stepped back ${backward} ms`);
});

test("Interpolator extrapolates a late update briefly, then holds", () => {
  const interp = new Interpolator<Pose>({ delayMs: 100, lerp: lerpPose, maxExtrapolateMs: 100 });

  for (const [t, x, at] of [
    [0, 0, 1000],
    [50, 10, 1050],
  ] as const) {
    interp.push(t, { x }, at);
  }

  assert.equal(interp.sample(1250)?.x, 30);
  assert.equal(interp.sample(2000)?.x, 30);
  assert.equal(interp.push(50, { x: 99 }, 2000), false, "duplicate stamp dropped");
  assert.equal(interp.latest?.x, 10);
});

test("Interpolator holds an idle entity instead of gliding across a send gap", () => {
  const interp = new Interpolator<Pose>({ delayMs: 100, lerp: lerpPose });

  for (let i = 0; i <= 4; i += 1) {
    interp.push(i * 50, { x: 0 }, 1000 + i * 50);
  }

  interp.push(5200, { x: 10 }, 6200);
  assert.equal(interp.sample(6100 + 100 - 2600)?.x, 0);
  const mid = interp.sample(1000 + 5175 + 100)?.x ?? Number.NaN;
  assert.ok(mid > 0 && mid < 10, `moving within the last interval (${mid})`);
});

test("Interpolator walks a slow steady sender evenly, not hold-then-dash", () => {
  const interp = new Interpolator<Pose>({ delayMs: 250, lerp: lerpPose, maxExtrapolateMs: 0 });
  const stride = 183;
  const arrivals: { t: number; at: number }[] = [];

  for (let i = 0; i < 40; i += 1) {
    arrivals.push({ at: i * stride + 3000 + 60 + noise(i) * 40, t: i * stride });
  }

  let next = 0;
  let prev: number | null = null;
  const steps: number[] = [];

  for (let at = 3000 + 1000; at < 3000 + 6500; at += 1000 / 60) {
    while (next < arrivals.length && (arrivals[next]?.at ?? Infinity) <= at) {
      const arrival = arrivals[next];

      if (arrival) {
        interp.push(arrival.t, { x: arrival.t / stride }, arrival.at);
      }

      next += 1;
    }

    const x = interp.sample(at)?.x ?? Number.NaN;

    if (prev !== null) {
      steps.push(x - prev);
    }

    prev = x;
  }

  const expected = 1000 / 60 / stride;

  for (const step of steps) {
    assert.ok(Math.abs(step - expected) < expected * 0.35, `frame step ${step} vs ${expected}`);
  }
});

test("lerpAngle takes the short way round", () => {
  const a = Math.PI - 0.1;
  const b = -Math.PI + 0.1;
  const mid = lerpAngle(a, b, 0.5);
  assert.ok(Math.abs(Math.abs(mid) - Math.PI) < 1e-9, `mid ${mid}`);
});

const run = (options: {
  reconciler: Reconciler;
  lagMs: number;
  frames: number;
  moveFrames?: number;
  hostOffset?: number;
  aligned?: boolean;
}) => {
  const frame = 1000 / 60;
  const speed = 0.006;
  const moveFrames = options.moveFrames ?? options.frames;
  const pathAt = (at: number) => Math.min(Math.max(0, at), moveFrames * frame) * speed;
  let x = 0;
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
  assert.ok(Math.abs(x - truth - 0.5) < 0.01, `converged to the offset (${x - truth})`);
});

test("Reconciler without timing still settles an along-track error once the body stops", () => {
  const reconciler = new Reconciler({ deadZone: 0.01, snapDistance: 2 });

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
