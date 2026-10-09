// A host sim and a predicting guest, headless, talking through a simulated
// relay: each client has its own jittery link to the server, so every intent
// and every frame crosses two hops. Real bodies (Brawler), the real host
// intent path, the real wire format, the real guest prediction and the SDK's
// server clock, measured by each client over its own link; only the scene and
// the socket are stand-ins. Checks the feel the netcode exists for: the guest's
// body answers on the frame its key goes down, running straight never draws a
// correction, a dodge cannot lock, knockback is felt once, remote bodies move
// evenly and are never guessed at over a slow relay, a change of host eases
// them onto the new route without a jump, and a frame stays small.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedRate } from "@vibedgames/multiplayer";
import { BRAWLERS } from "../src/config.ts";
import type { BrawlerId } from "../src/config.ts";
import { EVADE } from "../src/entities/evasion.ts";
import { applyRemoteIntents } from "../src/net/host.ts";
import { IntentLink } from "../src/net/intent-link.ts";
import { parseIntent } from "../src/net/intents.ts";
import { FrameClock } from "../src/net/frame-clock.ts";
import { PuppetTrack } from "../src/net/interpolation.ts";
import { DEAD_ZONE, EVADE_TIMEOUT_MS } from "../src/net/prediction.ts";
import { INTERP_DELAY_MS, SNAPSHOT_HZ } from "../src/net/protocol.ts";
import type { RemoteIntent } from "../src/net/session.ts";
import {
  decodeFrame,
  encodeFrame,
  encodeMatch,
  parseFrame,
  parseMatch,
} from "../src/net/snapshot.ts";
import type { BrawlerState } from "../src/net/snapshot.ts";
import { parseJson } from "../src/json.ts";
import { seededRandom } from "../src/utils.ts";
import {
  asGame,
  body,
  openWorld,
  overTheWire,
  peer,
  SERVER_EPOCH,
  stubGame,
  wire,
} from "./headless.mts";
import type { Peer } from "./headless.mts";

const HOST_FRAME_MS = 1000 / 60;
/**
 * Each client's link to the server, one way: 30 ms ± 10. Host and guest talk
 * through the server, two hops apart: 40–80 ms one way, round trips 80–160 ms.
 */
const HOP_MS = 30;
const HOP_JITTER_MS = 10;
const KIT: BrawlerId = "titan";
const SPEED = BRAWLERS[KIT].speed;

interface Controls {
  x: number;
  z: number;
  evade: boolean;
}

const IDLE: Controls = { evade: false, x: 0, z: 0 };

