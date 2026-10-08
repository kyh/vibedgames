import assert from "node:assert/strict";
import { test } from "node:test";

import { ServerClock } from "@vibedgames/multiplayer";

import { SIM_DT } from "../src/data/config.ts";
import { restoreHostState } from "../src/net/host-state.ts";
import { isJsonObject } from "../src/net/json.ts";
import type { JsonValue } from "../src/net/json.ts";
import { GuestMirror } from "../src/net/mirror.ts";
import { HeroPredictor } from "../src/net/predict.ts";
import { parseIntent } from "../src/net/protocol.ts";
import type { Intent } from "../src/net/protocol.ts";
import { emptyGuestWorld, encodeWorld, sharedSnapAt, sharedSnapshot } from "../src/net/snapshot.ts";
import { TickEncoder, applyTick, parseTick } from "../src/net/stream.ts";
import { dealDamage } from "../src/sim/combat.ts";
import type { Vec2 } from "../src/sim/math.ts";
import type { FxEvent, Unit, World } from "../src/sim/types.ts";
import { createWorld, dashHero, issueOrder, spawnHero, step } from "../src/sim/world.ts";

test("only an empty room seeds a match, retaining the renderer's world and maps", () => {
  const world = emptyGuestWorld();
  const { units } = world;
  const seats = restoreHostState(world, null);
  assert.equal(world.units, units);
  assert.deepEqual(encodeWorld(world), encodeWorld(createWorld(1234)));
  assert.deepEqual(seats, { picks: {}, seats: {} });
});

test("promotion retains the accepted clock, RNG, combat state and stable human seats", () => {
  const host = createWorld(93);
  const hero = spawnHero(host, "duskblade", "dire", "remaining", false, 2);
  const departed = spawnHero(host, "ironvow", "radiant", "previous-host", false, 1);
  spawnHero(host, "emberhex", "dire", "bot-dire-0", true, 0);
  assert.ok(hero.hero && departed.hero);
  hero.hp = 137;
  hero.hero.gold = 923;
  hero.hero.level = 4;
  hero.hero.kills = 3;
  hero.hero.items = ["boots"];
  hero.hero.abilities.Q.readyAt = 65_432;
  departed.alive = false;
  departed.hero.respawnAt = 80_000;
  host.now = 61_750;
  host.gameTime = 61.75;
  host.seq = 108;
  host.nextWaveAt = 90;
  host.waveCount = 3;
  host.campRespawnAt["held-camp"] = 145;
  const wire = structuredClone(encodeWorld(host));
  const guest = emptyGuestWorld();
  guest.fx.push({ t: "notify", text: "stale local effect", tone: "neutral" });
  const roster = restoreHostState(guest, wire);
  assert.deepEqual(encodeWorld(guest), wire);
  assert.deepEqual(roster, {
    picks: { "previous-host": "ironvow", remaining: "duskblade" },
    seats: {
      "previous-host": { slot: 1, team: "radiant" },
      remaining: { slot: 2, team: "dire" },
    },
  });
  assert.equal(guest.fx.length, 0);
});

test("an ended snapshot stays ended even when its final roster is empty", () => {
  const ended = createWorld(88);
  ended.phase = "ended";
  ended.winner = "dire";
  ended.gameTime = 1371;
  ended.units.clear();
  const guest = createWorld(1);
  const result = restoreHostState(guest, structuredClone(encodeWorld(ended)));
  assert.equal(guest.phase, "ended");
  assert.equal(guest.winner, "dire");
  assert.equal(guest.gameTime, 1371);
  assert.equal(guest.units.size, 0);
  assert.deepEqual(result, { picks: {}, seats: {} });
});

test("promotion resumes the same deterministic simulation instead of resetting it", () => {
  const host = createWorld(987);
  spawnHero(host, "ironvow", "radiant", "a", true, 0);
  spawnHero(host, "emberhex", "dire", "b", true, 0);
  for (let i = 0; i < 180; i += 1) {
    step(host, 1 / 30);
  }
  const promoted = emptyGuestWorld();
  restoreHostState(promoted, structuredClone(encodeWorld(host)));
  host.fx.length = 0;
  for (let i = 0; i < 180; i += 1) {
    step(host, 1 / 30);
    step(promoted, 1 / 30);
  }
  assert.deepEqual(encodeWorld(promoted), encodeWorld(host));
  assert.deepEqual(promoted.fx, host.fx);
});

