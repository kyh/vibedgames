import {
  FixedRate,
  Interpolator,
  RemoteClock,
  ServerClock,
  TIME_PROBE_INTERVAL_MS,
} from "@vibedgames/multiplayer";

import { MAX_LAG, MAX_STEPS, TILE } from "../src/config.ts";
import { HEROES } from "../src/data/heroes.ts";
import { ENEMIES } from "../src/data/enemies.ts";
import { onEnemyHead, PlayerBody } from "../src/entities/player-body.ts";
import type { BodyInput } from "../src/entities/player-body.ts";
import { GuestCopy } from "../src/net/guest-copy.ts";
import { INTERP_MS, lerpPlayer } from "../src/net/interp.ts";
import { Prediction, STEP_MS } from "../src/net/predict.ts";
import { decodeEdge, decodePlayer, encodePlayer } from "../src/net/snapshot.ts";
import type { NetAck, NetInputs, NetPlayerRow, PlayerPose } from "../src/net/snapshot.ts";
import { Grid, ROWS } from "../src/sys/grid.ts";

const FLOOR_Y = (ROWS - 2) * TILE;
const { warrior } = ENEMIES;
const LAG_MS = MAX_LAG * 1000;
const EPOCH = 1_790_000_000_000;
const HOST_ORIGIN = 4321.5;
const GUEST_ORIGIN = 987.25;
const PROBE_BURST = [0, 100, 250, 500];
const SETTLE_MS = 1000;
const COPY_SETTLE_MS = 2000;

let pass = 0;
let fail = 0;

const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
};

const NEUTRAL: BodyInput = {
  attackPressed: false,
  dashPressed: false,
  down: false,
  jumpHeld: false,
  jumpPressed: false,
  left: false,
  right: false,
  specialPressed: false,
  up: false,
};

const rng = (seed: number) => {
  let s = seed;

  return () => {
    s = (s * 48_271) % 2_147_483_647;

    return s / 2_147_483_647;
  };
};

const link = <T,>(oneWay: number, jitter: number, seed: number) => {
  const roll = rng(seed);
  const queue: { at: number; msg: T }[] = [];
  let last = 0;

  const arrivals = (now: number) => {
    const out: { at: number; msg: T }[] = [];

    while (queue.length > 0 && (queue[0]?.at ?? Infinity) <= now) {
      const head = queue.shift();

      if (head) {
        out.push(head);
      }
    }

    return out;
  };

  return {
    arrivals,
    send: (now: number, msg: T) => {
      last = Math.max(last, now + oneWay + (roll() * 2 - 1) * jitter);
      queue.push({ at: last, msg });
    },
  };
};

const serverClock = (origin: number, oneWay: number, jitter: number, seed: number) => {
  const clock = new ServerClock();
  const up = link<number>(oneWay / 2, jitter / 2, seed);
  const down = link<{ c: number; s: number }>(oneWay / 2, jitter / 2, seed + 1);
  const due = [...PROBE_BURST];
  const local = (now: number) => now + origin;

  return {
    clock,
    local,
    poll: (now: number) => {
      while ((due[0] ?? Infinity) <= now) {
        const at = due.shift() ?? now;
        up.send(at, local(at));

        if (due.length === 0) {
          due.push(Math.max(at, PROBE_BURST.at(-1) ?? 0) + TIME_PROBE_INTERVAL_MS);
        }
      }

      for (const probe of up.arrivals(now)) {
        down.send(probe.at, { c: probe.msg, s: EPOCH + probe.at });
      }

      for (const answer of down.arrivals(now)) {
        clock.sample(answer.msg.c, answer.msg.s, local(answer.at));
      }
    },
  };
};

const guestLocal = (now: number) => now + GUEST_ORIGIN;

interface Snap {
  t: number;
  x: number;
  y: number;
  ack: NetAck;
  frozen: boolean;
  own: NetPlayerRow;
}

interface Scenario {
  name: string;
  oneWay: number;
  jitter: number;
  seconds: number;
  guestHz: number;
  hostHz?: number;
  hitch?: [from: number, to: number];
  frameJitter?: number;
  spawnX: number;
  spawnY: number;
  input: (t: number) => Partial<BodyInput>;
  hitstop?: (t: number) => boolean;
  host?: (t: number, copy: PlayerBody) => void;
  freeze?: [from: number, to: number];
  head?: { x: number; y: number };
}