/** A brawl between a host and one guest, stepped on a shared wall clock. */
const makeMatch = (seed = 1) => {
  const inbox: RemoteIntent[] = [];
  const host = stubGame("host", inbox);
  const guest = stubGame("guest");
  const spawn = { name: "Guest", netId: "p:guest", owner: "guest", x: 0, z: 0 };
  const copy = body(host, spawn);
  for (let i = 0; i < 7; i += 1) {
    body(host, { name: `Bot ${i}`, netId: `bot:${i}`, x: -12 + i * 4, z: -9 });
  }
  const own = body(guest, { ...spawn, drive: "predict", isPlayer: true });
  // The host stamps frames by its own reading of the server clock; the guest's
  // prediction never reads the stamps — it times its body on its own clock.
  const hostLink = peer(seed * 10, -4321.5, HOP_MS, HOP_JITTER_MS);
  const guestLink = peer(seed * 10 + 5, -98_765.25, HOP_MS, HOP_JITTER_MS);
  const up = wire(guestLink.up, hostLink.down);
  const down = wire(hostLink.up, guestLink.down);
  const frameRng = seededRandom(seed * 7 + 3);
  const roster = parseMatch(overTheWire(encodeMatch(host.brawlers, 1, 7, null, 1)));
  assert.ok(roster);
  /** Every pending correction the host's rows asked for. */
  const errors: number[] = [];
  /** The guest's frames: when, what it was pressing, and where its body ended up. */
  const frames: { now: number; pressing: boolean; x: number }[] = [];
  const state = {
    copy,
    /** Distance the guest's body was moved by corrections, summed. */
    corrected: 0,
    down,
    dropEvades: false,
    errors,
    frames,
    guest,
    host,
    inbox,
    link: new IntentLink(() => ({
      reachable: true,
      sendIntent: (intent) => up.send(state.now, JSON.stringify(intent)),
    })),
    nextGuest: 0,
    nextHost: 0,
    now: 0,
    own,
    rate: new FixedRate(SNAPSHOT_HZ),
    refuseEvades: false,
    roster,
    seq: 0,
    up,
  };

  const hostStep = (): void => {
    const dt = HOST_FRAME_MS / 1000;
    const stepStart = host.elapsed;
    host.elapsed += dt;
    for (const data of up.take(state.now)) {
      const intent = parseIntent(parseJson(data));
      if (!intent || (intent.kind === "evade" && state.dropEvades)) {
        continue;
      }
      if (intent.kind === "evade" && state.refuseEvades) {
        // The host's copy is still cooling down from something the guest never saw.
        copy.evadeCooldown = 2;
      }
      inbox.push({ from: "guest", intent });
    }
    applyRemoteIntents(asGame(host), stepStart * 1000);
    for (const b of host.brawlers) {
      b.update(dt);
    }
    if (state.rate.due(HOST_FRAME_MS)) {
      state.seq += 1;
      const t = hostLink.clock.serverAt(state.now);
      const frame = encodeFrame(host, state.seq, 1, t, host.elapsed * 1000);
      down.send(state.now, JSON.stringify(frame));
    }
  };

  const guestStep = (controls: Controls, frameMs: number): void => {
    const { link } = state;
    link.prediction.beginStep(frameMs);
    for (const data of down.take(state.now)) {
      const frame = parseFrame(parseJson(data));
      const row: BrawlerState | null | undefined = frame && decodeFrame(frame, roster)?.brawlers[0];
      assert.ok(row, "every frame decodes against its roster");
      link.prediction.receive(own, row);
      const { pending } = link.prediction.reconciler;
      state.errors.push(Math.hypot(pending.x, pending.y));
    }
    link.steer(own, controls.x, controls.z, null, state.now);
    if (controls.evade && !own.evadePending && own.evade(1, 0)) {
      link.sendEvade(own, 1, 0);
    }
    own.update(frameMs / 1000);
    const fix = link.prediction.settle(own.x, own.z, frameMs);
    own.root.position.x += fix.x;
    own.root.position.z += fix.y;
    state.corrected += Math.hypot(fix.x, fix.y);
    state.frames.push({ now: state.now, pressing: controls.x !== 0, x: own.x });
  };

  /** Advance both clients to `until` ms; `controls` is the guest's input at each of its frames. */
  const run = (until: number, controls: (now: number) => Controls = () => IDLE): void => {
    for (;;) {
      const next = Math.min(state.nextHost, state.nextGuest);
      if (next > until) {
        return;
      }
      state.now = next;
      if (state.nextHost <= state.nextGuest) {
        hostStep();
        state.nextHost += HOST_FRAME_MS;
      } else {
        // The guest's frames wander between 12 and 22 ms: never in step with the host's.
        const frameMs = 12 + frameRng() * 10;
        guestStep(controls(state.now), frameMs);
        state.nextGuest += frameMs;
      }
    }
  };

  return { run, state };
};

const right = (from: number, to: number) => (now: number) =>
  now >= from && now < to ? { evade: false, x: 1, z: 0 } : IDLE;

const evadeAt = (at: number) => (now: number) => ({
  evade: now >= at && now < at + 40,
  x: 0,
  z: 0,
});

test("the guest's body moves on the frame its key goes down", () => {
  const { run, state } = makeMatch(1);
  run(1000);
  run(1040, right(1000, 2000));
  const first = state.frames.findIndex((frame) => frame.pressing);
  const pressed = state.frames[first];
  const before = state.frames[first - 1];
  assert.ok(pressed && before);
  assert.ok(pressed.x - before.x > 0.03, `moved ${pressed.x - before.x} on the key's own frame`);
  // The host's copy has not even heard about it yet: the motion is the prediction's.
  assert.equal(state.copy.x, 0);
});

