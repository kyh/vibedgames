// The host leaves mid-match. The server elects a guest, which carries the
// match on from its own copy of the world — every frame the old host sent —
// while the other guest plays on against it, on the same server clock.
// Headless: the real sim, HostNet, NetMirror, OwnHeroPredictor and takeOver
// over simulated sockets (net-sim.mts), wired the way the scene wires them.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlayerMap } from "@vibedgames/multiplayer";
import { ARENA_BOT_FILL } from "../src/data/config.ts";
import { isJsonNumber, isJsonObject } from "../src/data/json.ts";
import type { JsonObject, JsonValue } from "../src/data/json.ts";
import { CAMPS, SPAWNS } from "../src/data/map.ts";
import { HostNet } from "../src/net/host-net.ts";
import type { HostLink } from "../src/net/host-net.ts";
import { reconcileHostHeroes, takeOver } from "../src/net/host-state.ts";
import type { HeroPick, OnlineSeat, TakeoverSource } from "../src/net/host-state.ts";
import { inputWire, parseInput } from "../src/net/input.ts";
import { NetMirror, parseFrame } from "../src/net/mirror.ts";
import { OwnHeroPredictor } from "../src/net/own-hero.ts";
import type { HeldInput } from "../src/net/own-hero.ts";
import { emptyGuestWorld, encodeWorld, isSnapshot } from "../src/net/snapshot.ts";
import type { Snapshot } from "../src/net/snapshot.ts";
import { createWorld, ensureBots, setHeroInput, spawnHero } from "../src/sim/world.ts";
import type { World } from "../src/sim/types.ts";
import { Pipe } from "./net-sim.mts";

const FRAME_MS = 1000 / 60;
/** The old host's close reaching the server, then its `host` message reaching the new one. */
const ELECTION_MS = 150;

interface Peer {
  readonly id: string;
  readonly heroId: string;
  /** Its copy of the host's world while a guest; its own sim once promoted. */
  readonly world: World;
  readonly mirror: NetMirror;
  readonly predictor: OwnHeroPredictor;
  readonly held: HeldInput;
  /** From the server: whatever the current host sends. */
  readonly down: Pipe;
  /** To the server, addressed to the current host. */
  up: Pipe;
}

interface Host {
  readonly id: string;
  readonly world: World;
  readonly net: HostNet;
}

const unwatched = (): void => {
  /* nothing to watch */
};