interface Outcome {
  claims: number;
  corrections: number;
  correctionPx: number;
  pullBack: number;
  maxFix: number;
  replays: number;
  maxJump: number;
  endError: number;
  drawn: number;
  dry: number;
  drawError: number;
  relay: number;
  copySteps: number;
  copyIdle: number;
  copyBunched: number;
}

const tenth = (v: number) => Math.round(v * 10) / 10;

const pace = (t: number) => (Math.floor(t / 0.6) % 2 === 0 ? { right: true } : { left: true });

const run = (sc: Scenario) => {
  const grid = Grid.test();
  const { kit } = HEROES.axion;
  const hostBody = new PlayerBody(grid, sc.spawnX, sc.spawnY, kit);
  const guestBody = new PlayerBody(grid, sc.spawnX, sc.spawnY, kit);
  const copy = new GuestCopy();
  const prediction = new Prediction();
  const up = link<NetInputs>(sc.oneWay, sc.jitter, 7);
  const down = link<Snap>(sc.oneWay, sc.jitter, 11);
  const snapRate = new FixedRate(30);

  const out: Outcome = {
    claims: 0,
    copyBunched: 0,
    copyIdle: 0,
    copySteps: 0,
    correctionPx: 0,
    corrections: 0,
    drawError: 0,
    drawn: 0,
    dry: 0,
    endError: 0,
    maxFix: 0,
    maxJump: 0,
    pullBack: 0,
    relay: 0,
    replays: 0,
  };

  const host = { acc: 0, freeze: 0, stamp: -1, step: 0 };
  const guest = { acc: 0, frozen: false, tickAt: 0 };
  const hostTime = serverClock(HOST_ORIGIN, sc.oneWay, sc.jitter, 21);
  const guestTime = serverClock(GUEST_ORIGIN, sc.oneWay, sc.jitter, 31);
  const own = new PlayerBody(grid, 12 * TILE, FLOOR_Y, kit);
  const ownPath: { at: number; x: number }[] = [];
  const relay = new RemoteClock();

  const puppet = new Interpolator<PlayerPose>({
    clock: relay,
    delayMs: INTERP_MS,
    lerp: lerpPlayer,
  });

  let newest = -Infinity;

  const holding = (t: number) => sc.freeze !== undefined && t >= sc.freeze[0] && t < sc.freeze[1];

  const hostStep = (now: number, endsAt: number) => {
    host.step += 1;
    const t = host.step / 60;
    const before = copy.ack;
    copy.step(hostBody, holding(t), endsAt);

    if (now >= COPY_SETTLE_MS) {
      const applied = copy.ack - before;
      out.copySteps += 1;
      out.copyIdle += applied === 0 ? 1 : 0;
      out.copyBunched += applied > 1 ? 1 : 0;
    }

    while (copy.takeStomp()) {
      out.claims += 1;
    }

    if (host.freeze > 0) {
      host.freeze -= STEP_MS;
    } else {
      own.buffer(holding(t) ? NEUTRAL : { ...NEUTRAL, ...pace(t) });
      own.step(STEP_MS / 1000);
      sc.host?.(t, hostBody);

      if (sc.hitstop?.(t)) {
        host.freeze = 70;
      }
    }

    copy.drain(hostBody);
  };

  const hostFrame = (now: number, frameMs: number) => {
    hostTime.poll(now);

    for (const { at, msg } of up.arrivals(now)) {
      copy.receive(msg, 1, hostTime.local(at));
    }

    host.acc = Math.min(host.acc + frameMs, LAG_MS);

    for (let n = 0; host.acc >= STEP_MS && n < MAX_STEPS; n += 1) {
      host.acc -= STEP_MS;
      hostStep(now, hostTime.local(now) - host.acc);
    }

    ownPath.push({ at: now, x: own.x });

    if (snapRate.due(frameMs)) {
      host.stamp = Math.max(host.stamp + 1, Math.round(hostTime.clock.now(hostTime.local(now))));
      down.send(now, {
        ack: copy.report(1),
        frozen: holding(host.step / 60),
        own: encodePlayer(own),
        t: host.stamp,
        x: hostBody.x,
        y: hostBody.y,
      });
    }
  };

  const ownAt = (at: number) => {
    for (let i = ownPath.length - 1; i > 0; i -= 1) {
      const b = ownPath[i];
      const a = ownPath[i - 1];

      if (a && b && a.at <= at && at <= b.at) {
        return a.x + ((b.x - a.x) * (at - a.at)) / (b.at - a.at);
      }
    }

    return null;
  };

  const receiveSnap = (snap: Snap, at: number) => {
    const receivedAt = guestLocal(at);
    relay.observe(snap.t, receivedAt);
    puppet.push(snap.t, decodePlayer(snap.own), receivedAt);
    newest = Math.max(newest, snap.t);
  };

  const drawOwn = (now: number) => {
    const local = guestLocal(now);
    const pose = puppet.sample(local);

    if (!relay.synced || !pose || now < SETTLE_MS) {
      return;
    }

    const renderAt = puppet.renderTime(local);
    const truth = ownAt(renderAt - EPOCH);

    if (truth === null) {
      return;
    }

    out.drawn += 1;
    out.dry += renderAt >= newest ? 1 : 0;
    out.drawError = Math.max(out.drawError, Math.abs(pose.x - truth));
    out.relay = EPOCH + now - relay.now(local);
  };

  const applySnap = (snap: Snap) => {
    const edges = snap.ack.edges.flatMap((e) => {
      const decoded = decodeEdge(e);

      return decoded ? [decoded] : [];
    });

    const jump = prediction.replay(guestBody, edges);

    if (jump) {
      out.replays += 1;
      out.maxJump = Math.max(out.maxJump, Math.hypot(jump.dx, jump.dy));
    }

    prediction.reconcile(tenth(snap.x), tenth(snap.y), snap.ack.ack, snap.ack.age);
    guest.frozen = snap.frozen;
  };

  const guestStep = () => {
    const { vx, vy } = guestBody;
    prediction.step(guestBody, (body) => {
      const { head } = sc;

      return (
        head !== undefined && body.vy > 20 && onEnemyHead(body.x, body.y, head.x, head.y, warrior)
      );
    });
    const { x, y } = prediction.correction;
    const size = Math.hypot(x, y);

    if (size <= 0.01) {
      return;
    }

    out.corrections += 1;
    out.correctionPx += size;
    out.maxFix = Math.max(out.maxFix, size);
    const speed = Math.hypot(vx, vy);

    if (speed > 1) {
      out.pullBack += Math.max(0, -(x * vx + y * vy) / speed);
    }
  };

  const guestFrame = (now: number, frameMs: number) => {
    guestTime.poll(now);

    for (const { at, msg } of down.arrivals(now)) {
      receiveSnap(msg, at);
      applySnap(msg);
    }

    prediction.sample({ ...NEUTRAL, ...sc.input(now / 1000) }, guest.frozen);
    guest.acc = Math.min(guest.acc + frameMs, LAG_MS);

    for (let n = 0; guest.acc >= STEP_MS && n < MAX_STEPS; n += 1) {
      guest.acc -= STEP_MS;
      guestStep();
      guest.tickAt = guestTime.local(now) - guest.acc;
    }

    const msg = prediction.flush(1, Math.floor(guestTime.clock.now(guest.tickAt)));

    if (msg) {
      up.send(now, msg);
    }

    drawOwn(now);
  };

  const guestFrameMs = 1000 / sc.guestHz;
  const hostFrameMs = 1000 / (sc.hostHz ?? 60);
  const wobble = rng(41);
  const late = () => (wobble() * 2 - 1) * (sc.frameJitter ?? 0);
  const end = sc.seconds * 1000;
  let nextHost = 0;
  let nextGuest = 0;
  let lastHost = -hostFrameMs;
  let lastGuest = -guestFrameMs;

  while (nextHost <= end || nextGuest <= end) {
    if (nextHost <= nextGuest) {
      hostFrame(nextHost, nextHost - lastHost);
      lastHost = nextHost;
      nextHost = Math.max(
        lastHost + 1,
        (Math.round(lastHost / hostFrameMs) + 1) * hostFrameMs + late(),
      );
    } else {
      guestFrame(nextGuest, nextGuest - lastGuest);
      lastGuest = nextGuest;
      nextGuest = Math.max(
        lastGuest + 1,
        (Math.round(lastGuest / guestFrameMs) + 1) * guestFrameMs + late(),
      );

      if (sc.hitch && nextGuest >= sc.hitch[0] * 1000 && nextGuest < sc.hitch[1] * 1000) {
        nextGuest = sc.hitch[1] * 1000;
      }
    }
  }

  out.endError = Math.hypot(guestBody.x - hostBody.x, guestBody.y - hostBody.y);

  return out;
};

