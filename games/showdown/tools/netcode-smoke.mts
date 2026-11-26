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
  const hostLink = peer(seed * 10, -4321.5, HOP_MS, HOP_JITTER_MS);
  const guestLink = peer(seed * 10 + 5, -98_765.25, HOP_MS, HOP_JITTER_MS);
  const up = wire(guestLink.up, hostLink.down);
  const down = wire(hostLink.up, guestLink.down);
  const frameRng = seededRandom(seed * 7 + 3);
  const roster = parseMatch(overTheWire(encodeMatch(host.brawlers, 1, 7, null, 1)));
  assert.ok(roster);
  const errors: number[] = [];
  const frames: { now: number; pressing: boolean; x: number }[] = [];

  const state = {
    copy,
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
      sendIntent: (intent) => {
        up.send(state.now, JSON.stringify(intent));
      },
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

  const hostStep = () => {
    const dt = HOST_FRAME_MS / 1000;
    const stepStart = host.elapsed;
    host.elapsed += dt;

    for (const data of up.take(state.now)) {
      const intent = parseIntent(parseJson(data));

      if (!intent || (intent.kind === "evade" && state.dropEvades)) {
        continue;
      }

      if (intent.kind === "evade" && state.refuseEvades) {
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

  const guestStep = (controls: Controls, frameMs: number) => {
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

  const run = (until: number, controls: (now: number) => Controls = () => IDLE) => {
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
  const minUp = Math.min(...state.up.delays);
  const maxUp = Math.max(...state.up.delays);

  for (const lead of leads) {
    assert.ok(lead > DEAD_ZONE, `lead ${lead.toFixed(3)} exceeds the dead zone`);
    assert.ok(lead >= (SPEED * (minUp - HOST_FRAME_MS)) / 1000, `lead ${lead.toFixed(3)}`);
    assert.ok(lead <= (SPEED * (maxUp + 22)) / 1000, `lead ${lead.toFixed(3)}`);
  }

  assert.ok(Math.max(...leads) - Math.min(...leads) < 0.15, "the lead holds steady");
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
  const furthest = Math.max(...state.frames.map((frame) => frame.x));
  assert.ok(furthest < shove + 0.05, `slid as far as ${furthest.toFixed(3)}`);
  assert.ok(Math.max(...state.errors) <= DEAD_ZONE, "the host never had to correct it");
});

interface Sender {
  from: number;
  id: string;
  link: Peer;
  until: number;
}

const senderAt = (senders: readonly Sender[], at: number) =>
  senders.find((sender) => at >= sender.from && at < sender.until);

const zigzag = (at: number) => (Math.floor(at / 400) % 2 === 0 ? 1 : -1);

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

  const clock = new FrameClock();
  const track = new PuppetTrack(clock);
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

  const drawn: {
    ahead: number;
    at: number;
    hold: number;
    hp: number;
    past: number;
    render: number;
    x: number;
  }[] = [];

  const went = { max: runner.x, min: runner.x };
  let newest = Number.NEGATIVE_INFINITY;
  const sent: { hp: number; t: number; x: number }[] = [];

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
        sent.push({ hp: runner.hp, t, x: runner.x });
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
    track.pose(puppet, local, openWorld);
    const renderAt = clock.renderTime(local);

    if (Number.isFinite(newest)) {
      drawn.push({
        ahead: renderAt - newest,
        at: guestAt,
        hold: clock.hold(local),
        hp: puppet.hp,
        past: Math.max(puppet.x - went.max, went.min - puppet.x),
        render: renderAt,
        x: puppet.x,
      });
    }

    const frameMs = 12 + frameRng() * 10;

    if (guestAt > 600) {
      steps.push({ dt: frameMs, dx: puppet.x - before });
      trails.push(runner.x - puppet.x);
    }

    guestAt += frameMs;
  }

  const local = viewer.clock.local(guestAt);
  const behindMs = viewer.clock.server.now(local) - clock.now(local);
  const hit = sent.find((frame) => frame.hp < runner.maxHp);

  return { behindMs, drawn, firstLanded, hit, route, runner, steps, trails };
};

const assertEven = (steps: readonly { dt: number; dx: number }[]) => {
  const { speed } = BRAWLERS.nyx;

  for (let i = 1; i < steps.length; i += 1) {
    const step = steps[i];
    const span = steps[i - 1]?.dt ?? 0;
    assert.ok(step);
    const expected = (speed * span) / 1000;
    assert.ok(Math.abs(step.dx - expected) < expected * 0.2, `step ${step.dx} vs ${expected}`);
  }
};

const overshoot = (drawn: readonly { past: number }[]) =>
  Math.max(0, ...drawn.map((frame) => frame.past));

const extrapolated = (drawn: readonly { ahead: number }[]) =>
  Math.max(...drawn.map((frame) => frame.ahead));

const EASE = 0.1;

const assertEased = (drawn: readonly { at: number; render: number }[]) => {
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
  const fastest = Math.min(...route.delays);
  assert.ok(
    Math.abs(behindMs - fastest) < 12,
    `behind ${behindMs.toFixed(1)} vs ${fastest.toFixed(1)}`,
  );
  const { speed } = BRAWLERS.nyx;
  const meanTrail = trails.reduce((sum, d) => sum + d, 0) / trails.length;
  const expectedTrail = (speed * (INTERP_DELAY_MS + fastest)) / 1000;
  assert.ok(Math.abs(meanTrail - expectedTrail) < 0.25, `trail ${meanTrail} vs ${expectedTrail}`);
  assert.ok(Math.max(...trails) - Math.min(...trails) < 0.3, "the trail holds steady");
});

test("through a 100–150 ms relay a turning body is never drawn past where it went", () => {
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
  const { drawn, landed } = handover(25, 145);
  assertEased(drawn);
  const settled = landed + 120 / EASE + INTERP_DELAY_MS + 1000 / SNAPSHOT_HZ;
  const after = drawn.filter((frame) => frame.at >= settled);
  assert.ok(after.length > 30, `the second host's frames were drawn (${after.length})`);
  assert.ok(extrapolated(after) <= 0, `render time ran ${extrapolated(after).toFixed(1)} ms past`);
  assert.ok(overshoot(after) < 0.005, `drawn ${overshoot(after).toFixed(3)} past the host's body`);
});

test("a host change onto a route a few tens of ms off never jumps render time, and remotes stay interpolated", () => {
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
  const first = { from: 0, id: "first", link: peer(21, -4321.5, 25, 12), until: 1500 };
  const second = { from: 1500, id: "second", link: peer(43, -55_555.75, 30, 12), until: Infinity };
  const hurtAt = 1600;

  const { drawn, runner } = watchRunner(
    [first, second],
    peer(31, -98_765.25, 25, 12),
    () => 1,
    hurtAt,
  );

  const shown = drawn.find((frame) => frame.at >= hurtAt && frame.hp === runner.hp)?.at;
  assert.ok(shown !== undefined && shown - hurtAt < 400, `the hit showed after ${shown} ms`);
});

test("over a jittery relay a hit shows, with its fx, when the body drawn gets to where it was hit", () => {
  const host = { from: 0, id: "host", link: peer(21, -4321.5, 160, 40), until: Infinity };
  const { drawn, hit, runner } = watchRunner([host], peer(31, -98_765.25, 160, 40), () => 1, 1500);
  assert.ok(hit);
  const shown = drawn.findIndex((frame) => frame.hp < runner.maxHp);
  const at = drawn[shown];
  const before = drawn[shown - 1];
  assert.ok(at && before, "the hit was drawn");
  assert.ok(at.hold > INTERP_DELAY_MS + 20, `the stream held ${at.hold.toFixed(0)} ms`);
  assert.ok(before.render < hit.t && at.render >= hit.t, "the row and its fx play together");
  const step = (BRAWLERS.nyx.speed * 25) / 1000;
  assert.ok(
    at.x >= hit.x - 0.01 && at.x - hit.x <= step,
    `drawn at ${at.x.toFixed(3)} for a hit at ${hit.x.toFixed(3)}`,
  );
});

test("a frame for eight brawlers in the thick of it stays well under 1.5 KB", () => {
  const host = stubGame("host");
  const kits: BrawlerId[] = ["dusty", "ace", "fuse", "titan", "rowan", "nyx", "moss", "flint"];
  const rng = seededRandom(9);

  for (const [i, kit] of kits.entries()) {
    const human = i < 3;
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
