// Headless netcode harness: the host's copy of a guest body (GuestCopy) and the
// guest's own predicted body (Prediction), joined by a simulated link with
// latency and ordered jitter, under the situations that used to rubber-band
// the guest — hit-stop on the host, a stomp bounce, a hit while running, a
// versus countdown, bunched packets at 144 Hz. Asserts the guest's body ends
// exactly where the host's copy is and that nothing drags it backwards.
//
// Both ends keep their own local clock. The host learns the room's server time
// the way the SDK does, from probes to the party server and back, and stamps
// each snapshot with it; the guest draws the host's own hero from those stamps
// as the scene draws a puppet — on a RemoteClock fed each snapshot's arrival on
// the guest's own clock — and is held to where the host had it.
// Run: `pnpm test` (after tools/sim.mts).
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
import type {
  GuestEdge,
  NetAck,
  NetInputs,
  NetPlayerRow,
  PlayerPose,
} from "../src/net/snapshot.ts";
import { Grid, ROWS } from "../src/sys/grid.ts";

const FLOOR_Y = (ROWS - 2) * TILE;
const { warrior } = ENEMIES;
// The scene loop's caps (config.ts): fixed steps per frame, frame time owed.
const LAG_MS = MAX_LAG * 1000;
// The party server's clock reads EPOCH + true time; each tab's own clock
// (performance.now) started on its own, somewhere else.
const EPOCH = 1_790_000_000_000;
const HOST_ORIGIN = 4321.5;
const GUEST_ORIGIN = 987.25;
// The SDK's probes: a burst on joining, then the slow cadence.
const PROBE_BURST = [0, 100, 250, 500];
// Ms of each run before the host's world is held to account: the host's
// server clock and the relay have to have been measured.
const SETTLE_MS = 1000;
// …and before the host's copy of the guest is: its clock's hold eases in from
// nothing over the stream's first second or so, at the copy's 2-tick floor.
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

// Park–Miller, so every run sees the same jitter.
const rng = (seed: number) => {
  let s = seed;
  return (): number => {
    s = (s * 48_271) % 2_147_483_647;
    return s / 2_147_483_647;
  };
};

