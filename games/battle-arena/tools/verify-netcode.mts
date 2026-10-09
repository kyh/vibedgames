// Headless host + guest over a simulated network (latency, jitter, in-order
// delivery like a WebSocket): the netcode end to end, no DOM or renderer.
// The guest runs the same pieces the scene wires up — NetMirror for the
// host's frames, OwnHeroPredictor for its own hero — and the host runs
// HostNet over the real sim.
import assert from "node:assert/strict";
import { test } from "node:test";
import { netStats } from "@vibedgames/multiplayer";
import { isJsonNumber, isJsonObject } from "../src/data/json.ts";
import { SPAWNS, CAMPS } from "../src/data/map.ts";
import { HostNet } from "../src/net/host-net.ts";
import type { HostLink } from "../src/net/host-net.ts";
import { inputWire, parseInput } from "../src/net/input.ts";
import { NetMirror, parseFrame } from "../src/net/mirror.ts";
import { OwnHeroPredictor } from "../src/net/own-hero.ts";
import type { HeldInput } from "../src/net/own-hero.ts";
import { emptyGuestWorld, encodeWorld, isSnapshot } from "../src/net/snapshot.ts";
import type { Frame, Snapshot } from "../src/net/snapshot.ts";
import { applyKnockback, handleDeath } from "../src/sim/combat.ts";
import { createWorld, ensureBots, setHeroInput, spawnHero } from "../src/sim/world.ts";
import type { Unit, World } from "../src/sim/types.ts";
import { Pipe, noise, sharedCopy } from "./net-sim.mts";

const GUEST = "guest";
const HOST = "host";

interface MatchOptions {
  oneWayMs?: number;
  jitterMs?: number;
  hostFps?: number;
  guestFps?: number;
  bots?: boolean;
}

const OPEN_GROUND = { x: -6, y: 16 };

const ignoreFrame = (_me: Unit | null): void => {
  /* empty */
};