/** A host and two guests, `p` and `q`, in one room. */
const room = () => {
  let now = 5000;
  const server = { now: (localNow?: number) => localNow ?? now, synced: true };
  const world = createWorld(7);
  for (const [owner, slot] of [
    ["host", 0],
    ["p", 1],
    ["q", 2],
  ] as const) {
    spawnHero(world, {
      champId: "knight",
      id: `h-${owner}`,
      isBot: false,
      name: owner,
      ownerId: owner,
      slot,
      team: owner,
    });
  }
  ensureBots(world);
  const peer = (id: string, salt: number): Peer => {
    const mirror = new NetMirror(server);
    mirror.ownId = `h-${id}`;
    return {
      down: new Pipe(90, 40, salt),
      held: { attack: false, ax: 1, ay: 0, mx: 0, my: 0 },
      heroId: `h-${id}`,
      id,
      mirror,
      predictor: new OwnHeroPredictor(),
      up: new Pipe(90, 40, salt + 1),
      world: emptyGuestWorld(),
    };
  };
  const p = peer("p", 10);
  const q = peer("q", 20);
  const peers = [p, q];
  let host: Host | null = { id: "host", net: new HostNet(), world };
  /** What sharedState.snap holds: the newest snapshot any host published. */
  let roomSnap: Snapshot | null = null;
  /** The roster a promoted guest keeps seated (the scene's picks and assign). */
  let picks: Record<string, HeroPick> = {};
  let seats: Record<string, OnlineSeat> = {};
  const players: PlayerMap = { p: { id: "p" }, q: { id: "q" } };
  let watch = unwatched;

  const guests = (): Peer[] => peers.filter((g) => g.id !== host?.id);

  const link = (h: Host): HostLink => ({
    inputHero: (owner) => {
      const u = h.world.units.get(`h-${owner}`);
      return owner !== h.id && u?.alive && h.world.phase === "playing" ? u : null;
    },
    now: () => now,
    publish: (snap, t) => {
      roomSnap = structuredClone(snap);
      for (const g of guests()) {
        g.down.send(now, { kind: "snap", snap, t });
      }
    },
    sendFrame: (frame) => {
      for (const g of guests()) {
        g.down.send(now, { frame, kind: "frame" });
      }
    },
  });

  const hostFrame = (h: Host): void => {
    for (const g of guests()) {
      for (const message of g.up.receive(now)) {
        const packet = isJsonObject(message) ? parseInput(message) : null;
        if (packet) {
          h.net.receive(g.id, packet);
        }
      }
    }
    // a promoted guest seats the room and drives its own hero from its
    // controls, as the scene's host path does every frame
    const self = peers.find((g) => g.id === h.id);
    if (self) {
      reconcileHostHeroes(h.world, players, picks, seats);
      const me = h.world.units.get(self.heroId);
      if (me?.alive) {
        const { held } = self;
        setHeroInput(me, held.mx, held.my, held.ax, held.ay, held.attack);
      }
    }
    h.net.advance(h.world, FRAME_MS, link(h));
    h.world.fx.length = 0;
  };

  const guestFrame = (g: Peer): void => {
    for (const message of g.down.receive(now)) {
      if (!isJsonObject(message)) {
        continue;
      }
      if (message["kind"] === "snap") {
        const { snap, t } = message;
        if (isSnapshot(snap)) {
          g.mirror.applySnapshot(g.world, snap, isJsonNumber(t) ? t : null, now, true);
        }
      } else {
        const frame = parseFrame(message["frame"] ?? null);
        const own = frame ? g.mirror.applyFrame(g.world, frame, now) : null;
        if (own) {
          g.predictor.hostUpdate(own);
        }
      }
    }
    g.mirror.render(g.world, now);
    g.world.fx.length = 0;
    const me = g.world.units.get(g.heroId);
    if (me && g.world.phase === "playing") {
      g.predictor.advance(me, g.world.units, FRAME_MS, now, g.world.now, g.held, (packet) =>
        g.up.send(now, inputWire(packet)),
      );
      g.predictor.render(me, g.world.units, g.held);
    }
  };

  return {
    /** The host closes its tab: nothing more is sent. Returns its world as it left it. */
    leave: (): World => {
      assert.ok(host);
      const left = host.world;
      host = null;
      return left;
    },
    p,
    /** The server elects `g`: it takes over from the freshest world on hand. */
    promote: (g: Peer): TakeoverSource => {
      const taken = takeOver(g.world, {
        held: g.held,
        mirror: g.mirror,
        ours: false,
        ownId: g.heroId,
        predictor: g.predictor,
        snapshot: roomSnap,
      });
      ({ picks, seats } = taken);
      const net = new HostNet();
      net.alreadySent(g.world.fx);
      g.mirror.reset();
      g.predictor.reset();
      host = { id: g.id, net, world: g.world };
      for (const other of guests()) {
        // input in flight to the old host is lost; the new one hears the held input at once
        other.up = new Pipe(90, 40, 99);
        other.predictor.resend();
      }
      return taken.source;
    },
    q,
    get roomSnap() {
      return roomSnap;
    },
    run: (ms: number): void => {
      const end = now + ms;
      while (now < end) {
        now += FRAME_MS;
        if (host) {
          hostFrame(host);
        }
        for (const g of guests()) {
          guestFrame(g);
        }
        watch();
      }
    },
    watch: (fn: () => void): void => {
      watch = fn;
    },
    world,
  };
};

/** How far a field may sit from the host's after riding the wire (net/frames.ts). */
const TOLERANCE = new Map([
  ["hp", 1],
  ["maxHp", 1],
  ["gold", 1],
  ["xp", 1],
  ["vx", 0.051],
  ["vy", 0.051],
]);