test("a newer reconnect snapshot replaces stale local progress without changing its roster", () => {
  const stale = createWorld(7);
  spawnHero(stale, "ironvow", "radiant", "returning", false, 0);
  const current = createWorld(91);
  const hero = spawnHero(current, "brewkeeper", "dire", "returning", false, 2);
  assert.ok(hero.hero);
  hero.hero.gold = 712;
  current.gameTime = 300;
  current.now = 300_000;
  const snap = structuredClone(encodeWorld(current));
  restoreHostState(stale, snap);
  assert.deepEqual(encodeWorld(stale), snap);
  const roster = restoreHostState(stale, snap);
  assert.deepEqual(roster.seats.returning, { slot: 2, team: "dire" });
  assert.equal(roster.picks.returning, "brewkeeper");
  assert.equal(stale.units.get("h-returning")?.hero?.gold, 712);
});

test("host adoption owns its mutable state without rewriting the accepted snapshot", () => {
  const host = createWorld(34);
  spawnHero(host, "ironvow", "radiant", "a", true, 0);
  spawnHero(host, "emberhex", "dire", "b", true, 0);
  const accepted = structuredClone(encodeWorld(host));
  const before = structuredClone(accepted);
  const promoted = emptyGuestWorld();
  restoreHostState(promoted, accepted);
  for (let i = 0; i < 180; i += 1) {
    step(promoted, 1 / 30);
  }
  assert.deepEqual(accepted, before);
  assert.notDeepEqual(encodeWorld(promoted), before);
  restoreHostState(promoted, accepted);
  assert.deepEqual(encodeWorld(promoted), before);
});

// ---- netcode: the tick stream, interpolation and own-hero prediction --------
// Hosts and guests joined by simulated links — one-way latency plus jitter, in
// order like TCP — run on one virtual clock so every assertion is
// deterministic. Hosts stamp and guests render on the room's server clock,
// which each client reads off its own lopsided time probe: a few ms out, as a
// real reading is.

const STEP_MS = SIM_DT * 1000;
const FRAME_MS = 1000 / 60;
/** Server time is an epoch clock, where a page's own clock starts near zero. */
const SERVER_EPOCH_MS = 1_790_000_000_000;
const DEAD_ZONE_PX = 16;

/** Deterministic jitter in [0, 1). */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

/** What crosses the wire is JSON, never the sender's own objects. */
const wire = (v: JsonValue): JsonValue =>
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- emulates the JSON wire, which drops what structuredClone keeps (undefined-valued keys)
  JSON.parse(JSON.stringify(v));

/** A client's reading of the server clock, off one time probe whose way out
 *  took `lopsidedMs` longer than the way back: off by half that. */
const readServerClock = (lopsidedMs: number): ServerClock => {
  const clock = new ServerClock();
  const back = 40;
  const out = back + lopsidedMs;
  clock.sample(0, SERVER_EPOCH_MS + out, out + back);
  return clock;
};

/** One direction of a link: each message lands `latencyMs` plus up to
 *  `jitterMs` after it was sent, and never ahead of the one before it. */
interface Link {
  send: (now: number, payload: JsonValue) => void;
  receive: (now: number) => JsonValue[];
}

const link = (latencyMs: number, jitterMs: number): Link => {
  const queue: { at: number; payload: JsonValue }[] = [];
  let sent = 0;
  let lastAt = 0;
  return {
    receive: (now) => {
      const out: JsonValue[] = [];
      let [next] = queue;
      while (next && next.at <= now) {
        out.push(next.payload);
        queue.shift();
        [next] = queue;
      }
      return out;
    },
    send: (now, payload) => {
      sent += 1;
      lastAt = Math.max(lastAt, now + latencyMs + noise(sent) * jitterMs);
      queue.push({ at: lastAt, payload: wire(payload) });
    },
  };
};