/** A two-player online match: the host plays slot 0, the guest slot 1. */
const match = (opts: MatchOptions = {}) => {
  const world = createWorld(7);
  if (!opts.bots) {
    // keep skeleton camps out of the way (never spawn)
    for (const c of CAMPS) {
      world.campRespawnAt[c.id] = 9e8;
    }
  }
  const hero = (owner: string, slot: number): Unit =>
    spawnHero(world, {
      champId: "knight",
      id: `h-${owner}`,
      isBot: false,
      name: owner,
      ownerId: owner,
      slot,
      team: owner,
    });
  const hostHero = hero(HOST, 0);
  const guestHero = hero(GUEST, 1);
  if (opts.bots) {
    ensureBots(world);
  }
  const toGuest = new Pipe(opts.oneWayMs ?? 60, opts.jitterMs ?? 40, 1);
  const toHost = new Pipe(opts.oneWayMs ?? 60, opts.jitterMs ?? 40, 2);
  const hostNet = new HostNet();
  const guestWorld = emptyGuestWorld();
  let now = 5000;
  const mirror = new NetMirror();
  mirror.ownId = guestHero.id;
  const predictor = new OwnHeroPredictor();
  const held: HeldInput = { attack: false, ax: 1, ay: 0, mx: 0, my: 0 };
  const frames: Frame[] = [];
  // the room's shared state: the host's copy and the guest's, in step by ops
  const hostRoom = sharedCopy();
  const guestRoom = sharedCopy();
  let snapshots = 0;
  let snapshotBytes = 0;
  // every snapshot the host wrote, beside a copy taken as it wrote it: the
  // SDK reads a write when the task ends and keeps it as the room's state
  const written: { snap: Snapshot; copy: Snapshot }[] = [];
  let fxSent = 0;
  let fxReceived = 0;
  const link: HostLink = {
    inputHero: (owner) => {
      const u = world.units.get(`h-${owner}`);
      return owner !== HOST && u?.alive && world.phase === "playing" ? u : null;
    },
    // one process plays both ends: the room's server clock is the harness clock
    now: () => now,
    publish: (snap, t) => {
      snapshots += 1;
      snapshotBytes = JSON.stringify(snap).length;
      written.push({ copy: structuredClone(snap), snap });
      toGuest.send(now, { kind: "state", ops: hostRoom.write({ snap, snapT: t }) });
    },
    sendFrame: (frame) => {
      frames.push(frame);
      fxSent += frame.fx?.length ?? 0;
      toGuest.send(now, { frame, kind: "frame" });
    },
  };

  const hostDt = 1000 / (opts.hostFps ?? 60);
  const guestDt = 1000 / (opts.guestFps ?? 60);
  let nextHost = now;
  let nextGuest = now;
  /** Called after every guest frame (render pose on `me` already). */
  let onGuestFrame = ignoreFrame;

  const guestFrame = (): void => {
    for (const message of toGuest.receive(now)) {
      if (!isJsonObject(message)) {
        continue;
      }
      if (message["kind"] === "state") {
        // as the scene adopts a snapshot: read straight off the room's state
        guestRoom.apply(message["ops"] ?? null);
        const { snap, snapT } = guestRoom.state;
        if (isSnapshot(snap)) {
          // the guest hears the stream from its first frame: every snapshot is live
          mirror.applySnapshot(guestWorld, snap, isJsonNumber(snapT) ? snapT : null, now, true);
        }
      } else {
        const frame = parseFrame(message["frame"] ?? null);
        if (frame) {
          fxReceived += frame.fx?.length ?? 0;
          const own = mirror.applyFrame(guestWorld, frame, now);
          if (own) {
            predictor.hostUpdate(own);
          }
        }
      }
    }
    mirror.render(guestWorld, now);
    guestWorld.fx.length = 0;
    const me = guestWorld.units.get(guestHero.id) ?? null;
    if (me && guestWorld.phase === "playing") {
      predictor.advance(me, guestWorld.units, guestDt, now, guestWorld.now, held, (p) =>
        toHost.send(now, inputWire(p)),
      );
      predictor.render(me, guestWorld.units, held);
    }
    onGuestFrame(me);
  };

  const hostFrame = (): void => {
    for (const message of toHost.receive(now)) {
      const packet = isJsonObject(message) ? parseInput(message) : null;
      if (packet) {
        hostNet.receive(GUEST, packet);
      }
    }
    hostNet.advance(world, hostDt, link);
    // the host's renderer drains World.fx every frame
    world.fx.length = 0;
  };

  /** Run both clients — or only the guest, the host gone quiet — for `ms` of wall time. */
  const run = (ms: number, hostRuns = true): void => {
    const end = now + ms;
    while (now < end) {
      now = hostRuns ? Math.min(nextHost, nextGuest) : nextGuest;
      if (hostRuns && nextHost <= now) {
        hostFrame();
        nextHost += hostDt;
      }
      if (nextGuest <= now) {
        guestFrame();
        nextGuest += guestDt;
      }
    }
    nextHost = Math.max(nextHost, now);
  };

  return {
    frames,
    get fxReceived() {
      return fxReceived;
    },
    get fxSent() {
      return fxSent;
    },
    guestHero,
    /** What `sharedState` reads on the guest, and on the host. */
    get guestRoom() {
      return guestRoom.state;
    },
    guestWorld,
    held,
    hostHero,
    hostNet,
    get hostRoom() {
      return hostRoom.state;
    },
    me: () => guestWorld.units.get(guestHero.id) ?? null,
    get now() {
      return now;
    },
    onGuestFrame: (fn: (me: Unit | null) => void) => {
      onGuestFrame = fn;
    },
    predictor,
    run,
    get snapshotBytes() {
      return snapshotBytes;
    },
    get snapshots() {
      return snapshots;
    },
    toGuest,
    toHost,
    world,
    written,
  };
};

type Match = ReturnType<typeof match>;

/** Park the guest hero on open ground, facing +x, and let both sides settle. */
const settle = (m: Match): void => {
  Object.assign(m.guestHero, { aimX: 1, aimY: 0, facing: 0, x: OPEN_GROUND.x, y: OPEN_GROUND.y });
  m.run(1500);
};

