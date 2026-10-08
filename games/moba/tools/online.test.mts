import assert from "node:assert/strict";
import { test } from "node:test";

import { SIM_DT } from "../src/data/config.ts";
import { restoreHostState } from "../src/net/host-state.ts";
import type { JsonValue } from "../src/net/json.ts";
import { GuestMirror } from "../src/net/mirror.ts";
import { HeroPredictor } from "../src/net/predict.ts";
import { parseIntent } from "../src/net/protocol.ts";
import type { Intent } from "../src/net/protocol.ts";
import { emptyGuestWorld, encodeWorld } from "../src/net/snapshot.ts";
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
// A host sim and a guest joined by a simulated link — one-way latency plus
// jitter, in order like TCP, the host's clock skewed from the guest's — run on
// one virtual clock so every assertion is deterministic.

const STEP_MS = SIM_DT * 1000;
const FRAME_MS = 1000 / 60;
const HOST_SKEW_MS = 7000;
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

/** A host simulating `host` at 30 Hz and streaming ticks, and a guest that
 *  plays `heroId` — the same glue as GameScene, on a virtual clock. */
class Session {
  readonly host: World;
  readonly heroId: string;
  readonly view = emptyGuestWorld();
  readonly mirror = new GuestMirror(this.view);
  readonly predictor = new HeroPredictor();
  readonly tickBytes: number[] = [];
  now = 0;
  private readonly encoder = new TickEncoder();
  private readonly up: Link;
  private readonly down: Link;
  private readonly acks = new Map<string, { seq: number; at: number }>();
  private hostAcc = 0;

  constructor(host: World, heroId: string, latencyMs: number, jitterMs: number) {
    this.host = host;
    this.heroId = heroId;
    this.up = link(latencyMs, jitterMs);
    this.down = link(latencyMs, jitterMs);
    this.mirror.keyframe(structuredClone(encodeWorld(host)), HOST_SKEW_MS, true);
    this.encoder.reset(host);
  }

  /** The guest acts: played on its hero at once, sent to the host numbered. */
  press(intent: Intent): void {
    const seq = this.predictor.input(intent, this.now);
    this.up.send(this.now, { ...intent, seq });
  }

  /** One 60 fps guest frame: the host steps and streams on its own 30 Hz
   *  clock, the guest takes whatever arrived, then draws. */
  frame(): void {
    this.now += FRAME_MS;
    this.hostFrame();
    for (const payload of this.down.receive(this.now)) {
      const tick = parseTick(payload);
      assert.ok(tick, "tick parses");
      this.mirror.tick(tick, this.now);
      const me = this.mirror.latest?.units.get(this.heroId);
      const ack = tick.k?.find(([id]) => id === this.heroId);
      if (me) {
        this.predictor.reconcile(me, ack ? [ack[1], ack[2]] : null);
      }
    }
    this.mirror.frame(this.now, this.heroId);
    const { latest } = this.mirror;
    this.predictor.frame(latest?.units.get(this.heroId), latest, this.now);
    this.predictor.draw(this.view);
  }

  frames(n: number): void {
    for (let i = 0; i < n; i += 1) {
      this.frame();
    }
  }

  /** Where the guest draws a unit this frame. */
  drawn(id = this.heroId): Vec2 {
    const u = this.view.units.get(id);
    assert.ok(u, `${id} drawn`);
    return { x: u.x, y: u.y };
  }

  hostUnit(id = this.heroId): Unit {
    const u = this.host.units.get(id);
    assert.ok(u, `${id} on the host`);
    return u;
  }

  private hostFrame(): void {
    for (const payload of this.up.receive(this.now)) {
      const intent = parseIntent(payload);
      const u = this.host.units.get(this.heroId);
      if (!intent || intent.kind === "join" || !u) {
        continue;
      }
      if (intent.seq !== undefined) {
        this.acks.set(u.id, { at: this.host.now, seq: intent.seq });
      }
      if (intent.kind === "order") {
        issueOrder(this.host, u, intent.order);
      } else if (intent.kind === "dash") {
        dashHero(this.host, u, intent.dx, intent.dy);
      }
    }
    this.hostAcc += FRAME_MS;
    while (this.hostAcc >= STEP_MS) {
      this.hostAcc -= STEP_MS;
      step(this.host, SIM_DT);
      const acks = [...this.acks].map(([id, a]): [string, number, number] => [
        id,
        a.seq,
        Math.round(this.host.now - a.at),
      ]);
      const stamp = this.now + HOST_SKEW_MS - this.hostAcc;
      const tick = this.encoder.encode(this.host, stamp, this.host.fx.splice(0), acks);
      this.tickBytes.push(JSON.stringify(tick).length);
      this.down.send(this.now, tick);
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
  const mirror = new GuestMirror(view);
  const encoder = new TickEncoder();
  mirror.keyframe(structuredClone(encodeWorld(host)), 0, true);
  encoder.reset(host);
  const notes = ["first", "second", "third"];
  for (const [i, text] of notes.entries()) {
    step(host, SIM_DT);
    const fx: FxEvent[] = [{ t: "notify", text, tone: "neutral" }];
    const tick = parseTick(wire(encoder.encode(host, (i + 1) * STEP_MS, fx, [])));
    assert.ok(tick);
    mirror.tick(tick, 50);
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