/** The host half of GameScene: a 30 Hz sim, each step stamped with the host's
 *  reading of server time and sent down every guest's link, after the keyframe
 *  the stream is based on. */
interface StreamHost {
  readonly world: World;
  readonly guests: Link[];
  /** Per guest hero: the newest input applied and the world.now it landed. */
  readonly acks: Map<string, { seq: number; at: number }>;
  /** The stamp of every tick sent. */
  readonly stamps: number[];
  /** The whole world as shared state carries it, stamped now, and the stream
   *  re-based on it — what GameScene publishes on taking over. */
  keyframe: (now: number) => void;
  /** One 60 fps frame: the sim steps on its own 30 Hz clock, each step
   *  stamped with the moment it stands for. */
  frame: (now: number) => void;
}

const streamHost = (world: World, clock: ServerClock): StreamHost => {
  const encoder = new TickEncoder();
  const guests: Link[] = [];
  const acks = new Map<string, { seq: number; at: number }>();
  const stamps: number[] = [];
  let acc = 0;
  return {
    acks,
    frame: (now) => {
      acc += FRAME_MS;
      const stampNow = clock.now(now);
      while (acc >= STEP_MS) {
        acc -= STEP_MS;
        step(world, SIM_DT);
        const rows = [...acks].map(([id, a]): [string, number, number] => [
          id,
          a.seq,
          Math.round(world.now - a.at),
        ]);
        const t = Math.round(stampNow - acc);
        stamps.push(t);
        const tick = encoder.encode(world, t, world.fx.splice(0), rows);
        for (const guest of guests) {
          guest.send(now, { tick });
        }
      }
    },
    guests,
    keyframe: (now) => {
      const snapAt = Math.round(clock.now(now));
      encoder.reset(world);
      for (const guest of guests) {
        guest.send(now, { snap: encodeWorld(world), snapAt });
      }
    },
    stamps,
    world,
  };
};

/** The guest half of GameScene: a mirror rendering on the guest's own reading
 *  of server time, and its hero predicted. */
interface StreamGuest {
  readonly heroId: string;
  readonly view: World;
  readonly mirror: GuestMirror;
  readonly predictor: HeroPredictor;
  /** Everything any host sends it, in order: its one connection. */
  readonly down: Link;
  /** Take what arrived, then draw: GameScene's onNetChange and onHostTick,
   *  then followHost. */
  frame: (now: number) => void;
  /** Where this guest draws a unit this frame. */
  drawn: (id?: string) => Vec2;
}

const streamGuest = (heroId: string, clock: ServerClock, down: Link): StreamGuest => {
  const view = emptyGuestWorld();
  const mirror = new GuestMirror(view, clock);
  const predictor = new HeroPredictor();
  const take = (payload: JsonValue, now: number): void => {
    assert.ok(isJsonObject(payload), "a message");
    if (payload.tick === undefined) {
      const snap = sharedSnapshot(payload);
      const at = sharedSnapAt(payload);
      assert.ok(snap && at !== null, "a keyframe");
      if (mirror.keyframe(snap, at, true)) {
        predictor.reset();
      }
      return;
    }
    const tick = parseTick(payload.tick);
    assert.ok(tick, "tick parses");
    mirror.tick(tick, now);
    const me = mirror.latest?.units.get(heroId);
    const ack = tick.k?.find(([id]) => id === heroId);
    if (me) {
      predictor.reconcile(me, ack ? [ack[1], ack[2]] : null);
    }
  };
  return {
    down,
    drawn: (id = heroId) => {
      const u = view.units.get(id);
      assert.ok(u, `${id} drawn`);
      return { x: u.x, y: u.y };
    },
    frame: (now) => {
      for (const payload of down.receive(now)) {
        take(payload, now);
      }
      mirror.frame(now, heroId);
      const { latest } = mirror;
      predictor.frame(latest?.units.get(heroId), latest, now);
      predictor.draw(view);
    },
    heroId,
    mirror,
    predictor,
    view,
  };
};