test("running straight under latency and jitter draws no correction, the body leading by speed × latency", () => {
  const { run, state } = makeMatch(2);
  run(1000);
  const leads: number[] = [];
  for (let t = 1200; t <= 3000; t += 200) {
    run(t, right(1000, 3000));
    if (t >= 1400) {
      leads.push(state.own.x - state.copy.x);
    }
  }
  run(4000, right(1000, 3000));
  const worst = Math.max(...state.errors);
  assert.ok(worst <= DEAD_ZONE, `largest error the host reported: ${worst.toFixed(4)}`);
  assert.equal(state.corrected, 0, "the prediction was never pulled");
  // Ahead of the host's copy by the time the input took to get there — what a
  // reconcile against "now" would have dragged back on every snapshot.
  const minUp = Math.min(...state.up.delays);
  const maxUp = Math.max(...state.up.delays);
  for (const lead of leads) {
    assert.ok(lead > DEAD_ZONE, `lead ${lead.toFixed(3)} exceeds the dead zone`);
    assert.ok(lead >= (SPEED * (minUp - HOST_FRAME_MS)) / 1000, `lead ${lead.toFixed(3)}`);
    assert.ok(lead <= (SPEED * (maxUp + 22)) / 1000, `lead ${lead.toFixed(3)}`);
  }
  assert.ok(Math.max(...leads) - Math.min(...leads) < 0.15, "the lead holds steady");
  // Both stopped. The host held the key for as long as its two messages took to
  // arrive apart, which jitter can stretch by a few centimetres: inside the dead zone.
  assert.ok(Math.abs(state.own.x - state.copy.x) <= DEAD_ZONE, `${state.own.x} vs ${state.copy.x}`);
  assert.ok(state.own.x > 6, `ran ${state.own.x.toFixed(2)}`);
});

test("an accepted evade rolls both copies together, with no correction", () => {
  const { run, state } = makeMatch(3);
  run(1500);
  run(3500, evadeAt(1500));
  assert.equal(state.own.evadePending, false);
  assert.ok(state.copy.evadeResult > 0, "the host accepted the roll");
  assert.equal(state.corrected, 0);
  assert.ok(Math.abs(state.own.x - EVADE.distance) < 0.01, `rolled to ${state.own.x}`);
  assert.ok(Math.abs(state.own.x - state.copy.x) < 0.005);
  // The guest's cooldown runs ahead of the copy's by the time the request took to arrive.
  const ahead = state.copy.evadeCooldown - state.own.evadeCooldown;
  assert.ok(ahead >= 0 && ahead < 0.15, `cooldown lead ${ahead.toFixed(3)}`);
});

test("a lost evade request clears within a second, and dodging works again", () => {
  const { run, state } = makeMatch(4);
  run(1500);
  state.dropEvades = true;
  run(1500 + EVADE_TIMEOUT_MS + 200, evadeAt(1500));
  assert.equal(state.own.evadePending, false, "the pending roll timed out");
  run(3000);
  // The host never rolled: the guest is back on the host's copy and may dodge again.
  assert.ok(Math.abs(state.own.x - state.copy.x) <= DEAD_ZONE);
  assert.ok(state.own.evadeCooldown <= 0.05, `cooldown ${state.own.evadeCooldown}`);
  state.dropEvades = false;
  run(4500, evadeAt(3000));
  assert.ok(state.copy.evadeResult > 0, "the second request reached the host and rolled");
  assert.equal(state.own.evadePending, false);
  assert.ok(Math.abs(state.own.x - state.copy.x) <= DEAD_ZONE);
  assert.ok(Math.abs(state.copy.x - EVADE.distance) < 0.01);
});

test("a refused evade is cancelled and the body returns to the host's copy", () => {
  const { run, state } = makeMatch(5);
  run(1500);
  state.refuseEvades = true;
  run(1500 + 400, evadeAt(1500));
  assert.ok(state.copy.evadeResult < 0, "the host refused the roll");
  assert.equal(state.own.evadePending, false);
  assert.equal(state.own.evasion, null);
  assert.ok(state.own.evadeCooldown > 1, "the host's cooldown came back with the refusal");
  run(3000);
  assert.ok(Math.abs(state.own.x - state.copy.x) <= DEAD_ZONE, `${state.own.x} vs ${state.copy.x}`);
  assert.ok(Math.max(...state.errors) > DEAD_ZONE, "the roll that never happened is undone");
});

