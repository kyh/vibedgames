// Headless host + guest over a simulated network (latency, jitter, in-order
// delivery like a WebSocket): the netcode end to end, no DOM or renderer.
// The guest runs the same pieces the scene wires up — NetMirror for the
// host's frames, OwnHeroPredictor for its own hero — and the host runs
// HostNet over the real sim.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "../src/data/json.ts";
import { isJsonNumber, isJsonObject } from "../src/data/json.ts";
import { SPAWNS, CAMPS } from "../src/data/map.ts";
import { ArrivalClock } from "../src/net/arrival-clock.ts";
import { HostNet } from "../src/net/host-net.ts";
import type { HostLink } from "../src/net/host-net.ts";
import { inputWire, parseInput } from "../src/net/input.ts";
import { NetMirror, parseFrame } from "../src/net/mirror.ts";
import { OwnHeroPredictor } from "../src/net/own-hero.ts";
import type { HeldInput } from "../src/net/own-hero.ts";
import { emptyGuestWorld, isSnapshot } from "../src/net/snapshot.ts";
import type { Frame } from "../src/net/snapshot.ts";
import { applyKnockback, handleDeath } from "../src/sim/combat.ts";
import { createWorld, ensureBots, setHeroInput, spawnHero } from "../src/sim/world.ts";
import type { Unit, World } from "../src/sim/types.ts";

const GUEST = "guest";
const HOST = "host";

/** Deterministic noise in [0, 1). */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898 + 78.233) * 43_758.5453;
  return s - Math.floor(s);
};

/** One direction of a WebSocket: every message is delayed `oneWayMs` plus up
 *  to `jitterMs`, never overtakes the one before it (TCP bunches instead), and
 *  crosses as JSON. */
class Pipe {
  private readonly queue: { at: number; text: string }[] = [];
  private last = 0;
  private count = 0;
  private readonly oneWayMs: number;
  private readonly jitterMs: number;
  private readonly salt: number;
  bytes = 0;

  constructor(oneWayMs: number, jitterMs: number, salt: number) {
    this.oneWayMs = oneWayMs;
    this.jitterMs = jitterMs;
    this.salt = salt;
  }

  send(now: number, message: JsonValue): void {
    this.count += 1;
    const at = Math.max(
      this.last,
      now + this.oneWayMs + noise(this.count * 7 + this.salt) * this.jitterMs,
    );
    this.last = at;
    const text = JSON.stringify(message);
    this.bytes += text.length;
    this.queue.push({ at, text });
  }

  receive(now: number): JsonValue[] {
    const out: JsonValue[] = [];
    while (this.queue[0] && this.queue[0].at <= now) {
      const next = this.queue.shift();
      if (next) {
        out.push(JSON.parse(next.text));
      }
    }
    return out;
  }
}

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
  // one process plays both ends: the room's server clock is the harness clock
  const serverClock = { now: (localNow?: number) => localNow ?? now, synced: true };
  const mirror = new NetMirror(serverClock);
  mirror.ownId = guestHero.id;
  const predictor = new OwnHeroPredictor();
  const held: HeldInput = { attack: false, ax: 1, ay: 0, mx: 0, my: 0 };
  const frames: Frame[] = [];
  let snapshots = 0;
  let snapshotBytes = 0;
  let fxSent = 0;
  let fxReceived = 0;
  const link: HostLink = {
    inputHero: (owner) => {
      const u = world.units.get(`h-${owner}`);
      return owner !== HOST && u?.alive && world.phase === "playing" ? u : null;
    },
    now: () => now,
    publish: (snap, t) => {
      snapshots += 1;
      snapshotBytes = JSON.stringify(snap).length;
      toGuest.send(now, { kind: "snap", snap, t });
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
      if (message["kind"] === "snap") {
        const { snap, t } = message;
        if (isSnapshot(snap)) {
          mirror.applySnapshot(guestWorld, snap, isJsonNumber(t) ? t : null, now);
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
    guestWorld,
    held,
    hostHero,
    hostNet,
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
};

test("frames keep a guest's world in step with the host's through a busy match", () => {
  const m = match({ bots: true });
  for (let i = 0; i < 8; i += 1) {
    m.run(2500 + i * 377);
    // the host pauses mid-stream: once its last frames land, the guest's world
    // is the host's — from deltas alone between the 1 Hz snapshots
    m.run(400, false);
    sameView(m.world, m.guestWorld);
  }
});

test("the mirror clock is server time less the fastest recent trip, whoever sends", () => {
  let synced = false;
  const server = {
    now: (localNow?: number) => (localNow ?? 0) + 1_000_000,
    get synced() {
      return synced;
    },
  };
  const clock = new ArrivalClock(server);
  // before the server clock is measured there is no trip to learn
  clock.arrived(1_000_000, 50);
  assert.equal(clock.synced, false, "an unsynced server clock teaches nothing");
  synced = true;
  // host A: trips of 60-140 ms; the fastest defines the clock
  for (let i = 0; i < 90; i += 1) {
    const sent = 1_000_000 + i * 33;
    clock.arrived(sent, sent - 1_000_000 + 60 + noise(i) * 80);
  }
  const atA = 90 * 33 + 200;
  assert.ok(Math.abs(server.now(atA) - clock.now(atA) - clock.trip) < 1e-9);
  assert.ok(clock.trip >= 60 && clock.trip < 65, `fastest trip (${clock.trip.toFixed(1)} ms)`);
  // host B takes over 400 ms later on the same server clock, 40 ms further
  // away: no reset — the window learns the slower route within seconds
  for (let i = 0; i < 200; i += 1) {
    const sent = 1_000_000 + 90 * 33 + 400 + i * 33;
    const at = sent - 1_000_000 + 100 + noise(i + 500) * 80;
    clock.arrived(sent, at);
    clock.now(at);
  }
  assert.ok(
    clock.trip >= 100 && clock.trip < 105,
    `new route learned (${clock.trip.toFixed(1)} ms)`,
  );
  // a stamp from a host whose own clock is not yet synced is not a trip
  clock.arrived(5, 90 * 33 + 400 + 200 * 33 + 120);
  assert.ok(clock.trip >= 100, "a wild stamp is ignored");
});