/** A host simulating `host` and one guest playing `heroId`, a link each way. */
class Session {
  readonly host: World;
  readonly heroId: string;
  readonly guest: StreamGuest;
  now = 0;
  private readonly streamer: StreamHost;
  private readonly up: Link;

  constructor(host: World, heroId: string, latencyMs: number, jitterMs: number) {
    this.host = host;
    this.heroId = heroId;
    this.up = link(latencyMs, jitterMs);
    this.guest = streamGuest(heroId, readServerClock(24), link(latencyMs, jitterMs));
    this.streamer = streamHost(host, readServerClock(-10));
    this.streamer.guests.push(this.guest.down);
    this.streamer.keyframe(this.now);
  }

  get mirror(): GuestMirror {
    return this.guest.mirror;
  }

  get predictor(): HeroPredictor {
    return this.guest.predictor;
  }

  /** The guest acts: played on its hero at once, sent to the host numbered. */
  press(intent: Intent): void {
    const seq = this.predictor.input(intent, this.now);
    this.up.send(this.now, { ...intent, seq });
  }

  /** One 60 fps frame: the host applies whatever input arrived and steps, then
   *  the guest takes whatever arrived and draws. */
  frame(): void {
    this.now += FRAME_MS;
    for (const payload of this.up.receive(this.now)) {
      this.apply(payload);
    }
    this.streamer.frame(this.now);
    this.guest.frame(this.now);
  }

  frames(n: number): void {
    for (let i = 0; i < n; i += 1) {
      this.frame();
    }
  }

  /** Where the guest draws a unit this frame. */
  drawn(id = this.heroId): Vec2 {
    return this.guest.drawn(id);
  }

  hostUnit(id = this.heroId): Unit {
    const u = this.host.units.get(id);
    assert.ok(u, `${id} on the host`);
    return u;
  }

  private apply(payload: JsonValue): void {
    const intent = parseIntent(payload);
    const u = this.host.units.get(this.heroId);
    if (!intent || intent.kind === "join" || !u) {
      return;
    }
    if (intent.seq !== undefined) {
      this.streamer.acks.set(u.id, { at: this.host.now, seq: intent.seq });
    }
    if (intent.kind === "order") {
      issueOrder(this.host, u, intent.order);
    } else if (intent.kind === "dash") {
      dashHero(this.host, u, intent.dx, intent.dy);
    }
  }
}

/** A guest's hero alone at its fountain, open ground to the east. */
const soloSession = (latencyMs: number, jitterMs: number): Session => {
  const host = createWorld(4242);
  const hero = spawnHero(host, "ironvow", "radiant", "guest", false, 2);
  const session = new Session(host, hero.id, latencyMs, jitterMs);
  // past the first ticks: the clock is synced and the buffer is full
  session.frames(30);
  return session;
};

const RUN_EAST: Intent = { kind: "order", order: { dx: 1, dy: 0, type: "moveDir" } };
const STOP: Intent = { kind: "order", order: { type: "hold" } };

test("a guest's own hero moves the frame its input happens, a round trip before the host's", () => {
  const s = soloSession(60, 30);
  const before = s.drawn();
  const hostBefore = s.hostUnit().x;
  s.press(RUN_EAST);
  s.frame();
  const after = s.drawn();
  const speed = s.hostUnit().moveSpeedBase;
  assert.ok(
    Math.abs(after.x - before.x - speed * (FRAME_MS / 1000)) < 0.5,
    `moved a frame's worth on the input frame (${after.x - before.x})`,
  );
  assert.equal(s.hostUnit().x, hostBefore, "the host has not even heard of it yet");
});

test("running straight through latency and jitter, the guest's hero stays inside the dead zone", () => {
  const s = soloSession(60, 40);
  const start = s.drawn();
  s.press(RUN_EAST);
  let worst = 0;
  for (let i = 0; i < 150; i += 1) {
    s.frame();
    const { x, y } = s.predictor.correction;
    worst = Math.max(worst, Math.hypot(x, y));
  }
  assert.equal(worst, 0, "the host's copy always lay on the predicted path: no correction");
  assert.ok(s.drawn().x - start.x > 600, `it really ran (${s.drawn().x - start.x} px)`);
  s.press(STOP);
  s.frames(60);
  const host = s.hostUnit();
  const end = s.drawn();
  assert.ok(
    Math.hypot(host.x - end.x, host.y - end.y) <= DEAD_ZONE_PX,
    `stopped where the host stopped (${Math.hypot(host.x - end.x, host.y - end.y)} px)`,
  );
});