test("a knockback shoves the guest once, the same distance the host does", () => {
  const { run, state } = makeMatch(6);
  run(1500);
  state.copy.applyKnock(6, 0);
  run(3500);
  const shove = state.copy.x;
  assert.ok(shove > 0.8 && shove < 1, `the host's copy slid ${shove.toFixed(3)}`);
  assert.ok(Math.abs(state.own.x - shove) < 0.05, `${state.own.x} vs ${shove}`);
  // Felt once: never shoved past where the host's copy comes to rest.
  const furthest = Math.max(...state.frames.map((frame) => frame.x));
  assert.ok(furthest < shove + 0.05, `slid as far as ${furthest.toFixed(3)}`);
  assert.ok(Math.max(...state.errors) <= DEAD_ZONE, "the host never had to correct it");
});

/** A host on the runner's sim from wall time `from` until `until`, on its own link to the server. */
interface Sender {
  from: number;
  id: string;
  link: Peer;
  until: number;
}

/** The sender hosting at wall time `at`; none between two, while the server elects. */
const senderAt = (senders: readonly Sender[], at: number): Sender | undefined =>
  senders.find((sender) => at >= sender.from && at < sender.until);

/** Run right for 400 ms, then left for 400 ms, and so on. */
const zigzag = (at: number): number => (Math.floor(at / 400) % 2 === 0 ? 1 : -1);

/**
 * A runner on the hosts' sim, sending 30 Hz frames through the server to a
 * guest that reads them on a FrameClock, as they arrive, and draws the runner
 * as a puppet until 3 s after the last sender takes over. While nobody hosts
 * the runner stands still, as a promoted host resumes from the last frame.
 * `steer` is the runner's input at each host step; at `hurtAt` the runner
 * takes a hit. Returns each drawn step, how far the puppet trailed the runner,
 * when each sender's first frame landed, and for every frame drawn once a
 * frame was in hand: when, the render time it was drawn at and how far that
 * was past the newest frame (above zero the puppet is being extrapolated, not
 * interpolated), how far the puppet was drawn past anywhere the runner had
 * been, and the health it showed.
 */
const watchRunner = (
  senders: readonly Sender[],
  viewer: Peer,
  steer: (at: number) => number = () => 1,
  hurtAt = Number.POSITIVE_INFINITY,
) => {
  const until = Math.max(...senders.map((sender) => sender.from)) + 3000;
  const host = stubGame("host");
  const guest = stubGame("guest");
  const runner = body(host, { name: "Runner", netId: "bot:0", x: -10, z: 0 }, "nyx");
  const roster = parseMatch(overTheWire(encodeMatch(host.brawlers, 1, 7, null, 1)));
  assert.ok(roster);
  const puppet = body(
    guest,
    { drive: "puppet", name: "Runner", netId: "bot:0", x: -10, z: 0 },
    "nyx",
  );
  // One timeline for the guest, whoever hosts, eased onto each new host's route.
  const clock = new FrameClock();
  const track = new PuppetTrack(clock);
  // Up the hosting sender's link, down the guest's.
  const route = wire((at) => senderAt(senders, at)?.link.up(at) ?? at, viewer.down);
  const sentBy = new Map<number, Sender>();
  const firstLanded = new Map<string, number>();
  const rate = new FixedRate(SNAPSHOT_HZ);
  const frameRng = seededRandom(12);
  let hostAt = 0;
  let guestAt = 0;
  let seq = 0;
  const steps: { dt: number; dx: number }[] = [];
  const trails: number[] = [];
  const drawn: { ahead: number; at: number; hp: number; past: number; render: number }[] = [];
  const went = { max: runner.x, min: runner.x };
  let newest = Number.NEGATIVE_INFINITY;
  while (guestAt < until) {
    if (hostAt <= guestAt) {
      const sender = senderAt(senders, hostAt);
      host.elapsed += HOST_FRAME_MS / 1000;
      runner.moveX = sender ? steer(hostAt) : 0;
      if (hostAt >= hurtAt && runner.hp === runner.maxHp) {
        runner.hp -= 400;
      }
      runner.update(HOST_FRAME_MS / 1000);
      went.max = Math.max(went.max, runner.x);
      went.min = Math.min(went.min, runner.x);
      if (rate.due(HOST_FRAME_MS) && sender) {
        seq += 1;
        const t = sender.link.clock.serverAt(hostAt);
        sentBy.set(seq, sender);
        route.send(hostAt, JSON.stringify(encodeFrame(host, seq, 1, t, host.elapsed * 1000)));
      }
      hostAt += HOST_FRAME_MS;
      continue;
    }
    for (const data of route.take(guestAt)) {
      const frame = parseFrame(parseJson(data));
      const state: BrawlerState | null | undefined =
        frame && decodeFrame(frame, roster)?.brawlers[0];
      assert.ok(frame && state);
      const arrivedAt = viewer.clock.local(guestAt);
      const from = sentBy.get(frame.s)?.id ?? null;
      if (from !== null && !firstLanded.has(from)) {
        firstLanded.set(from, guestAt);
      }
      clock.arrived(frame.t, arrivedAt, from);
      track.receive(frame.t, state, arrivedAt);
      newest = Math.max(newest, frame.t);
    }
    const before = puppet.x;
    const local = viewer.clock.local(guestAt);
    const renderAt = clock.now(local) - INTERP_DELAY_MS;
    track.pose(puppet, local, renderAt, openWorld);
    if (Number.isFinite(newest)) {
      const past = Math.max(puppet.x - went.max, went.min - puppet.x);
      drawn.push({ ahead: renderAt - newest, at: guestAt, hp: puppet.hp, past, render: renderAt });
    }
    const frameMs = 12 + frameRng() * 10;
    if (guestAt > 600) {
      steps.push({ dt: frameMs, dx: puppet.x - before });
      trails.push(runner.x - puppet.x);
    }
    guestAt += frameMs;
  }
  // How far behind server time the frames are read, by the guest's own reading
  // of the server clock: the relay's fastest trip.
  const local = viewer.clock.local(guestAt);
  const behindMs = viewer.clock.server.now(local) - clock.now(local);
  return { behindMs, drawn, firstLanded, route, runner, steps, trails };
};

