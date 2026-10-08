// Host and guest copies of one rally over a simulated link: a host stepping
// at 60 Hz, a guest at 144 Hz on a clock seconds apart, 60–105 ms one way with
// jitter. Exercises the same pure rules the scene runs (../src/shared/ball and
// ../src/shared/referee) — the timing, not the rendering.

import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedRate, RemoteClock } from "@vibedgames/multiplayer";

import {
  advanceFlight,
  copyFlight,
  hitsPaddle,
  reflectOffPaddle,
  stepFlight,
} from "../src/shared/ball.ts";
import type { Flight } from "../src/shared/ball.ts";
import {
  GOAL_Y,
  HIT_HALF_X,
  HIT_HALF_Y,
  HIT_STOP_PADDLE,
  NET_TICK_HZ,
  PADDLE_Y,
  VERDICT_HOLD_MAX_S,
  WALL_X,
} from "../src/shared/constants.ts";
import { contactShot } from "../src/shared/contact-shot.ts";
import {
  HOLD_Y,
  inOpenCourt,
  judgeClaim,
  parkAtBand,
  projectFlight,
  resumeFromContact,
} from "../src/shared/referee.ts";
import type { HitClaim, Hold } from "../src/shared/referee.ts";
import { SPIN_LIFE } from "../src/shared/spin.ts";

/** Deterministic jitter in [0, 1) so the tests never flake. */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

/** The guest's clock reads this much ahead of the host's (ms). */
const SKEW = 7000;
/** One-way latency of packet `i` (ms). */
const oneWay = (i: number): number => 60 + noise(i) * 45;
const HOST_FRAME = 1000 / 60;
const GUEST_FRAME = 1000 / 144;
const RALLY_SPEED = 9.9;

interface Sample {
  t: number;
  x: number;
  y: number;
}