test("a dash is predicted the frame it is pressed and lands where the host's does", () => {
  const s = soloSession(60, 30);
  const before = s.drawn();
  s.press({ dx: 1, dy: 0, kind: "dash" });
  s.frame();
  assert.ok(s.drawn().x - before.x > 15, "dashing on the press frame");
  s.frames(40);
  const host = s.hostUnit();
  const end = s.drawn();
  assert.ok(end.x - before.x > 150, `dashed (${end.x - before.x} px)`);
  assert.ok(
    Math.hypot(host.x - end.x, host.y - end.y) <= DEAD_ZONE_PX,
    `same landing as the host (${Math.hypot(host.x - end.x, host.y - end.y)} px)`,
  );
});

test("a respawn snaps the guest's hero to the fountain, no glide from where it fell", () => {
  const s = soloSession(60, 30);
  s.press(RUN_EAST);
  s.frames(60);
  const hero = s.hostUnit();
  dealDamage(s.host, null, hero, 1e9, "pure", {});
  assert.equal(hero.alive, false);
  let fell: Vec2 | null = null;
  let respawned = false;
  for (let i = 0; i < 60 * 15 && !respawned; i += 1) {
    s.frame();
    const alive = s.mirror.latest?.units.get(s.heroId)?.alive;
    if (alive === false) {
      fell ??= s.drawn();
    }
    respawned = fell !== null && alive === true;
  }
  assert.ok(fell && respawned, "death and respawn both streamed");
  const host = s.mirror.latest?.units.get(s.heroId);
  assert.ok(host);
  const drawn = s.drawn();
  assert.ok(Math.hypot(drawn.x - fell.x, drawn.y - fell.y) > 200, "moved away from the death spot");
  assert.ok(
    Math.hypot(drawn.x - host.x, drawn.y - host.y) < 0.5,
    `on the host's spawn point the first frame (${drawn.x - host.x}, ${drawn.y - host.y})`,
  );
});

test("remote bodies move steadily however unevenly their ticks arrive", () => {
  const host = createWorld(4243);
  const guest = spawnHero(host, "ironvow", "radiant", "guest", false, 2);
  // ahead of the guest on open ground, so nothing but the network shapes its path
  const other = spawnHero(host, "duskblade", "radiant", "other", false, 4);
  issueOrder(host, other, { dx: 1, dy: 0, type: "moveDir" });
  const s = new Session(host, guest.id, 60, 45);
  s.frames(40);
  const speed = other.moveSpeedBase * (FRAME_MS / 1000);
  let prev = s.drawn(other.id).x;
  for (let i = 0; i < 90; i += 1) {
    s.frame();
    const { x } = s.drawn(other.id);
    assert.ok(Math.abs(x - prev - speed) < speed * 0.2, `frame step ${x - prev} vs ${speed}`);
    prev = x;
  }
});

test("effects are never lost, however many ticks land in one frame", () => {
  const host = createWorld(4244);
  spawnHero(host, "ironvow", "radiant", "guest", false, 2);
  const view = emptyGuestWorld();
  const mirror = new GuestMirror(view, readServerClock(0));
  const encoder = new TickEncoder();
  mirror.keyframe(structuredClone(encodeWorld(host)), SERVER_EPOCH_MS, true);
  encoder.reset(host);
  const notes = ["first", "second", "third"];
  for (const [i, text] of notes.entries()) {
    step(host, SIM_DT);
    const fx: FxEvent[] = [{ t: "notify", text, tone: "neutral" }];
    const stamp = SERVER_EPOCH_MS + (i + 1) * STEP_MS;
    const tick = parseTick(wire(encoder.encode(host, stamp, fx, [])));
    assert.ok(tick);
    mirror.tick(tick, 150);
  }
  mirror.frame(10_000, "");
  assert.deepEqual(
    view.fx.map((fx) => (fx.t === "notify" ? fx.text : fx.t)),
    notes,
  );
});