// An ordered link (TCP under a WebSocket): each message is late by the one-way
// latency ± jitter, but never overtakes the one before it. `arrivals` hands
// each one over with the moment it landed — a socket's message handler runs
// then, between frames.
const link = <T,>(oneWay: number, jitter: number, seed: number) => {
  const roll = rng(seed);
  const queue: { at: number; msg: T }[] = [];
  let last = 0;
  const arrivals = (now: number): { at: number; msg: T }[] => {
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

// One tab's view of the room's server time: the SDK's ServerClock, fed by
// probes that cross to the party server and back, each hop half the one-way
// latency (± half the jitter). The server reads its clock as a probe lands.
const serverClock = (origin: number, oneWay: number, jitter: number, seed: number) => {
  const clock = new ServerClock();
  const up = link<number>(oneWay / 2, jitter / 2, seed);
  const down = link<{ c: number; s: number }>(oneWay / 2, jitter / 2, seed + 1);
  const due = [...PROBE_BURST];
  const local = (now: number): number => now + origin;
  return {
    clock,
    local,
    // Everything due by true time `now`: probes out, answers back.
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

// The guest tab's own clock (performance.now) at true time `now`.
const guestLocal = (now: number): number => now + GUEST_ORIGIN;

interface Snap {
  // server time the host sent it
  t: number;
  x: number;
  y: number;
  ack: NetAck;
  frozen: boolean;
  // the host's own hero, as its row
  own: NetPlayerRow;
}

interface Scenario {
  name: string;
  oneWay: number;
  jitter: number;
  seconds: number;
  guestHz: number;
  // the host's frame rate (default 60): a slow host runs its sim behind real time
  hostHz?: number;
  // the guest's frame loop stalls over this window of its time (s)
  hitch?: [from: number, to: number];
  // each frame of either tab runs up to this much early or late (ms), as a
  // busy page's do
  frameJitter?: number;
  spawnX: number;
  spawnY: number;
  // the guest player's hands, by guest time (s)
  input: (t: number) => Partial<BodyInput>;
  // host-only events, by host time (s): what combat / the match do to the copy
  hitstop?: (t: number) => boolean;
  host?: (t: number, copy: PlayerBody) => void;
  // the host holds input (versus countdown) over this window of host time (s)
  freeze?: [from: number, to: number];
  // an enemy standing where the guest's screen draws it: its feet judge stomps
  head?: { x: number; y: number };
}

interface Outcome {
  // stomps the guest called that landed on the host's copy
  claims: number;
  corrections: number;
  correctionPx: number;
  pullBack: number;
  maxFix: number;
  replays: number;
  maxJump: number;
  endError: number;
  // the host's own hero as the guest draws it, once settled: frames drawn,
  // frames whose render time had passed the newest snapshot, the furthest the
  // drawing strayed from where the host had the hero at render time (px), and
  // the relay the render clock measured (ms)
  drawn: number;
  dry: number;
  drawError: number;
  relay: number;
  // the guest's body as the host's copy plays it, once settled: host steps,
  // and those that applied no guest tick (it stood still on the host's
  // screen) or several at once (it jumped)
  copySteps: number;
  copyIdle: number;
  copyBunched: number;
}

// Snapshot positions cross the wire at 0.1 px (net/snapshot.ts).
const tenth = (v: number): number => Math.round(v * 10) / 10;

// The host's own hero paces the floor, turning every 0.6 s.
const pace = (t: number): Partial<BodyInput> =>
  Math.floor(t / 0.6) % 2 === 0 ? { right: true } : { left: true };

const run = (sc: Scenario): Outcome => {
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
  // The guest stamps its sends with the room's server time, learnt the same way.
  const guestTime = serverClock(GUEST_ORIGIN, sc.oneWay, sc.jitter, 31);
  // The host's own hero, and where it stood after each host frame (true time).
  const own = new PlayerBody(grid, 12 * TILE, FLOOR_Y, kit);
  const ownPath: { at: number; x: number }[] = [];
  // The guest draws it as the scene draws a puppet (scenes/guest-sync.ts).
  const relay = new RemoteClock();
  const puppet = new Interpolator<PlayerPose>({
    clock: relay,
    delayMs: INTERP_MS,
    lerp: lerpPlayer,
  });
  let newest = -Infinity;
  const holding = (t: number): boolean =>
    sc.freeze !== undefined && t >= sc.freeze[0] && t < sc.freeze[1];

  // The scene's fixed step: the guest's copy advances on its own input
  // whether or not the host is in hit-stop; combat — and every other body on
  // the host's screen — only runs outside it.
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
      // a versus hold leaves it neutral, like the scene's bodies
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
    // A socket's handler runs as each message lands, between frames.
    for (const { at, msg } of up.arrivals(now)) {
      copy.receive(msg, 1, hostTime.local(at));
    }
    host.acc = Math.min(host.acc + frameMs, LAG_MS);
    for (let n = 0; host.acc >= STEP_MS && n < MAX_STEPS; n += 1) {
      host.acc -= STEP_MS;
      // as the scene does: the step ends where the frame clock stands, less
      // the time still owed
      hostStep(now, hostTime.local(now) - host.acc);
    }
    ownPath.push({ at: now, x: own.x });
    if (snapRate.due(frameMs)) {
      // stamped as scenes/host-net.ts stamps it
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

  // Where the host had its hero at true time `at`, between its frames.
  const ownAt = (at: number): number | null => {
    for (let i = ownPath.length - 1; i > 0; i -= 1) {
      const b = ownPath[i];
      const a = ownPath[i - 1];
      if (a && b && a.at <= at && at <= b.at) {
        return a.x + ((b.x - a.x) * (at - a.at)) / (b.at - a.at);
      }
    }
    return null;
  };

  // A snapshot's stamp and its arrival on the guest's clock measure the relay;
  // the host's hero joins the puppet's history, pushed at that same arrival.
  const receiveSnap = (snap: Snap, at: number) => {
    const receivedAt = guestLocal(at);
    relay.observe(snap.t, receivedAt);
    puppet.push(snap.t, decodePlayer(snap.own), receivedAt);
    newest = Math.max(newest, snap.t);
  };

  // The guest's frame draws the host's hero; once settled, hold it to the host.
  const drawOwn = (now: number) => {
    const local = guestLocal(now);
    const pose = puppet.sample(local);
    if (!relay.synced || !pose || now < SETTLE_MS) {
      return;
    }
    // the moment the puppet was drawn at: as far behind the relay as it needs
    const renderAt = puppet.renderTime(local);
    const truth = ownAt(renderAt - EPOCH);
    if (truth === null) {
      return;
    }
    out.drawn += 1;
    out.dry += renderAt >= newest ? 1 : 0;
    out.drawError = Math.max(out.drawError, Math.abs(pose.x - truth));
    // the party server's clock right now, less the relay clock's reading
    out.relay = EPOCH + now - relay.now(local);
  };

  const applySnap = (snap: Snap) => {
    const edges = snap.ack.edges.flatMap((e): GuestEdge[] => {
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

  // A drift correction against the body's motion is a pull-back.
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
      // as the scene stamps it: the step ended where the frame clock stands,
      // less the time still owed
      guest.tickAt = guestTime.local(now) - guest.acc;
    }
    const msg = prediction.flush(1, Math.floor(guestTime.clock.now(guest.tickAt)));
    if (msg) {
      up.send(now, msg);
    }
    drawOwn(now);
  };

  // Both loops run on their own frame clocks; whichever frame is due next goes.
  const guestFrameMs = 1000 / sc.guestHz;
  const hostFrameMs = 1000 / (sc.hostHz ?? 60);
  const wobble = rng(41);
  const late = (): number => (wobble() * 2 - 1) * (sc.frameJitter ?? 0);
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
      // A frame hitch: no frames at all, then one long one.
      if (sc.hitch && nextGuest >= sc.hitch[0] * 1000 && nextGuest < sc.hitch[1] * 1000) {
        nextGuest = sc.hitch[1] * 1000;
      }
    }
  }
  out.endError = Math.hypot(guestBody.x - hostBody.x, guestBody.y - hostBody.y);
  return out;
};

const share = (part: number, whole: number): string =>
  `${((100 * part) / Math.max(1, whole)).toFixed(1)}%`;

const fmt = (o: Outcome): string =>
  `${o.corrections} corrections, ${o.correctionPx.toFixed(1)} px (pull-back ${o.pullBack.toFixed(1)} px, max ${o.maxFix.toFixed(2)}), ` +
  `${o.replays} replays (max jump ${o.maxJump.toFixed(1)} px), end error ${o.endError.toFixed(3)} px; ` +
  `host's hero drawn ${o.drawn} frames, ${o.dry} dry, max off ${o.drawError.toFixed(2)} px (relay ${o.relay.toFixed(0)} ms); ` +
  `copy steps ${share(o.copyIdle, o.copySteps)} idle, ${share(o.copyBunched, o.copySteps)} bunched`;

console.log("lunerfall netcode harness\n");

// Off the left ledge: run right for 0.9 s, then let go.
const off = (t: number): Partial<BodyInput> => (t < 0.9 ? { right: true } : {});

// The guest runs right along the floor for 2.6 s, then stands.
const runRight = (t: number): Partial<BodyInput> => (t < 2.6 ? { right: true } : {});
const floor = { spawnX: 3 * TILE, spawnY: FLOOR_Y };
// Hops while running back and forth for 3 s, then stands.
const hopBackAndForth = (t: number): Partial<BodyInput> => {
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
  // 70 ms of host hit-stop every 300 ms while the guest runs: the copy used to
  // freeze with every body and fall behind the guest's prediction.
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
  // Server-time stamps run on while the host stands still, so the guest draws
  // the host's world standing still too, a relay and a render delay later.
  check(
    "the guest draws the host's hero on server time, never running dry",
    o.drawn > 0 && o.dry === 0,
  );
  check("…and where the host had it, hit-stops included", o.drawError < 2.5);
}

for (const oneWay of [60, 120]) {
  // An enemy in front lands a hit on the host's copy mid-run.
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
    // A relay longer than INTERP_MS: render time must sit behind the relay,
    // not INTERP_MS behind server time, or every frame would extrapolate.
    check(`a ${oneWay} ms relay never runs the guest's view dry`, o.drawn > 0 && o.dry === 0);
  }
}

{
  // Off the left ledge onto a warrior's head: in co-op the guest calls the
  // stomp on its own screen, bouncing the tick its feet land, and the host's
  // copy bounces on that same tick.
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
  // A duel stomp is the host's call: the host's copy bounces off the other
  // duelist's head and the guest replays the bounce.
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
  // Everything a hand does in two seconds, at 144 Hz (frames without a sim
  // step), under bunching jitter: presses must reach the host on the same tick.
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
  // The multiplayer skill's net-check lag: every socket 80–120 ms late, so
  // two hops guest → party server → host, both tabs at 30 fps, the guest
  // running back and forth for 7 s. The copy must play the guest's ticks one
  // a host step, as evenly as the guest stepped them: a count-based buffer
  // two ticks deep left 8% of steps idle and 8% doubled here.
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
  // A host too slow for its step cap (8 fps: its sim runs at two thirds of real
  // time) and a guest whose loop hitches for 350 ms: the copy falls behind and
  // catches up, the guest's input keeps flowing, and nothing is corrected.
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
  // A versus round intro: the host holds input for 1.4 s; the guest sees the
  // countdown (and its end) one way late while holding right throughout.
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