/** Each drawn step matches the time it covered: no surges on bunched frames, no stalls in gaps. */
const assertEven = (steps: readonly { dt: number; dx: number }[]): void => {
  const { speed } = BRAWLERS.nyx;
  for (let i = 1; i < steps.length; i += 1) {
    const step = steps[i];
    const span = steps[i - 1]?.dt ?? 0;
    assert.ok(step);
    const expected = (speed * span) / 1000;
    assert.ok(Math.abs(step.dx - expected) < expected * 0.2, `step ${step.dx} vs ${expected}`);
  }
};

/** The furthest a puppet was drawn past where its body went, over these frames. */
const overshoot = (drawn: readonly { past: number }[]): number =>
  Math.max(0, ...drawn.map((frame) => frame.past));

/** The furthest render time ran past the newest frame in hand: above zero is a guess. */
const extrapolated = (drawn: readonly { ahead: number }[]): number =>
  Math.max(...drawn.map((frame) => frame.ahead));

/** The most the frame clock bends render time's pace while it eases onto a new route (the SDK's slew). */
const EASE = 0.1;

/**
 * Render time never jumps: over each drawn frame it keeps the pace of the
 * guest's own clock to within EASE, where a jump moves it a whole route's
 * difference at once. (Render times are server times, ~1.8e12 ms, whose float
 * rounding shows in a pace's fifth decimal.)
 */
const assertEased = (drawn: readonly { at: number; render: number }[]): void => {
  for (let i = 1; i < drawn.length; i += 1) {
    const prev = drawn[i - 1];
    const frame = drawn[i];
    assert.ok(prev && frame);
    const pace = (frame.render - prev.render) / (frame.at - prev.at);
    assert.ok(
      Math.abs(pace - 1) <= EASE + 1e-4,
      `render time ran at ${pace.toFixed(3)}× at ${frame.at.toFixed(0)} ms`,
    );
  }
};

test("a remote body renders evenly from jittery 30 Hz frames, about the delay behind", () => {
  const host = { from: 0, id: "host", link: peer(21, -4321.5, 25, 12), until: Infinity };
  const { behindMs, route, steps, trails } = watchRunner([host], peer(31, -98_765.25, 25, 12));
  assertEven(steps);
  // The frames are read the relay's fastest trip behind server time, give or
  // take the few ms the two clients' readings of the server clock differ.
  const fastest = Math.min(...route.delays);
  assert.ok(
    Math.abs(behindMs - fastest) < 12,
    `behind ${behindMs.toFixed(1)} vs ${fastest.toFixed(1)}`,
  );
  // Behind the host by the render delay plus that trip: a steady, not a growing, lag.
  const { speed } = BRAWLERS.nyx;
  const meanTrail = trails.reduce((sum, d) => sum + d, 0) / trails.length;
  const expectedTrail = (speed * (INTERP_DELAY_MS + fastest)) / 1000;
  assert.ok(Math.abs(meanTrail - expectedTrail) < 0.25, `trail ${meanTrail} vs ${expectedTrail}`);
  assert.ok(Math.max(...trails) - Math.min(...trails) < 0.3, "the trail holds steady");
});