test("the per-step stream is a small fraction of the world it replaces, and rebuilds it", () => {
  const host = createWorld(4245);
  for (const [i, id] of ["ironvow", "stormcaller", "emberhex"].entries()) {
    spawnHero(host, id, "radiant", `r${i}`, true, i);
  }
  for (const [i, id] of ["duskblade", "brewkeeper", "boomtinker"].entries()) {
    spawnHero(host, id, "dire", `d${i}`, true, i);
  }
  const replica = emptyGuestWorld();
  restoreHostState(replica, structuredClone(encodeWorld(host)));
  const encoder = new TickEncoder();
  encoder.reset(host);
  let tickBytes = 0;
  let ticks = 0;
  let fullBytes = 0;
  let fulls = 0;
  for (let i = 0; i < 30 * 150; i += 1) {
    step(host, SIM_DT);
    const json = JSON.stringify(encoder.encode(host, i * STEP_MS, host.fx.splice(0), []));
    tickBytes += json.length;
    ticks += 1;
    const tick = parseTick(JSON.parse(json));
    assert.ok(tick);
    applyTick(replica, tick, false);
    if (i % 30 === 0) {
      fullBytes += JSON.stringify(encodeWorld(host)).length;
      fulls += 1;
    }
  }
  const perTick = tickBytes / ticks;
  const perFull = fullBytes / fulls;
  assert.ok(perTick < 1500, `a tick averages ${Math.round(perTick)} bytes`);
  assert.ok(perTick * 15 < perFull, `vs ${Math.round(perFull)} bytes for the whole world`);
  for (const u of host.units.values()) {
    const copy = replica.units.get(u.id);
    assert.ok(copy, `${u.id} replicated`);
    assert.ok(Math.hypot(copy.x - u.x, copy.y - u.y) < 0.1, `${u.id} where the host has it`);
    assert.equal(copy.alive, u.alive);
    assert.ok(Math.abs(copy.hp - u.hp) < 0.1, `${u.id} hp`);
  }
  assert.deepEqual([...replica.projectiles.keys()], [...host.projectiles.keys()]);
  assert.equal(replica.rngState, host.rngState);
  assert.equal(replica.seq, host.seq);
});

test("a promoted guest carries on the host's match from its replica, not a stale keyframe", () => {
  const host = createWorld(4246);
  const me = spawnHero(host, "ironvow", "radiant", "guest", false, 2);
  spawnHero(host, "emberhex", "dire", "bot-dire-0", true, 0);
  spawnHero(host, "duskblade", "radiant", "bot-radiant-1", true, 1);
  const s = new Session(host, me.id, 60, 30);
  s.press(RUN_EAST);
  // far past any keyframe: only the stream knows where things are now
  s.frames(60 * 20);
  const replica = s.mirror.resumable;
  assert.ok(replica, "a whole replica");
  const promoted = emptyGuestWorld();
  restoreHostState(promoted, encodeWorld(replica));
  assert.ok(Math.abs(promoted.gameTime - host.gameTime) < 0.2, "resumes at the host's moment");
  for (let i = 0; i < 90; i += 1) {
    step(host, SIM_DT);
    step(promoted, SIM_DT);
  }
  for (const u of host.units.values()) {
    if (u.kind !== "hero") {
      continue;
    }
    const copy = promoted.units.get(u.id);
    assert.ok(copy);
    assert.ok(
      Math.hypot(copy.x - u.x, copy.y - u.y) < 40,
      `${u.id} plays on as it would have (${Math.hypot(copy.x - u.x, copy.y - u.y)} px)`,
    );
  }
});