const share = (part: number, whole: number) => `${((100 * part) / Math.max(1, whole)).toFixed(1)}%`;

const fmt = (o: Outcome) =>
  `${o.corrections} corrections, ${o.correctionPx.toFixed(1)} px (pull-back ${o.pullBack.toFixed(1)} px, max ${o.maxFix.toFixed(2)}), ` +
  `${o.replays} replays (max jump ${o.maxJump.toFixed(1)} px), end error ${o.endError.toFixed(3)} px; ` +
  `host's hero drawn ${o.drawn} frames, ${o.dry} dry, max off ${o.drawError.toFixed(2)} px (relay ${o.relay.toFixed(0)} ms); ` +
  `copy steps ${share(o.copyIdle, o.copySteps)} idle, ${share(o.copyBunched, o.copySteps)} bunched`;

console.log("lunerfall netcode harness\n");

const off = (t: number) => (t < 0.9 ? { right: true } : {});

const runRight = (t: number) => (t < 2.6 ? { right: true } : {});
const floor = { spawnX: 3 * TILE, spawnY: FLOOR_Y };

const hopBackAndForth = (t: number) => {
  const f = Math.floor(t * 60);

  return t > 3
    ? {}
    : {
        jumpHeld: f % 50 < 12,
        jumpPressed: f % 50 === 0,
        left: f % 200 > 110,
        right: f % 200 <= 110,
      };
};