test("through a 100–150 ms relay a turning body is never drawn past where it went", () => {
  // Each client 50 ms plus up to 25 from the server, like the local party
  // harness. Drawn a fixed 100 ms behind server time, every frame would still
  // be on its way: the puppet would be extrapolated all the time and overshoot
  // every turn.
  const host = { from: 0, id: "host", link: peer(21, -4321.5, 62.5, 12.5), until: Infinity };
  const { behindMs, drawn, route } = watchRunner([host], peer(31, -98_765.25, 62.5, 12.5), zigzag);
  assert.ok(extrapolated(drawn) <= 0, `render time ran ${extrapolated(drawn).toFixed(1)} ms past`);
  assert.ok(overshoot(drawn) < 0.005, `drawn ${overshoot(drawn).toFixed(3)} past the host's body`);
  const fastest = Math.min(...route.delays);
  assert.ok(
    Math.abs(behindMs - fastest) < 12,
    `behind ${behindMs.toFixed(1)} vs ${fastest.toFixed(1)}`,
  );
});

/**
 * The first host leaves at 1.5 s; after a 150 ms election the second picks up
 * from the last frame, with its own local clock, its own reading of the server
 * clock and its own route to the server: `firstMs` and `secondMs` one way.
 */
const handover = (firstMs: number, secondMs: number) => {
  const first = { from: 0, id: "first", link: peer(21, -4321.5, firstMs, 12), until: 1500 };
  const second = {
    from: 1650,
    id: "second",
    link: peer(41, -55_555.75, secondMs, 12),
    until: Infinity,
  };
  const { drawn, firstLanded } = watchRunner([first, second], peer(31, -98_765.25, 25, 12), zigzag);
  return { drawn, landed: firstLanded.get("second") ?? Infinity };
};

test("a new host on a slower route is timed afresh: eased onto without a jump, then remotes stay interpolated", () => {
  // A route 120 ms slower: another continent. Timed against the first host's
  // route, its frames would land after render time until that route's
  // arrivals aged out of the clock's window, seconds later. The clock learns
  // the new route from the second host's first frame and eases onto it rather
  // than snapping every remote body 120 ms back along its path…
  const { drawn, landed } = handover(25, 145);
  assertEased(drawn);
  // …at a tenth of real time: 1.2 s. Until then the new frames can land a
  // little after render time, remotes carried on along their last motion;
  // from then on they stay interpolated.
  const settled = landed + 120 / EASE + INTERP_DELAY_MS + 1000 / SNAPSHOT_HZ;
  const after = drawn.filter((frame) => frame.at >= settled);
  assert.ok(after.length > 30, `the second host's frames were drawn (${after.length})`);
  assert.ok(extrapolated(after) <= 0, `render time ran ${extrapolated(after).toFixed(1)} ms past`);
  assert.ok(overshoot(after) < 0.005, `drawn ${overshoot(after).toFixed(3)} past the host's body`);
});

test("a host change onto a route a few tens of ms off never jumps render time, and remotes stay interpolated", () => {
  // 40 ms slower, then 40 ms faster: the render delay covers what the clock
  // has still to ease, so the new host's frames are in time from the first.
  for (const [firstMs, secondMs] of [
    [25, 65],
    [65, 25],
  ] as const) {
    const { drawn, landed } = handover(firstMs, secondMs);
    assertEased(drawn);
    const settled = landed + INTERP_DELAY_MS + 1000 / SNAPSHOT_HZ;
    const after = drawn.filter((frame) => frame.at >= settled);
    assert.ok(after.length > 30, `the second host's frames were drawn (${after.length})`);
    assert.ok(
      extrapolated(after) <= 0,
      `render time ran ${extrapolated(after).toFixed(1)} ms past`,
    );
    assert.ok(
      overshoot(after) < 0.005,
      `drawn ${overshoot(after).toFixed(3)} past the host's body`,
    );
  }
});

