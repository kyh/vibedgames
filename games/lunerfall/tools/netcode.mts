// Headless netcode harness: the host's copy of a guest body (GuestCopy) and the
// guest's own predicted body (Prediction), joined by a simulated link with
// latency and ordered jitter, under the situations that used to rubber-band
// the guest — hit-stop on the host, a stomp bounce, a hit while running, a
// versus countdown, bunched packets at 144 Hz. Asserts the guest's body ends
// exactly where the host's copy is and that nothing drags it backwards.
// Run: `pnpm test` (after tools/sim.mts).
import { FixedRate } from "@vibedgames/multiplayer";

import { MAX_LAG, MAX_STEPS, TILE } from "../src/config.ts";
import { HEROES } from "../src/data/heroes.ts";
import { ENEMIES } from "../src/data/enemies.ts";
import { onEnemyHead, PlayerBody } from "../src/entities/player-body.ts";
import type { BodyInput } from "../src/entities/player-body.ts";
import { GuestCopy } from "../src/net/guest-copy.ts";
import { Prediction, STEP_MS } from "../src/net/predict.ts";
import { decodeEdge } from "../src/net/snapshot.ts";
import type { GuestEdge, NetAck, NetInputs } from "../src/net/snapshot.ts";
import { Grid, ROWS } from "../src/sys/grid.ts";

const FLOOR_Y = (ROWS - 2) * TILE;
const { warrior } = ENEMIES;
// The scene loop's caps (config.ts): fixed steps per frame, frame time owed.
const LAG_MS = MAX_LAG * 1000;

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
// latency ± jitter, but never overtakes the one before it.
const link = <T,>(oneWay: number, jitter: number, seed: number) => {
  const roll = rng(seed);
  const queue: { at: number; msg: T }[] = [];
  let last = 0;
  return {
    receive: (now: number): T[] => {
      const out: T[] = [];
      while (queue.length > 0 && (queue[0]?.at ?? Infinity) <= now) {
        const head = queue.shift();
        if (head) {
          out.push(head.msg);
        }
      }
      return out;
    },
    send: (now: number, msg: T) => {
      last = Math.max(last, now + oneWay + (roll() * 2 - 1) * jitter);
      queue.push({ at: last, msg });
    },
  };
};

interface Snap {
  x: number;
  y: number;
  ack: NetAck;
  frozen: boolean;
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
}

// Snapshot positions cross the wire at 0.1 px (net/snapshot.ts).
const tenth = (v: number): number => Math.round(v * 10) / 10;

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
    correctionPx: 0,
    corrections: 0,
    endError: 0,
    maxFix: 0,
    maxJump: 0,
    pullBack: 0,
    replays: 0,
  };
  const host = { acc: 0, clock: 0, freeze: 0, step: 0 };
  const guest = { acc: 0, frozen: false };
  const holding = (t: number): boolean =>
    sc.freeze !== undefined && t >= sc.freeze[0] && t < sc.freeze[1];

  // The scene's fixed step: the guest's copy advances on its own input
  // whether or not the host is in hit-stop; combat only runs outside it.
  const hostStep = () => {
    host.step += 1;
    host.clock += STEP_MS;
    const t = host.step / 60;
    copy.step(hostBody, holding(t), host.clock);
    while (copy.takeStomp()) {
      out.claims += 1;
    }
    if (host.freeze > 0) {
      host.freeze -= STEP_MS;
    } else {
      sc.host?.(t, hostBody);
      if (sc.hitstop?.(t)) {
        host.freeze = 70;
      }
    }
    copy.drain(hostBody, host.clock);
  };

  const hostFrame = (now: number) => {
    for (const msg of up.receive(now)) {
      copy.receive(msg, 1);
    }
    host.acc = Math.min(host.acc + hostFrameMs, LAG_MS);
    for (let n = 0; host.acc >= STEP_MS && n < MAX_STEPS; n += 1) {
      host.acc -= STEP_MS;
      hostStep();
    }
    if (snapRate.due(hostFrameMs)) {
      down.send(now, {
        ack: copy.report(1, host.clock),
        frozen: holding(host.step / 60),
        x: hostBody.x,
        y: hostBody.y,
      });
    }
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
    for (const snap of down.receive(now)) {
      applySnap(snap);
    }
    prediction.sample({ ...NEUTRAL, ...sc.input(now / 1000) }, guest.frozen);
    guest.acc = Math.min(guest.acc + frameMs, LAG_MS);
    for (let n = 0; guest.acc >= STEP_MS && n < MAX_STEPS; n += 1) {
      guest.acc -= STEP_MS;
      guestStep();
    }
    const msg = prediction.flush(1);
    if (msg) {
      up.send(now, msg);
    }
  };

  // Both loops run on their own frame clocks; whichever frame is due next goes.
  const guestFrameMs = 1000 / sc.guestHz;
  const hostFrameMs = 1000 / (sc.hostHz ?? 60);
  const end = sc.seconds * 1000;
  let nextHost = 0;
  let nextGuest = 0;
  let lastGuest = -guestFrameMs;
  while (nextHost <= end || nextGuest <= end) {
    if (nextHost <= nextGuest) {
      hostFrame(nextHost);
      nextHost += hostFrameMs;
    } else {
      guestFrame(nextGuest, nextGuest - lastGuest);
      lastGuest = nextGuest;
      nextGuest += guestFrameMs;
      // A frame hitch: no frames at all, then one long one.
      if (sc.hitch && nextGuest >= sc.hitch[0] * 1000 && nextGuest < sc.hitch[1] * 1000) {
        nextGuest = sc.hitch[1] * 1000;
      }
    }
  }
  out.endError = Math.hypot(guestBody.x - hostBody.x, guestBody.y - hostBody.y);
  return out;
};

const fmt = (o: Outcome): string =>
  `${o.corrections} corrections, ${o.correctionPx.toFixed(1)} px (pull-back ${o.pullBack.toFixed(1)} px, max ${o.maxFix.toFixed(2)}), ` +
  `${o.replays} replays (max jump ${o.maxJump.toFixed(1)} px), end error ${o.endError.toFixed(3)} px`;

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