test("guest hero moves on the input frame and never rubber-bands", () => {
  const m = match({ jitterMs: 50, oneWayMs: 70 });
  settle(m);
  const me = m.me();
  assert.ok(me, "guest sees its hero");
  assert.ok(
    Math.hypot(me.x - OPEN_GROUND.x, me.y - OPEN_GROUND.y) < 0.05,
    "settled at the host's spot",
  );

  let frame = 0;
  let firstMoveFrame = -1;
  let worstPending = 0;
  const startX = me.x;
  m.onGuestFrame((u) => {
    frame += 1;
    if (u && firstMoveFrame === -1 && u.x > startX + 1e-4) {
      firstMoveFrame = frame;
    }
    worstPending = Math.max(worstPending, m.predictor.correction);
  });
  m.held.mx = 1;
  m.run(1000 / 60);
  assert.equal(firstMoveFrame, 1, "the body answers the key the frame it goes down");
  const hostBefore = m.guestHero.x;
  // a whole round trip later the host has not even heard of it yet
  m.run(80);
  assert.ok(Math.abs(m.guestHero.x - hostBefore) < 1e-9, "host still waiting while the guest runs");
  m.run(1500);
  // weave and stop: every change must reach the host on the tick spacing it
  // was predicted on, or a hold lasts a tick longer there than here
  const moves = [
    [1, 0.6],
    [0, 0],
    [1, -0.6],
    [0.4, 1],
    [0, 0],
    [1, 0],
  ];
  for (const [i, [mx, my]] of moves.entries()) {
    const len = Math.hypot(mx ?? 0, my ?? 0) || 1;
    m.held.mx = (mx ?? 0) / len;
    m.held.my = (my ?? 0) / len;
    m.run(110 + i * 37);
  }
  m.held.mx = 0;
  m.held.my = 0;
  m.run(1500);
  // The host's position always lay on the predicted path: nothing to correct.
  assert.equal(worstPending, 0, "no correction while running, weaving or stopping");
  const after = m.me();
  assert.ok(after);
  const gap = Math.hypot(after.x - m.guestHero.x, after.y - m.guestHero.y);
  assert.ok(gap < 0.02, `predicted body rests where the host has it (${gap.toFixed(4)})`);
  assert.ok(m.guestHero.x - startX > 8, "the host really ran the hero");
});

test("hop and dash are predicted on the press and land where the host lands them", () => {
  const m = match({ jitterMs: 40, oneWayMs: 60 });
  settle(m);
  const me = m.me();
  assert.ok(me);
  m.predictor.pending.jump = true;
  m.held.mx = 1;
  m.run(40);
  assert.ok(m.guestWorld.now < me.jumpUntil, "airborne before the host hears of it");
  m.run(1200);
  m.predictor.pending.dash = { x: 0, y: -1 };
  m.run(40);
  const mid = m.me();
  assert.ok(mid && mid.dashUntil > m.guestWorld.now, "dashing at once");
  m.held.mx = 0;
  m.run(1500);
  const end = m.me();
  assert.ok(end);
  const gap = Math.hypot(end.x - m.guestHero.x, end.y - m.guestHero.y);
  assert.ok(gap < 0.08, `predicted hop+dash agree with the host (${gap.toFixed(4)})`);
  assert.ok(m.guestHero.dashUntil > 0 && m.guestHero.jumpUntil > 0, "the host ran both");
});

test("a respawn snaps the predicted hero home; knockback and blinks converge", () => {
  const m = match();
  settle(m);
  handleDeath(m.world, m.guestHero, null);
  let respawnFrameGap = -1;
  let wasAlive = true;
  m.onGuestFrame((u) => {
    if (u && u.alive && !wasAlive && respawnFrameGap < 0) {
      const [, spawn] = SPAWNS;
      assert.ok(spawn);
      respawnFrameGap = Math.hypot(u.x - spawn.x, u.y - spawn.y);
    }
    wasAlive = u?.alive ?? wasAlive;
  });
  m.run(5000);
  assert.ok(respawnFrameGap >= 0, "the guest saw the respawn");
  assert.ok(respawnFrameGap < 0.3, `drawn at the spawn on the respawn frame (${respawnFrameGap})`);
  m.onGuestFrame(ignoreFrame);

  Object.assign(m.guestHero, { x: OPEN_GROUND.x, y: OPEN_GROUND.y });
  m.run(1500);
  // a hard shove the guest could not predict
  applyKnockback(m.guestHero, m.guestHero.x - 1, m.guestHero.y, 40, m.world);
  m.run(800);
  const shoved = m.me();
  assert.ok(shoved);
  const shoveGap = Math.hypot(shoved.x - m.guestHero.x, shoved.y - m.guestHero.y);
  assert.ok(m.guestHero.x - OPEN_GROUND.x > 0.8, "the shove moved the hero on the host");
  assert.ok(shoveGap < 0.08, `knockback converged (${shoveGap.toFixed(4)})`);

  // a teleport (an item blink) is beyond the snap distance: one step, no glide
  m.guestHero.x += 8;
  let firstSeen = -1;
  m.onGuestFrame((u) => {
    if (u && firstSeen < 0 && u.x > m.guestHero.x - 1) {
      firstSeen = m.now;
    }
  });
  m.run(600);
  const blinked = m.me();
  assert.ok(blinked && firstSeen > 0, "the guest followed the blink");
  assert.ok(Math.abs(blinked.x - m.guestHero.x) < 0.08, "and rests on it");
});