test("the stamps run on through a quick host change: what the old host queued still plays", () => {
  // The second host takes the very next frame, so the first host's last rows
  // are still queued when the second's arrive. On one clock they play out in
  // order; on a clock of its own the new host's rows would wait behind them.
  const first = { from: 0, id: "first", link: peer(21, -4321.5, 25, 12), until: 1500 };
  const second = { from: 1500, id: "second", link: peer(43, -55_555.75, 30, 12), until: Infinity };
  const hurtAt = 1600;
  const { drawn, runner } = watchRunner(
    [first, second],
    peer(31, -98_765.25, 25, 12),
    () => 1,
    hurtAt,
  );
  // The new host's hit shows within the relay, the render delay and a frame or two.
  const shown = drawn.find((frame) => frame.at >= hurtAt && frame.hp === runner.hp)?.at;
  assert.ok(shown !== undefined && shown - hurtAt < 400, `the hit showed after ${shown} ms`);
});

test("a frame for eight brawlers in the thick of it stays well under 1.5 KB", () => {
  const host = stubGame("host");
  const kits: BrawlerId[] = ["dusty", "ace", "fuse", "titan", "rowan", "nyx", "moss", "flint"];
  const rng = seededRandom(9);
  for (const [i, kit] of kits.entries()) {
    const human = i < 3;
    // Party ids are UUIDs: the longest strings a row could carry, if rows carried them.
    const owner = `0b8e5f0e-6c1a-4f2b-9d3e-7a4c5b6d7e8${i}`;
    const b = body(
      host,
      {
        name: human ? `Player ${i}` : `Bot ${i}`,
        netId: human ? `p:${owner}` : `bot:${i}`,
        owner: human ? owner : null,
        x: -18 + rng() * 36,
        z: -18 + rng() * 36,
      },
      kit,
    );
    b.facing = -3 + rng() * 6;
    b.hp = Math.round(b.maxHp * (0.2 + rng() * 0.8));
    b.ammo = Math.floor(rng() * 3);
    b.reloadT = rng();
    b.superCharge = rng();
    b.cubes = Math.floor(rng() * 6);
    b.kills = Math.floor(rng() * 4);
    b.evadeCooldown = rng() * EVADE.cooldown;
    if (human) {
      b.ack.take(40_000 + i, 1000);
      b.evadeResult = -(39_000 + i);
      b.applyKnock(-4.2, 3.7);
    }
  }
  const [dusty, ace, , titan, , nyx, moss, flint] = host.brawlers;
  const { super: slam } = BRAWLERS.titan;
  assert.ok(dusty && ace && titan && nyx && moss && flint && slam.kind === "leap");
  // A pose in flight on six bodies: a swing, a volley, a leap, a roll, two shots.
  dusty.meleeCue = { angle: 1.2, elapsed: 0.1, recovery: 0.42, windup: 0.2 };
  ace.rangedCue = { elapsed: 0.05, isSuper: false };
  titan.leap = { a: slam, sx: 1, sz: 2, t: 0.3, tx: 6, tz: -3 };
  nyx.evasion = { angle: -2.1, elapsed: 0.2 };
  moss.rangedCue = { elapsed: 0.12, isSuper: true };
  flint.rangedCue = { elapsed: 0.3, isSuper: false };
  const frame = encodeFrame(host, 123_456, 3, SERVER_EPOCH + 98_765_432.6, 5_400_000);
  const bytes = JSON.stringify(frame).length;
  const match = encodeMatch(host.brawlers, host.generation, 123_456_789, null, 3);
  const rosterBytes = JSON.stringify(match).length;
  console.log(`netcode-smoke: frame ${bytes} B for 8 brawlers; roster ${rosterBytes} B, on change`);
  assert.ok(bytes < 1000, `a busy frame fits a kilobyte (${bytes} B)`);
  const roster = parseMatch(overTheWire(match));
  const wireFrame = parseFrame(overTheWire(frame));
  assert.ok(roster && wireFrame);
  const decoded = decodeFrame(wireFrame, roster);
  assert.equal(decoded?.brawlers.length, 8, "and it decodes against its roster");
  assert.deepEqual(decoded?.brawlers[3]?.leap, { sx: 1, sz: 2, t: 0.3, tx: 6, tz: -3 });
});