test("through a host migration the others play straight on: one clock, no reset, no jump", () => {
  // A hosts B and C. B's hero runs east the whole time, a remote body to C,
  // whose own hero runs alongside it, predicted.
  const world = createWorld(4247);
  const runner = spawnHero(world, "ironvow", "radiant", "b", false, 2);
  const watcher = spawnHero(world, "duskblade", "radiant", "c", false, 4);
  issueOrder(world, runner, { dx: 1, dy: 0, type: "moveDir" });
  issueOrder(world, watcher, { dx: 1, dy: 0, type: "moveDir" });
  const bClock = readServerClock(18);
  const a = streamHost(world, readServerClock(-12));
  const b = streamGuest(runner.id, bClock, link(55, 30));
  const c = streamGuest(watcher.id, readServerClock(30), link(70, 30));
  a.guests.push(b.down, c.down);
  a.keyframe(0);
  const travel = runner.moveSpeedBase * (FRAME_MS / 1000);
  const LEAVES = 90;
  const ELECTED = LEAVES + 9;
  let host: StreamHost | null = a;
  let promoted: World | null = null;
  let guests = [b, c];
  let now = 0;
  let prev: Vec2 | null = null;
  let start: Vec2 | null = null;
  let viewTime = 0;
  let worstCorrection = 0;
  for (let f = 1; f <= ELECTED + 120; f += 1) {
    now += FRAME_MS;
    if (f === LEAVES) {
      // A's tab closes: no more steps, but what it already sent still lands.
      host = null;
    }
    if (f === ELECTED) {
      // The server names B host and tells everyone. B takes over from its
      // replica as GameScene's prepareOnlineHost does, keeping its own order;
      // C only stops building on the replica A's stream was based on.
      const replica = b.mirror.resumable;
      assert.ok(replica, "B saw every one of A's steps");
      assert.equal(replica.gameTime, world.gameTime, "B's replica is A's last moment");
      promoted = emptyGuestWorld();
      restoreHostState(promoted, encodeWorld(replica));
      const held = b.predictor.order;
      const own = promoted.units.get(runner.id);
      assert.ok(held && own);
      issueOrder(promoted, own, held);
      host = streamHost(promoted, bClock);
      host.guests.push(c.down);
      host.keyframe(now);
      c.mirror.hostChanged();
      guests = [c];
    }
    host?.frame(now);
    for (const guest of guests) {
      guest.frame(now);
    }
    if (f < 30) {
      continue;
    }
    // From C's seat: the runner never jumps, either way, and the view's clock
    // never goes back more than the step it may have run ahead.
    const at = c.drawn(runner.id);
    start ??= at;
    if (prev) {
      const dx: number = at.x - prev.x;
      assert.ok(dx > -1.5 * travel && dx < 1.5 * travel, `f${f}: C drew the runner move ${dx} px`);
    }
    prev = at;
    assert.ok(c.view.gameTime > viewTime - STEP_MS / 1000 - 1e-9, `f${f}: C's clock went back`);
    viewTime = Math.max(viewTime, c.view.gameTime);
    const { x, y } = c.predictor.correction;
    worstCorrection = Math.max(worstCorrection, Math.hypot(x, y));
  }
  assert.ok(promoted && host && start && prev);
  const [resumedAt] = host.stamps;
  const leftAt = a.stamps.at(-1);
  assert.ok(resumedAt && leftAt && resumedAt > leftAt, "B stamps on where A stopped");
  assert.ok(prev.x - start.x > travel * 160, `C saw the runner run on (${prev.x - start.x} px)`);
  assert.ok(worstCorrection < DEAD_ZONE_PX, `C's own hero ran through it (${worstCorrection} px)`);
  // Drained, C holds B's world exactly, and whole: it could take over next.
  for (let i = 0; i < 20; i += 1) {
    now += FRAME_MS;
    c.frame(now);
  }
  const replica = c.mirror.resumable;
  assert.ok(replica, "C's replica is whole again");
  assert.equal(replica.gameTime, promoted.gameTime);
  for (const u of promoted.units.values()) {
    const copy = replica.units.get(u.id);
    assert.ok(copy, `${u.id} replicated`);
    assert.ok(Math.hypot(copy.x - u.x, copy.y - u.y) < 0.1, `${u.id} where B has it`);
  }
});