test("remote bodies move smoothly through jitter; nothing is lost", () => {
  const m = match({ jitterMs: 60, oneWayMs: 50 });
  settle(m);
  Object.assign(m.hostHero, { aimX: 1, aimY: 0, x: -12, y: 22 });
  m.run(500);
  setHeroInput(m.hostHero, 1, 0, 1, 0, false);
  m.run(800);
  const steps: number[] = [];
  let prev: number | null = null;
  m.onGuestFrame(() => {
    const remote = m.guestWorld.units.get(m.hostHero.id);
    if (remote) {
      if (prev !== null) {
        steps.push(remote.x - prev);
      }
      prev = remote.x;
    }
  });
  m.run(1500);
  setHeroInput(m.hostHero, 0, 0, 1, 0, false);
  const speed = (m.hostHero.moveSpeed * (1000 / 60)) / 1000;
  for (const s of steps) {
    assert.ok(Math.abs(s - speed) < speed * 0.25, `steady per-frame motion (${s} vs ${speed})`);
  }
  // a tap shorter than a tick still reaches the host (and swings once)
  const swings = m.guestHero.swingCount;
  m.predictor.pending.attackEdge = true;
  m.run(600);
  assert.equal(m.guestHero.swingCount, swings + 1, "one click, one swing");
  m.run(500);
  assert.equal(m.fxReceived, m.fxSent, "every fx the host sent arrived");
});

test("a jittery route draws remote bodies further back instead of running them dry", () => {
  // frames land up to 150 ms after the fastest: past what INTERP_DELAY_MS covers
  const m = match({ jitterMs: 150, oneWayMs: 80 });
  settle(m);
  // the clock measures what the stream needs
  m.run(5000);
  const before = netStats();
  m.run(10_000);
  const after = netStats();
  const frames = after.frames - before.frames;
  const starved = (after.starved - before.starved) / frames;
  assert.ok(frames >= 590, `the host's hero drawn every frame (${frames})`);
  assert.ok(
    starved < 0.03,
    `drawn past the newest frame ${(starved * 100).toFixed(1)}% of the time`,
  );
});