{
  const o = run({
    ...floor,
    guestHz: 60,
    hitstop: (t) => t > 0.3 && t < 2.6 && Math.round(t * 60) % 18 === 0,
    input: runRight,
    jitter: 20,
    name: "hitstop",
    oneWay: 60,
    seconds: 4,
  });

  console.log(`  hit-stop every 300 ms while running: ${fmt(o)}`);
  check("hit-stop on the host never pulls the guest back", o.pullBack < 0.5 && o.corrections === 0);
  check("…and the guest ends where the host's copy is", o.endError < 0.05);
  check(
    "the guest draws the host's hero on server time, never running dry",
    o.drawn > 0 && o.dry === 0,
  );
  check("…and where the host had it, hit-stops included", o.drawError < 2.5);
}

for (const oneWay of [60, 120]) {
  let hit = false;

  const o = run({
    ...floor,
    guestHz: 60,
    host: (t, body) => {
      if (!hit && t > 1) {
        hit = body.applyHurt(-1);
      }
    },
    input: runRight,
    jitter: 20,
    name: "hit",
    oneWay,
    seconds: 4,
  });

  console.log(`  hit while running, ${oneWay} ms one-way: ${fmt(o)}`);
  check(
    `a hit replays once and nothing drags afterwards (${oneWay} ms)`,
    o.replays === 1 && o.pullBack < 0.5,
  );
  check(`…and the guest ends where the host's copy is (${oneWay} ms)`, o.endError < 0.05);

  if (oneWay > INTERP_MS) {
    check(`a ${oneWay} ms relay never runs the guest's view dry`, o.drawn > 0 && o.dry === 0);
  }
}

{
  const probe = new PlayerBody(Grid.test(), 8 * TILE, 10 * TILE, HEROES.axion.kit);

  for (let f = 0; f < 120 && !(probe.vy > 60 && probe.y > 10 * TILE + 12); f += 1) {
    probe.buffer({ ...NEUTRAL, ...off(f / 60) });
    probe.step(STEP_MS / 1000);
  }

  const o = run({
    guestHz: 60,
    head: { x: probe.x, y: probe.y + warrior.h + 4 },
    input: off,
    jitter: 20,
    name: "claimed stomp",
    oneWay: 60,
    seconds: 4,
    spawnX: 8 * TILE,
    spawnY: 10 * TILE,
  });

  console.log(`  co-op stomp judged by the guest: ${fmt(o)}`);
  check("a guest's own stomp bounces at once, and on the host's copy", o.claims === 1);
  check("…with nothing to replay or correct", o.replays === 0 && o.corrections === 0);
  check("…and the guest ends where the host's copy is", o.endError < 0.05);
}