/** A trail's position at time `t`, interpolated. */
const at = (trail: Sample[], t: number): Sample => {
  for (let i = 1; i < trail.length; i += 1) {
    const b = trail[i];
    const a = trail[i - 1];
    if (a && b && b.t >= t) {
      const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  throw new Error(`no sample at ${t}`);
};

interface Snapshot {
  ball: Flight;
  ep: number;
  held: number;
  t: number;
}
type Verdict = { kind: "hit"; claim: HitClaim } | { kind: "miss" };
interface Wire<T> {
  arrive: number;
  body: T;
}

/** Messages that have arrived by real time `now`, removed from the queue. */
const arrived = <T,>(queue: Wire<T>[], now: number): T[] => {
  const out: T[] = [];
  while (queue.length > 0 && (queue[0]?.arrive ?? Infinity) <= now) {
    const next = queue.shift();
    if (next) {
      out.push(next.body);
    }
  }
  return out;
};

/** The guest's paddle each frame, given its own copy of the ball. */
type Steer = (ball: Flight, paddle: number) => number;

interface GuestCopy {
  ball: Flight | null;
  clock: RemoteClock;
  ep: number;
  freeze: number;
  paddle: number;
  verdict: boolean;
}

interface RallyResult {
  accepted: boolean;
  acceptedAt: number | null;
  guestHitAt: number | null;
  guestTrail: Sample[];
  hostTrail: Sample[];
  hold: Hold | null;
  paddleWhenHostParked: number | null;
  correctionsAfterReturn: number[];
  scoredAt: number | null;
}

/**
 * One approach to slot B and its outcome. Host: parks at B's band, judges the
 * guest's verdict, replays or releases. Guest: adopts the first snapshot, runs
 * the ball itself, folds later snapshots in (open court only), and calls its
 * own paddle's contact the frame it happens.
 */
const rally = (start: Flight, steer: Steer, untilMs: number): RallyResult => {
  const toHost: Wire<Verdict>[] = [];
  const toGuest: Wire<Snapshot>[] = [];
  let packet = 0;
  const result: RallyResult = {
    accepted: false,
    acceptedAt: null,
    correctionsAfterReturn: [],
    guestHitAt: null,
    guestTrail: [],
    hold: null,
    hostTrail: [],
    paddleWhenHostParked: null,
    scoredAt: null,
  };

  const host = { ball: copyFlight(start), elapsed: 0, ep: 0, freeze: 0, missed: false };
  let hold: Hold | null = null;
  const sendRate = new FixedRate(NET_TICK_HZ);
  const guest: GuestCopy = {
    ball: null,
    clock: new RemoteClock(),
    ep: -1,
    freeze: 0,
    paddle: -3,
    verdict: false,
  };

  const release = (): void => {
    if (hold) {
      advanceFlight(host.ball, host.elapsed - hold.at);
    }
    hold = null;
    host.missed = true;
  };

  const hostHears = (verdict: Verdict): void => {
    if (verdict.kind === "miss") {
      release();
      return;
    }
    const { claim } = verdict;
    const when = hold === null ? null : judgeClaim(hold, claim);
    if (when === null) {
      release();
      return;
    }
    host.ball.pos.x = claim.x;
    host.ball.pos.y = claim.y;
    const shot = contactShot((claim.x - claim.paddle) / HIT_HALF_X, -1, RALLY_SPEED, false);
    const out = reflectOffPaddle(claim.x, claim.paddle, -1, shot.speed);
    host.ball.vel.x = out.x;
    host.ball.vel.y = out.y;
    host.ball.spin = shot.spin === 0 ? null : { left: SPIN_LIFE, strength: shot.spin };
    host.freeze = resumeFromContact(host.ball, host.elapsed - when);
    host.ep += 1;
    hold = null;
    result.accepted = true;
    result.acceptedAt = host.elapsed * 1000;
  };

  const hostFrame = (now: number, dt: number): void => {
    // Delivered between frames, at the previous frame's clock — as the scene's
    // event handler runs.
    for (const verdict of arrived(toHost, now)) {
      hostHears(verdict);
    }
    host.elapsed = now / 1000;
    if (host.freeze > 0) {
      host.freeze -= dt;
    } else if (hold === null) {
      stepFlight(host.ball, dt);
      const { pos, vel } = host.ball;
      if (vel.y > 0 && host.ep === 0 && !host.missed && pos.y >= HOLD_Y) {
        hold = parkAtBand(host.ball, host.elapsed);
        result.hold = hold;
        result.paddleWhenHostParked = guest.paddle;
      }
    } else if (host.elapsed - hold.at >= VERDICT_HOLD_MAX_S) {
      release();
    }
    if (result.scoredAt === null && host.ball.pos.y > GOAL_Y) {
      result.scoredAt = host.elapsed;
    }
    result.hostTrail.push({ t: now, x: host.ball.pos.x, y: host.ball.pos.y });
    if (sendRate.due(dt * 1000)) {
      const snap = { ball: copyFlight(host.ball), ep: host.ep, held: host.freeze, t: now };
      toGuest.push({ arrive: now + oneWay(packet), body: snap });
      packet += 1;
    }
  };

  /** The guest's own frame of the ball: hit-stop, flight, its paddle's verdict. */
  const guestStep = (ball: Flight, now: number, dt: number): void => {
    if (guest.freeze > 0) {
      guest.freeze -= dt;
    } else if (Math.abs(ball.pos.y) < GOAL_Y) {
      stepFlight(ball, dt);
      guest.paddle = steer(ball, guest.paddle);
      if (!guest.verdict && ball.vel.y > 0 && hitsPaddle(ball.pos, guest.paddle, PADDLE_Y)) {
        const claim = { paddle: guest.paddle, x: ball.pos.x, y: ball.pos.y };
        const shot = contactShot((claim.x - claim.paddle) / HIT_HALF_X, -1, RALLY_SPEED, false);
        const out = reflectOffPaddle(claim.x, claim.paddle, -1, shot.speed);
        ball.vel.x = out.x;
        ball.vel.y = out.y;
        ball.spin = shot.spin === 0 ? null : { left: SPIN_LIFE, strength: shot.spin };
        guest.freeze = HIT_STOP_PADDLE;
        guest.ep += 1;
        guest.verdict = true;
        result.guestHitAt = guest.clock.now(now + SKEW);
        toHost.push({ arrive: now + oneWay(packet), body: { claim, kind: "hit" } });
        packet += 1;
      } else if (!guest.verdict && ball.vel.y > 0 && ball.pos.y >= PADDLE_Y + HIT_HALF_Y) {
        guest.verdict = true;
        toHost.push({ arrive: now + oneWay(packet), body: { kind: "miss" } });
        packet += 1;
      }
    }
  };

  /** Fold a host snapshot into the guest's copy: adopt a newer epoch, correct in open court. */
  const guestFold = (snap: Snapshot, local: number): void => {
    if (snap.ep < guest.ep) {
      return;
    }
    const age = (guest.clock.now(local) - snap.t) / 1000;
    const projected = projectFlight(snap.ball, age, snap.held);
    if (guest.ball === null || snap.ep > guest.ep) {
      guest.ball = projected;
      guest.ep = snap.ep;
      return;
    }
    if (!inOpenCourt(guest.ball.pos.y) || !inOpenCourt(projected.pos.y)) {
      return;
    }
    if (guest.ep > 0) {
      const { pos } = guest.ball;
      result.correctionsAfterReturn.push(
        Math.hypot(projected.pos.x - pos.x, projected.pos.y - pos.y),
      );
    }
    guest.ball = projected;
  };

  const guestFrame = (now: number, dt: number): void => {
    const local = now + SKEW;
    // A frame sees only the newest snapshot, as the scene polls shared state.
    const snap = arrived(toGuest, now).at(-1);
    if (snap) {
      guest.clock.observe(snap.t, local);
    }
    if (guest.ball) {
      guestStep(guest.ball, now, dt);
    }
    if (snap) {
      guestFold(snap, local);
    }
    if (guest.ball) {
      const shown = guest.clock.now(local);
      result.guestTrail.push({ t: shown, x: guest.ball.pos.x, y: guest.ball.pos.y });
    }
  };

  let nextHost = 0;
  let nextGuest = 0;
  while (Math.min(nextHost, nextGuest) < untilMs) {
    if (nextHost <= nextGuest) {
      hostFrame(nextHost, nextHost === 0 ? 0 : HOST_FRAME / 1000);
      nextHost += HOST_FRAME;
    } else {
      guestFrame(nextGuest, nextGuest === 0 ? 0 : GUEST_FRAME / 1000);
      nextGuest += GUEST_FRAME;
    }
  }
  return result;
};

/** Heading to slot B at 7 u/s sideways — faster than a lagged host could ever credit. */
const sideways = (): Flight => ({ pos: { x: -2.5, y: 3 }, spin: null, vel: { x: 7, y: 7 } });

/** The paddle waits at the rail until the ball is inside the hit band, then
 *  jumps under it: a save that only exists on the guest's screen. */
const lateSave: Steer = (ball, paddle) => (ball.pos.y > 7.7 ? ball.pos.x - 0.2 : paddle);

/** The paddle never moves. */
const parked: Steer = (_ball, paddle) => paddle;

test("a guest's last-moment save on a fast sideways ball counts", () => {
  const run = rally(sideways(), lateSave, 2200);

  assert.ok(run.hold, "host parked the ball at slot B's band");
  // When the host's copy reached the band the guest had not even moved yet:
  // any contact test on the host side calls this a miss.
  assert.equal(run.paddleWhenHostParked, -3);
  assert.equal(hitsPaddle({ x: run.hold.flight.pos.x, y: PADDLE_Y }, -3, PADDLE_Y), false);
  assert.ok(run.accepted, "host replays the guest's return");
  assert.equal(run.scoredAt, null, "no point scored");
});

test("after a guest's return both copies of the ball share one timeline", (t) => {
  const run = rally(sideways(), lateSave, 2200);
  assert.ok(run.acceptedAt !== null && run.guestHitAt !== null);
  // The host learns of the return a round trip late, then catches its copy up
  // to now; from then on, sampled at the same host time, the two agree.
  let worst = 0;
  for (const sample of run.guestTrail) {
    if (sample.t > run.acceptedAt + 20 && sample.t < run.acceptedAt + 700) {
      const host = at(run.hostTrail, sample.t);
      worst = Math.max(worst, Math.hypot(host.x - sample.x, host.y - sample.y));
    }
  }
  t.diagnostic(`copies diverge by at most ${worst.toFixed(4)} after the return`);
  assert.ok(worst < 0.06, `copies diverge by ${worst.toFixed(3)} after the return`);
  // So the host's snapshots barely touch the guest's copy once they resume.
  assert.ok(run.correctionsAfterReturn.length > 5, "snapshots resumed correcting");
  const largest = Math.max(...run.correctionsAfterReturn);
  t.diagnostic(`largest correction after the return ${largest.toFixed(4)}`);
  assert.ok(largest < 0.06, `correction ${largest.toFixed(3)} after the return`);
});

test("a clear miss scores on the guest's word, no later than an unheld ball would", (t) => {
  const run = rally(sideways(), parked, 2200);
  assert.ok(run.hold && !run.accepted);
  // Where the ball crosses the goal line with nobody holding it.
  const free = sideways();
  let crossed = 0;
  for (let elapsed = 0; free.pos.y <= GOAL_Y; elapsed += HOST_FRAME / 1000) {
    stepFlight(free, HOST_FRAME / 1000);
    crossed = elapsed + HOST_FRAME / 1000;
  }
  assert.ok(run.scoredAt !== null, "host scored the point");
  t.diagnostic(
    `scored at ${run.scoredAt.toFixed(3)} s; unheld ball crosses at ${crossed.toFixed(3)} s`,
  );
  assert.ok(
    Math.abs(run.scoredAt - crossed) < 0.035,
    `scored at ${run.scoredAt.toFixed(3)} s, unheld ball crosses at ${crossed.toFixed(3)} s`,
  );
});

test("the host refuses claims that don't fit its own flight", () => {
  const ball = sideways();
  while (ball.pos.y < HOLD_Y) {
    stepFlight(ball, 1 / 60);
  }
  const hold = parkAtBand(ball, 1);
  const { x } = hold.flight.pos;
  const fits: HitClaim = { paddle: x + 0.3 + 0.1, x: x + 0.3, y: HOLD_Y + 0.3 };
  const when = judgeClaim(hold, fits);
  assert.ok(when !== null && Math.abs(when - (hold.at + 0.3 / 7)) < 1e-9, "timed by band depth");
  assert.ok(hold.at <= 1 && hold.at > 1 - 1 / 60, "park backdated to the crossing");
  assert.equal(judgeClaim(hold, { ...fits, paddle: x + 1.3, x: x + 1.3 }), null, "off the line");
  assert.equal(judgeClaim(hold, { ...fits, y: HOLD_Y - 0.5 }), null, "short of the band");
  assert.equal(judgeClaim(hold, { ...fits, y: PADDLE_Y + HIT_HALF_Y + 0.3 }), null, "past it");
  assert.equal(
    judgeClaim(hold, { ...fits, paddle: fits.x - HIT_HALF_X - 0.05 }),
    null,
    "paddle away",
  );
  assert.equal(judgeClaim(hold, { ...fits, paddle: 4.6, x: 4.2 }), null, "paddle off the court");
});

test("a claim on a ball that banks inside the band still fits", () => {
  // Steep enough to meet the side wall between entering B's band and the contact.
  const ball: Flight = { pos: { x: 4.4, y: HOLD_Y - 0.05 }, spin: null, vel: { x: 6, y: 3 } };
  stepFlight(ball, 1 / 60);
  const hold = parkAtBand(ball, 0);
  const path = copyFlight(hold.flight);
  advanceFlight(path, 0.6 / 3);
  assert.ok(path.vel.x < 0, "banked before the contact");
  assert.ok(Math.abs(path.pos.x) <= WALL_X);
  const claim = { paddle: path.pos.x, x: path.pos.x, y: hold.flight.pos.y + 0.6 };
  assert.ok(judgeClaim(hold, claim) !== null);
});

test("a host's return caught up on the guest matches the host's own ball", () => {
  const contact: Flight = { pos: { x: 1, y: -7.6 }, spin: null, vel: { x: 2, y: 9 } };
  // Host: the ball holds through the hit-stop, then flies.
  const host = copyFlight(contact);
  advanceFlight(host, 0.2 - HIT_STOP_PADDLE);
  for (const since of [0.02, 0.08]) {
    const guest = copyFlight(contact);
    const owed = resumeFromContact(guest, since);
    assert.equal(owed, Math.max(0, HIT_STOP_PADDLE - since));
    advanceFlight(guest, 0.2 - since - owed);
    assert.ok(
      Math.abs(guest.pos.x - host.pos.x) < 1e-9 && Math.abs(guest.pos.y - host.pos.y) < 1e-9,
    );
  }
});

test("timestamped snapshots hold a guest's copy on one steady timeline", (t) => {
  // A slice across open court with a bank: no paddle decides anything here.
  const start: Flight = {
    pos: { x: 0, y: -6 },
    spin: { left: SPIN_LIFE, strength: 0.8 },
    vel: { x: 6, y: 9 },
  };
  const hostTrail: Sample[] = [];
  const queue: Wire<Snapshot>[] = [];
  const hostBall = copyFlight(start);
  const sendRate = new FixedRate(NET_TICK_HZ);
  const clock = new RemoteClock();
  // The new guest projects each snapshot to the host time it is showing; the
  // old one adopted each as it landed and dead-reckoned until the next.
  let projectedBall: Flight | null = null;
  let landedBall: Flight | null = null;
  let packet = 0;
  let worstProjected = 0;
  let worstLanded = 0;
  let nextHost = 0;
  let nextGuest = 0;
  while (nextHost < 1300 || nextGuest < 1300) {
    if (nextHost <= nextGuest) {
      if (nextHost > 0) {
        stepFlight(hostBall, HOST_FRAME / 1000);
      }
      hostTrail.push({ t: nextHost, x: hostBall.pos.x, y: hostBall.pos.y });
      if (sendRate.due(nextHost === 0 ? 0 : HOST_FRAME)) {
        queue.push({
          arrive: nextHost + oneWay(packet),
          body: { ball: copyFlight(hostBall), ep: 0, held: 0, t: nextHost },
        });
        packet += 1;
      }
      nextHost += HOST_FRAME;
      continue;
    }
    const local = nextGuest + SKEW;
    for (const ball of [projectedBall, landedBall]) {
      if (ball) {
        stepFlight(ball, GUEST_FRAME / 1000);
      }
    }
    const snap = arrived(queue, nextGuest).at(-1);
    if (snap) {
      clock.observe(snap.t, local);
      landedBall = copyFlight(snap.ball);
      const projected = projectFlight(snap.ball, (clock.now(local) - snap.t) / 1000, 0);
      if (
        projectedBall === null ||
        (inOpenCourt(projectedBall.pos.y) && inOpenCourt(projected.pos.y))
      ) {
        projectedBall = projected;
      }
    }
    // Once the clock has seen a few packets, measure both against the host's
    // flight on the steady timeline the guest shows: a constant lag reads as
    // smooth motion, a lag that changes with every packet as stutter.
    const shown = clock.now(local);
    if (projectedBall && landedBall && nextGuest > 400 && shown < 1250) {
      const truth = at(hostTrail, shown);
      const off = (ball: Flight): number => Math.hypot(truth.x - ball.pos.x, truth.y - ball.pos.y);
      worstProjected = Math.max(worstProjected, off(projectedBall));
      worstLanded = Math.max(worstLanded, off(landedBall));
    }
    nextGuest += GUEST_FRAME;
  }
  t.diagnostic(
    `off the steady timeline: projected ${worstProjected.toFixed(4)}, as landed ${worstLanded.toFixed(3)}`,
  );
  assert.ok(worstProjected < 0.05, `projected copy wanders ${worstProjected.toFixed(3)}`);
  assert.ok(
    worstLanded > 0.3,
    `adopting snapshots as they land wanders only ${worstLanded.toFixed(3)}`,
  );
});