test("a host below 30 fps keeps real time; payload stays small", () => {
  const m = match({ bots: true, hostFps: 20 });
  const start = m.world.now;
  m.run(30_000);
  const simMs = m.world.now - start;
  assert.ok(Math.abs(simMs - 30_000) < 100, `host sim kept wall-clock pace (${simMs} ms in 30 s)`);
  // two ticks run in one 50 ms frame are stamped with the server time each
  // stands for, so guests see an even 30 Hz however the host's frames fall
  const gaps = new Set(m.frames.slice(1).map((f, i) => f.t - (m.frames[i]?.t ?? 0)));
  assert.deepEqual([...gaps].toSorted(), [33, 34], `ticks stamped a tick apart (${[...gaps]})`);
  // what the old netcode sent every broadcast: the whole World, plain JSON
  const oldBytes = JSON.stringify({
    ...m.world,
    fx: [],
    projectiles: Object.fromEntries(m.world.projectiles),
    units: Object.fromEntries(m.world.units),
  }).length;
  const sizes = m.frames.slice(1).map((f) => JSON.stringify(f).length);
  sizes.sort((a, b) => a - b);
  const avg = sizes.reduce((sum, n) => sum + n, 0) / sizes.length;
  const p99 = sizes[Math.floor(sizes.length * 0.99)] ?? 0;
  const perSecond = m.toGuest.bytes / 30;
  console.log(
    `  payload: old snapshot ${oldBytes} B × 15 Hz; frame avg ${Math.round(avg)} B, p99 ${p99} B × 30 Hz; full snapshot ${m.snapshotBytes} B × 1 Hz; ${Math.round(perSecond / 1024)} KB/s per guest`,
  );
  assert.ok(avg < 1000, `frames average under 1 KB (${avg})`);
  assert.ok(p99 < 3000, `frames stay under 3 KB (p99 ${p99})`);
  assert.ok(m.snapshotBytes < oldBytes / 2, "the full snapshot is compact too");
  assert.ok(perSecond < (oldBytes * 15) / 20, "at least 20× less traffic than before");
  assert.ok(m.snapshots >= 29 && m.snapshots <= 32, `~1 Hz full snapshots (${m.snapshots})`);
});

/** The mirror rebuilds the host's world: everything a guest draws matches. */
const sameView = (host: World, guest: World): void => {
  for (const u of host.units.values()) {
    const g = guest.units.get(u.id);
    assert.ok(g, `guest has ${u.id}`);
    assert.equal(g.alive, u.alive, `${u.id} alive`);
    assert.equal(Math.ceil(g.hp), Math.ceil(u.hp), `${u.id} hp`);
    assert.equal(Math.floor(g.gold), Math.floor(u.gold), `${u.id} gold`);
    assert.deepEqual(g.items, u.items, `${u.id} items`);
    assert.deepEqual(
      g.statuses.map((s) => s.kind),
      u.statuses.map((s) => s.kind),
    );
  }
  assert.equal(guest.units.size, host.units.size);
  assert.equal(guest.phase, host.phase);
  for (const key of ["grounds", "coins", "deliveries"] as const) {
    assert.deepEqual(
      guest[key].map((item) => item.id),
      host[key].map((item) => item.id),
      key,
    );
  }
  assert.deepEqual(
    [...guest.projectiles.keys()].toSorted(),
    [...host.projectiles.keys()].toSorted(),
    "projectiles",
  );
};

test("frames keep a guest's world in step with the host's through a busy match", () => {
  const m = match({ bots: true });
  for (let i = 0; i < 8; i += 1) {
    m.run(2500 + i * 377);
    // the host pauses mid-stream: once its last frames land, the guest's world
    // is the host's — from deltas alone between the 1 Hz snapshots
    m.run(400, false);
    sameView(m.world, m.guestWorld);
    // nothing the guest did to its world reached its copy of the room, which
    // the next snapshot's ops build on
    assert.deepEqual(m.guestRoom, m.hostRoom, "the guest's copy of the room is the host's");
  }
  // nor did the host's sim reach what it wrote, which the SDK holds as the
  // room's state (and re-sends from, back from a drop) under that write's stamp
  assert.ok(m.written.length >= 25, `snapshots written (${m.written.length})`);
  for (const { snap, copy } of m.written) {
    assert.deepEqual(snap, copy, `the snapshot at ${Math.round(copy.now)} ms stays as written`);
  }
});

/** Host B's frames: 40 ms further away than host A's, sent from 400 ms after A's last. */
const routeB = (i: number) => {
  const sent = 1_000_000 + 90 * 33 + 400 + i * 33;
  return { at: sent - 1_000_000 + 100 + noise(i + 500) * 80, sent };
};

/** A mirror fed bare frames: only their stamps and arrival times count here. */
const stampedStream = () => {
  const mirror = new NetMirror();
  const world = emptyGuestWorld();
  return {
    /** A frame stamped `sent` (server time) lands at local time `at`. */
    arrive: (sent: number, at: number): void => {
      mirror.applyFrame(world, { gt: 0, n: 0, t: sent }, at);
    },
    /** A render at local time `at`, which reads the clock. */
    draw: (at: number): void => {
      mirror.render(world, at);
    },
    mirror,
  };
};