{
  let bounced = false;

  const o = run({
    guestHz: 60,
    host: (_t, body) => {
      if (!bounced && body.vy > 120) {
        body.bounce();
        bounced = true;
      }
    },
    input: off,
    jitter: 20,
    name: "stomp",
    oneWay: 60,
    seconds: 4,
    spawnX: 8 * TILE,
    spawnY: 10 * TILE,
  });

  console.log(`  stomp bounce judged by the host: ${fmt(o)}`);
  check(
    "a stomp bounce replays once and nothing drags afterwards",
    o.replays === 1 && o.pullBack < 0.5,
  );
  check("…and the guest ends where the host's copy is", o.endError < 0.05);
}

{
  const o = run({
    ...floor,
    guestHz: 144,
    input: (t) => {
      const f = Math.floor(t * 144);

      if (t > 3) {
        return {};
      }

      return {
        attackPressed: f % 53 === 7,
        dashPressed: f % 97 === 31,
        jumpHeld: f % 70 < 20,
        jumpPressed: f % 70 === 0,
        left: f % 300 > 160,
        right: f % 300 <= 160,
        specialPressed: f % 211 === 100,
      };
    },
    jitter: 25,
    name: "jitter",
    oneWay: 60,
    seconds: 4,
  });

  console.log(`  busy hands at 144 Hz, ±25 ms jitter: ${fmt(o)}`);
  check("jitter and high refresh alone never correct the guest", o.corrections === 0);
  check("…and the guest ends where the host's copy is", o.endError < 0.05);
}

{
  const o = run({
    ...floor,
    frameJitter: 8,
    guestHz: 30,
    hostHz: 30,
    input: (t) => {
      if (t > 7) {
        return {};
      }

      return Math.floor(t / 0.7) % 2 === 0 ? { right: true } : { left: true };
    },
    jitter: 40,
    name: "net-check lag",
    oneWay: 200,
    seconds: 8.5,
  });

  console.log(`  net-check lag, both tabs at 30 fps: ${fmt(o)}`);
  check(
    "the host's copy moves the guest a tick a step under net-check lag",
    o.copyIdle < 0.03 * o.copySteps && o.copyBunched < 0.03 * o.copySteps,
  );
  check("…never corrects the guest", o.corrections === 0);
  check("…and the guest ends where the host's copy is", o.endError < 0.05);
}

{
  const slow = run({
    ...floor,
    guestHz: 60,
    hostHz: 8,
    input: hopBackAndForth,
    jitter: 20,
    name: "slow host",
    oneWay: 60,
    seconds: 6,
  });

  console.log(`  host at 8 fps under a 60 fps guest: ${fmt(slow)}`);
  check("a host slower than real time never corrects the guest", slow.corrections === 0);
  check("…and its copy catches up to the guest", slow.endError < 0.05);

  const hitch = run({
    ...floor,
    guestHz: 60,
    hitch: [1.2, 1.55],
    input: hopBackAndForth,
    jitter: 20,
    name: "hitch",
    oneWay: 60,
    seconds: 5,
  });

  console.log(`  guest frame loop hitches 350 ms: ${fmt(hitch)}`);
  check("a guest hitch shorter than the coast window corrects nothing", hitch.corrections === 0);
  check("…and the guest ends where the host's copy is", hitch.endError < 0.05);
}

{
  const o = run({
    ...floor,
    freeze: [0.5, 1.9],
    guestHz: 60,
    input: (t) => (t < 3 ? { right: true } : {}),
    jitter: 20,
    name: "countdown",
    oneWay: 80,
    seconds: 4,
  });

  console.log(`  versus countdown seen one way late: ${fmt(o)}`);
  check(
    "a versus freeze replays once and nothing drags afterwards",
    o.replays === 1 && o.pullBack < 0.5,
  );
  check("…and the guest ends where the host's copy is", o.endError < 0.05);
}

console.log(`\n${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);