const near = (a: JsonValue | undefined, b: JsonValue | undefined, key: string, path: string) => {
  if (isJsonNumber(a) && isJsonNumber(b)) {
    assert.ok(Math.abs(a - b) <= (TOLERANCE.get(key) ?? 0.006), `${path}: ${a} ≠ ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    assert.equal(a.length, b.length, `${path}.length`);
    for (const [i, item] of a.entries()) {
      near(item, b[i], "", `${path}[${i}]`);
    }
  } else if (isJsonObject(a) && isJsonObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      near(a[k], b[k], k, `${path}.${k}`);
    }
  } else {
    assert.equal(a, b, path);
  }
};

/** What prediction owns on the promoted guest's own hero — and the DASH/JUMP
 *  cooldowns a predicted move spends — which the old host's copy lags. */
const PREDICTED = new Set([
  "abilities",
  "aimX",
  "aimY",
  "attackHeld",
  "dashUntil",
  "dashVx",
  "dashVy",
  "facing",
  "jumpUntil",
  "kbUntil",
  "kbx",
  "kby",
  "moveX",
  "moveY",
  "steerVx",
  "steerVy",
  "vx",
  "vy",
  "x",
  "y",
]);

/** A unit's fields, less the ones prediction owns when it is the promoted guest's own. */
const fieldsOf = (unit: JsonObject | undefined, own: boolean): JsonObject =>
  Object.fromEntries(Object.entries(unit ?? {}).filter(([key]) => !own || !PREDICTED.has(key)));

/** The promoted copy is the old host's world as it left it, field for field. */
const sameWorld = (left: World, copy: World, ownId: string): void => {
  const { units: _u, projectiles: _p, ...scalars } = encodeWorld(left);
  const { units: _cu, projectiles: _cp, ...copied } = encodeWorld(copy);
  const wantWorld: JsonObject = scalars;
  const gotWorld: JsonObject = copied;
  near(gotWorld, wantWorld, "", "world");
  assert.deepEqual([...copy.units.keys()].toSorted(), [...left.units.keys()].toSorted());
  for (const [id, unit] of left.units) {
    near(fieldsOf(copy.units.get(id), id === ownId), fieldsOf(unit, id === ownId), "", id);
  }
  assert.deepEqual([...copy.projectiles.keys()], [...left.projectiles.keys()]);
  for (const [id, shot] of left.projectiles) {
    near(fieldsOf(copy.projectiles.get(id), false), fieldsOf(shot, false), "", id);
  }
};

/** Hold a guest's controls `turn` radians off the way its spawn faces (the centre). */
const steer = (g: Peer, turn: number, held = true): void => {
  const facing = (SPAWNS[g.id === "p" ? 1 : 2]?.facing ?? 0) + turn;
  Object.assign(g.held, {
    ax: Math.cos(facing),
    ay: Math.sin(facing),
    mx: held ? Math.cos(facing) : 0,
    my: held ? Math.sin(facing) : 0,
  });
};

test("the host leaves: the promoted guest carries the match on from its mirror", () => {
  const r = room();
  const { p, q } = r;
  const hostHero = r.world.units.get("h-host");
  assert.ok(hostHero);
  setHeroInput(hostHero, 0.6, 0.8, 0.6, 0.8, true);
  r.run(3000);
  // both guests on the move when it happens
  steer(p, 0);
  steer(q, 0);
  r.run(1000);
  const left = r.leave();
  const scored = [...left.units.values()].reduce((sum, u) => sum + u.kills + u.deaths, 0);
  r.run(ELECTION_MS);
  const me = p.world.units.get(p.heroId);
  assert.ok(me);
  const drawn = { x: me.x, y: me.y };

  assert.equal(r.promote(p), "mirror", "promoted from its own copy");
  sameWorld(left, p.world, p.heroId);
  const snapBehind = left.now - (r.roomSnap?.now ?? left.now);
  const kept = p.world.units.get(p.heroId);
  assert.ok(kept);
  assert.ok(Math.hypot(kept.x - drawn.x, kept.y - drawn.y) < 1e-9, "own hero stays as drawn");
  const hostCopy = left.units.get(p.heroId);
  assert.ok(hostCopy);
  const lead = Math.hypot(kept.x - hostCopy.x, kept.y - hostCopy.y);
  assert.ok(lead > 0.5, `kept its predicted lead on the old host's copy (${lead.toFixed(2)})`);

  // the match runs on under p; q plays on against it — running, then turning,
  // then stopping, so the new host has to act on q's fresh input
  let worstCorrection = 0;
  let worstStep = 0;
  let last: { x: number; y: number } | null = null;
  r.watch(() => {
    const qHero = q.world.units.get(q.heroId);
    worstCorrection = Math.max(worstCorrection, q.predictor.correction);
    if (qHero && last) {
      worstStep = Math.max(worstStep, Math.hypot(qHero.x - last.x, qHero.y - last.y));
    }
    last = qHero ? { x: qHero.x, y: qHero.y } : null;
  });
  r.run(600);
  r.watch(() => {
    /* the handover window is over */
  });
  steer(q, Math.PI / 2);
  r.run(700);
  steer(q, Math.PI / 2, false);
  r.run(2000);
  const qPredicted = q.world.units.get(q.heroId);
  const qHosted = p.world.units.get(q.heroId);
  assert.ok(qPredicted && qHosted);
  const agree = Math.hypot(qPredicted.x - qHosted.x, qPredicted.y - qHosted.y);
  console.log(
    `  handover: the room's snapshot was ${Math.round(snapBehind)} ms behind the old host, the ` +
      `mirror 0 ms; the promoted hero kept its ${lead.toFixed(2)} u predicted lead; the other ` +
      `guest's worst correction ${worstCorrection.toFixed(2)} u, worst frame step ` +
      `${worstStep.toFixed(2)} u, and its hero rests ${agree.toFixed(3)} u from the new host's copy`,
  );
  assert.ok(p.world.gameTime > left.gameTime + 3, "the new host simulates");
  assert.ok(Math.abs(q.world.gameTime - p.world.gameTime) < 0.25, "the other guest follows it");
  assert.ok(!p.world.units.has("h-host"), "the departed host's hero leaves with it");
  const heroes = [...p.world.units.values()].filter((u) => u.kind === "hero");
  assert.equal(heroes.length, ARENA_BOT_FILL, "a bot takes the empty seat");
  const after = [...p.world.units.values()].reduce((sum, u) => sum + u.kills + u.deaths, 0);
  assert.ok(after >= scored, "no kill or death is undone");
  for (const camp of CAMPS) {
    const alive = [...p.world.units.values()].filter((u) => u.campId === camp.id && u.alive);
    assert.ok(alive.length <= (camp.pack?.length ?? 4), `${camp.id} never spawns twice`);
  }
  // eased, never snapped: the other guest only feels what the old host never
  // got to apply — the election's worth of its own input
  assert.ok(
    worstCorrection < 3,
    `the other guest's hero was eased (${worstCorrection.toFixed(2)})`,
  );
  assert.ok(worstStep < 0.5, `and never jumped (${worstStep.toFixed(2)} u in a frame)`);
  assert.ok(agree < 0.1, `the new host ran q's input as q predicted it (${agree.toFixed(3)} u)`);
});

test("a copy that missed frames falls back to the room's snapshot; a host back from a blip keeps its own", () => {
  const world = createWorld(3);
  ensureBots(world);
  const snap = structuredClone(encodeWorld(world));
  const server = { now: (localNow?: number) => localNow ?? 0, synced: true };
  const mirror = new NetMirror(server);
  const copy = emptyGuestWorld();
  // the snapshot found on joining was published before frames we never got
  mirror.applySnapshot(copy, snap, 1000, 1000, false);
  assert.equal(mirror.takeOver(copy), false, "not whole yet");
  mirror.applySnapshot(copy, snap, 2000, 2000, true);
  assert.equal(mirror.takeOver(copy), true, "whole once one arrives live");

  const late = new NetMirror(server);
  const joined = emptyGuestWorld();
  late.applySnapshot(joined, snap, 1000, 1000, false);
  const fallback = takeOver(joined, {
    held: { attack: false, ax: 1, ay: 0, mx: 0, my: 0 },
    mirror: late,
    ours: false,
    ownId: "h-nobody",
    predictor: new OwnHeroPredictor(),
    snapshot: snap,
  });
  assert.equal(fallback.source, "snapshot");
  assert.deepEqual(encodeWorld(joined), snap);

  const ran = structuredClone(encodeWorld(world));
  const own = takeOver(world, {
    held: { attack: false, ax: 1, ay: 0, mx: 0, my: 0 },
    mirror: new NetMirror(server),
    ours: true,
    ownId: "h-nobody",
    predictor: new OwnHeroPredictor(),
    snapshot: snap,
  });
  assert.equal(own.source, "own");
  assert.deepEqual(encodeWorld(world), ran, "its own world, untouched");
});