test("the mirror clock is server time less the fastest recent trip, re-learned per host", () => {
  // the room's server clock as this guest measures it: the local clock until
  // the first probe returns, a million ms ahead of it from then on
  let synced = false;
  const server = {
    now: (localNow = 0) => localNow + (synced ? 1_000_000 : 0),
    get synced() {
      return synced;
    },
  };
  /** How far behind server time a mirror's clock reads at local time `at`. */
  const tripAt = (mirror: NetMirror, at: number): number => server.now(at) - mirror.clock.now(at);
  // a frame that lands before the server clock is measured teaches the clock
  // all the same: it learns from local arrival times, never that measurement,
  // and only the trip the mirror reports waits for it
  const early = stampedStream();
  early.arrive(1_000_000, 50);
  early.draw(50);
  assert.equal(early.mirror.trip(server), 0, "no trip to report on an unmeasured server clock");
  synced = true;
  assert.equal(early.mirror.trip(server), 50, "an unsynced server clock teaches nothing wrong");
  // frames alone teach it: the snapshot found on joining puts bodies on screen
  // with its own stamp, which is as old as the snapshot, not one trip
  const room = createWorld(7);
  ensureBots(room);
  const joined = new NetMirror();
  const copy = emptyGuestWorld();
  joined.applySnapshot(copy, encodeWorld(room), 1_000_000, 900, false);
  joined.render(copy, 900);
  assert.ok(
    [...copy.units.values()].some((u) => u.kind === "hero"),
    "bodies drawn from it",
  );
  assert.equal(joined.clock.synced, false, "the snapshot found on joining teaches nothing");
  // host A: trips of 60-140 ms; the fastest defines the clock
  const guest = stampedStream();
  for (let i = 0; i < 90; i += 1) {
    const sent = 1_000_000 + i * 33;
    guest.arrive(sent, sent - 1_000_000 + 60 + noise(i) * 80);
  }
  const atA = 90 * 33 + 200;
  guest.draw(atA);
  const tripA = tripAt(guest.mirror, atA);
  assert.equal(guest.mirror.trip(server), Math.round(tripA), "the trip reported is the one drawn");
  assert.ok(tripA >= 60 && tripA < 65, `fastest trip (${tripA.toFixed(1)} ms)`);
  // host B takes over 400 ms later on the same server clock, 40 ms further
  // away: the clock carries on, and only the route is learned afresh — the
  // window alone would hold on to A's faster trips for seconds
  const stale = stampedStream();
  for (let i = 0; i < 90; i += 1) {
    const sent = 1_000_000 + i * 33;
    stale.arrive(sent, sent - 1_000_000 + 60 + noise(i) * 80);
  }
  const { clock } = guest.mirror;
  const before = clock.now(atA + 1);
  clock.relearn();
  assert.equal(clock.now(atA + 1), before, "re-learning moves nothing drawn");
  for (let i = 0; i < 20; i += 1) {
    const { at, sent } = routeB(i);
    for (const stream of [guest, stale]) {
      stream.arrive(sent, at);
      stream.draw(at);
    }
  }
  const atB = routeB(19).at;
  const learned = tripAt(guest.mirror, atB);
  assert.ok(learned >= 100, `new route learned within a second (${learned.toFixed(1)} ms)`);
  const trusted = tripAt(stale.mirror, atB);
  assert.ok(trusted < 70, `the window alone still trusts the old one (${trusted.toFixed(1)})`);
  for (let i = 20; i < 200; i += 1) {
    const { at, sent } = routeB(i);
    guest.arrive(sent, at);
    guest.draw(at);
  }
  const kept = tripAt(guest.mirror, routeB(199).at);
  assert.ok(kept >= 100 && kept < 105, `and kept (${kept.toFixed(1)} ms)`);
  // a host whose own clock is not yet synced stamps its local time, ages
  // before any real stamp: it never undercuts a real one in the window
  const wildAt = 90 * 33 + 400 + 200 * 33 + 120;
  guest.arrive(5, wildAt);
  guest.draw(wildAt);
  const wild = tripAt(guest.mirror, wildAt);
  assert.ok(wild >= 100 && wild < 105, `a wild stamp is ignored (${wild.toFixed(1)} ms)`);
});
