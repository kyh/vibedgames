import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { Miniflare } from "miniflare";
import type { MiniflareOptions } from "miniflare";
import { z } from "zod";

import type { MultiplayerClientOptions } from "@vibedgames/multiplayer";
import {
  listRooms,
  MAX_ROOM_META_CHARS,
  MAX_TICK_HISTORY,
  MAX_TICK_RATE,
  MultiplayerClient,
  quickMatch,
} from "@vibedgames/multiplayer";

/**
 * Integration tests that drive the real VgServer — Durable Object, partyserver
 * routing, wire protocol and all — through workerd via Miniflare, booting the
 * bundle `cf build` emits (the `test` script builds first), with `MultiplayerClient` instances as the
 * clients. Node 22+ provides the global WebSocket that PartySocket picks up,
 * and the client's heartbeat falls back to setInterval off-browser, so the SDK
 * runs here unmodified.
 */

const OUTPUT = path.join(
  import.meta.dirname,
  "..",
  ".cloudflare",
  "output",
  "v0",
  "workers",
  "default",
);

const BuiltWorkerSchema = z.object({
  compatibilityDate: z.string(),
  compatibilityFlags: z.array(z.string()),
  manifest: z.object({ mainModule: z.string() }),
});

let miniflare: Miniflare;
let miniflareOptions: MiniflareOptions;
let worker: URL;

before(async () => {
  const built = BuiltWorkerSchema.parse(
    JSON.parse(await readFile(path.join(OUTPUT, "worker.config.json"), "utf-8")),
  );
  miniflareOptions = {
    compatibilityDate: built.compatibilityDate,
    compatibilityFlags: built.compatibilityFlags,
    d1Databases: { DB: "vibedgames" },
    durableObjects: { VgLobby: "VgLobby", VgServer: "VgServer" },
    modules: true,
    scriptPath: path.join(OUTPUT, "bundle", built.manifest.mainModule),
  };
  miniflare = new Miniflare(miniflareOptions);
  worker = await miniflare.ready;
  // Pin the port, so a restart (setOptions) comes back where clients reconnect.
  miniflareOptions = { ...miniflareOptions, port: Number(worker.port) };
});

after(async () => {
  await miniflare.dispose();
});

/** Each test gets its own room, i.e. its own Durable Object instance. */
let roomCounter = 0;
const uniqueRoom = (label: string): string => {
  roomCounter += 1;
  return `it-${process.pid}-${roomCounter - 1}-${label}`;
};

/** Poll until `predicate` holds. Deterministic waiting — no fixed sleeps. */
const waitFor = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await delay(25);
  }
};

const connect = (
  room: string,
  options?: Pick<
    MultiplayerClientOptions,
    "interest" | "limits" | "lobby" | "maxPlayers" | "onClaim" | "onEvent" | "onTick" | "tickRate"
  >,
): MultiplayerClient =>
  new MultiplayerClient({
    host: worker.origin,
    party: "vg-server",
    room,
    ...options,
  });

/** Poll an async check until it holds: a lobby hears from its rooms a moment after they change. */
const eventually = async (
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await delay(50);
  }
};

/** The room's public HTTP stats. */
const roomInfo = async (room: string): Promise<{ playerCount: number }> => {
  const response = await fetch(`${worker.origin}/parties/vg-server/${room}`);
  return z.object({ playerCount: z.number() }).parse(await response.json());
};

/** Connected + admitted: the server's `sync` sets both status and player id. */
const admitted = (client: MultiplayerClient): boolean =>
  client.connectionStatus === "connected" && client.playerId !== null;

test("two clients join the same room and both see each other", async () => {
  const room = uniqueRoom("join");
  const clientA = connect(room);
  const clientB = connect(room);
  try {
    await waitFor(() => admitted(clientA) && admitted(clientB), "both clients admitted");
    await waitFor(
      () => Object.keys(clientA.players).length === 2 && Object.keys(clientB.players).length === 2,
      "both clients see 2 players",
    );

    const aId = clientA.playerId;
    const bId = clientB.playerId;
    assert.ok(aId !== null && bId !== null);
    assert.notEqual(aId, bId);
    assert.ok(bId !== null && bId in clientA.players, "A sees B");
    assert.ok(aId !== null && aId in clientB.players, "B sees A");
  } finally {
    clientA.destroy();
    clientB.destroy();
  }
});

test("first client to join becomes host, and both clients agree", async () => {
  const room = uniqueRoom("host");
  const clientA = connect(room);
  try {
    await waitFor(() => admitted(clientA), "first client admitted");
    assert.equal(clientA.hostId, clientA.playerId, "solo joiner is host");
    assert.equal(clientA.isHost, true);

    const clientB = connect(room);
    try {
      await waitFor(() => admitted(clientB), "second client admitted");
      assert.equal(clientB.hostId, clientA.playerId, "guest agrees on host");
      assert.equal(clientB.isHost, false);
    } finally {
      clientB.destroy();
    }
  } finally {
    clientA.destroy();
  }
});

test("host state_patch propagates to guests; non-host writes are dropped", async () => {
  const room = uniqueRoom("shared-state");
  const eventsA: string[] = [];
  const eventsB: string[] = [];
  const clientA = connect(room, { onEvent: (event) => eventsA.push(event) });
  const clientB = connect(room, { onEvent: (event) => eventsB.push(event) });
  try {
    await waitFor(() => admitted(clientA) && admitted(clientB), "both clients admitted");
    // Which client wins the host election depends on connect order — don't
    // assume construction order decided it.
    await waitFor(() => clientA.isHost || clientB.isHost, "a host is elected");
    const host = clientA.isHost ? clientA : clientB;
    const guest = clientA.isHost ? clientB : clientA;
    const hostEvents = clientA.isHost ? eventsA : eventsB;

    host.updateSharedState({ score: 42 });
    await waitFor(() => guest.sharedState.score === 42, "guest received host patch");

    // Non-host write: the server must drop it. Ordering fence: the server
    // handles the guest's messages in order, so once its follow-up event
    // reaches the host, the rogue patch was already processed (and dropped).
    guest.updateSharedState({ cheat: true });
    guest.sendEvent("fence", null);
    await waitFor(() => hostEvents.includes("fence"), "fence event reached host");
    assert.equal(host.sharedState.cheat, undefined, "host never saw the non-host patch");
    await waitFor(() => guest.sharedState.cheat === undefined, "the guest's refused write rewound");
    assert.deepEqual(guest.sharedState, host.sharedState, "the guest holds the room's state again");
  } finally {
    clientA.destroy();
    clientB.destroy();
  }
});

test("per-player state propagates to other clients", async () => {
  const room = uniqueRoom("player-state");
  const clientA = connect(room);
  const clientB = connect(room);
  try {
    await waitFor(() => admitted(clientA) && admitted(clientB), "both clients admitted");

    clientA.updateMyState({ x: 7, y: 11 });
    const aId = clientA.playerId;
    assert.ok(aId !== null);
    await waitFor(() => {
      const seen = clientB.players[aId]?.state;
      return seen !== undefined && seen.x === 7 && seen.y === 11;
    }, "B sees A's player state");
  } finally {
    clientA.destroy();
    clientB.destroy();
  }
});

// -- Wire-level helpers -------------------------------------------------------
//
// Some behaviors are only observable at the wire (per-recipient deltas, what
// the server never sends) or require a client the SDK deliberately doesn't
// expose (no reconnect token, abrupt non-1000 closes, a chosen reconnect
// token). A minimal raw-WebSocket client covers those; everything else uses
// the real SDK.

/** JSON off the wire, typed as data rather than left `unknown`. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
interface JsonRecord {
  [key: string]: JsonValue;
}

// `String(v) === v` holds exactly for primitive strings (strict equality
// never coerces), so this predicate is sound without a runtime `typeof`.
const isJsonString = (value: JsonValue | undefined): value is string => String(value) === value;

/** Structural record view of a JSON value; throws when it isn't one. */
const toRecord = (value: JsonValue | undefined): JsonRecord => {
  if (!(value instanceof Object) || Array.isArray(value)) {
    throw new Error(`expected a plain object, got: ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value));
};

interface WireMessage {
  type: string;
  data: JsonValue | undefined;
}

const parseWireMessage = (raw: string): WireMessage => {
  const record = toRecord(JSON.parse(raw));
  const { type } = record;
  if (!isJsonString(type)) {
    throw new Error(`message without a type: ${raw}`);
  }
  return { data: record.data, type };
};

/**
 * Raw wire client speaking the party protocol directly. `_pk` is partyserver's
 * connection-id query param (PartySocket sends one too), so tests can pick
 * stable player ids for it. A reconnect token is derived from it unless one is
 * given (`_reconnectToken: ""` sends none). Auto-answers server pings so a
 * long test never gets a raw client evicted.
 */
class RawClient {
  readonly messages: WireMessage[] = [];
  readonly id: string;
  closed = false;
  closeCode: number | null = null;
  private ws: WebSocket;

  constructor(room: string, params: Record<string, string>) {
    const id = params._pk;
    if (!id) {
      throw new Error("RawClient requires an explicit _pk connection id");
    }
    this.id = id;
    const withToken = { _reconnectToken: `tok-${id}`, ...params };
    const query = new URLSearchParams(
      Object.entries(withToken).filter(([, value]) => value !== ""),
    ).toString();
    this.ws = new WebSocket(`ws://${worker.host}/parties/vg-server/${room}?${query}`);
    this.ws.addEventListener("close", (event) => {
      this.closed = true;
      this.closeCode = event.code;
    });
    this.ws.addEventListener("message", (event) => {
      const text = event.data;
      if (String(text) === text) {
        const message = parseWireMessage(text);
        if (message.type === "ping") {
          this.ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        this.messages.push(message);
      }
    });
  }

  send(message: JsonRecord): void {
    this.ws.send(JSON.stringify(message));
  }

  close(code?: number): void {
    this.ws.close(code);
  }

  synced(): boolean {
    return this.messages.some((message) => message.type === "sync");
  }

  /** All received messages of one type, data coerced to a record. */
  received(type: string): JsonRecord[] {
    return this.messages
      .filter((message) => message.type === type)
      .map((message) => toRecord(message.data));
  }

  /** The data of every received message of one type, as it came. */
  dataOf(type: string): JsonValue[] {
    return this.messages
      .filter((message) => message.type === type)
      .map((message) => message.data ?? null);
  }
}

test("the host's own state_patch is relayed to guests but never echoed back to it", async () => {
  const room = uniqueRoom("no-echo");
  const rawHost = new RawClient(room, { _pk: `echo-host-${process.pid}` });
  const guest = connect(room);
  try {
    await waitFor(() => rawHost.synced(), "raw host synced");
    await waitFor(() => admitted(guest), "guest admitted");
    assert.equal(guest.hostId, rawHost.id, "the raw client is host");

    rawHost.send({ data: [[["tick"], 1]], type: "state_patch" });
    rawHost.send({ data: [[["tick"], 2]], type: "state_patch" });
    await waitFor(() => guest.sharedState.tick === 2, "guest got both host patches");

    // Anything the server sent the host after its patches would have landed
    // before the guest's copy did; a guest event is a later fence.
    guest.sendEvent("fence", null, { to: rawHost.id });
    await waitFor(
      () => rawHost.received("event").some((data) => data.event === "fence"),
      "host received the fence",
    );
    assert.deepEqual(rawHost.received("state_patch"), [], "no state_patch echoed to the host");
  } finally {
    rawHost.close(1000);
    guest.destroy();
  }
});

/** A unit in the delta tests' made-up world. */
const grunt = (x: number): JsonRecord => ({ hp: 9, name: "grunt", x });

test("a write sends only the leaves that changed, and one task's writes leave as one message", async () => {
  const room = uniqueRoom("shared-deltas");
  const host = connect(room);
  let observer: RawClient | null = null;
  let guest: MultiplayerClient | null = null;
  try {
    await waitFor(() => admitted(host), "host admitted");
    const watching = new RawClient(room, { _pk: `delta-obs-${process.pid}` });
    observer = watching;
    const reader = connect(room);
    guest = reader;
    await waitFor(() => watching.synced() && admitted(reader), "observer and guest admitted");

    host.updateSharedState({
      grid: [0, 0, 0, 0],
      units: { a: grunt(1), b: grunt(2), c: grunt(3), d: grunt(4) },
    });
    await waitFor(() => watching.dataOf("state_patch").length === 1, "the first write");

    // One task: a unit moves, a cell changes, a unit dies.
    host.updateSharedState({ units: { a: grunt(5), b: grunt(2), c: grunt(3), d: grunt(4) } });
    host.updateSharedState({ grid: [0, 0, 1, 0] });
    host.updateSharedState(({ units, ...rest }) => {
      const { b: _dead, ...alive } = toRecord(units);
      return { ...rest, units: alive };
    });
    await waitFor(() => watching.dataOf("state_patch").length === 2, "the batched write");
    await waitFor(
      () => isDeepStrictEqual(reader.sharedState, host.sharedState),
      "the guest agrees",
    );
    // Let anything still queued land before counting.
    await delay(200);
    assert.deepEqual(watching.dataOf("state_patch"), [
      [
        [["grid"], [0, 0, 0, 0]],
        [["units"], { a: grunt(1), b: grunt(2), c: grunt(3), d: grunt(4) }],
      ],
      [[["grid", 2], 1], [["units", "a", "x"], 5], [["units", "b"]]],
    ]);
    assert.deepEqual(reader.sharedState, {
      grid: [0, 0, 1, 0],
      units: { a: grunt(5), c: grunt(3), d: grunt(4) },
    });
  } finally {
    observer?.close(1000);
    guest?.destroy();
    host.destroy();
  }
});

/** One message as a line: its type and what a test compares of it. */
const summary = (message: WireMessage): string => {
  if (message.type === "event") {
    const { event, payload } = toRecord(message.data);
    return `event ${String(event)} ${JSON.stringify(payload)}`;
  }
  if (message.type === "player_state") {
    return `player_state ${JSON.stringify(toRecord(message.data).state)}`;
  }
  return `${message.type} ${JSON.stringify(message.data)}`;
};

test("batched writes never overtake an event, nor a coalesced event a state write", async () => {
  const room = uniqueRoom("batch-order");
  const host = connect(room);
  let observer: RawClient | null = null;
  try {
    await waitFor(() => admitted(host), "host admitted");
    const watching = new RawClient(room, { _pk: `order-obs-${process.pid}` });
    observer = watching;
    await waitFor(() => watching.synced(), "observer synced");
    const from = watching.messages.length;

    host.updateMyState({ x: 1 });
    host.updateSharedState({ phase: "aim" });
    host.updateMyState({ y: 2 });
    host.sendEvent("cursor", 1, { coalesce: true });
    host.sendEvent("cursor", 2, { coalesce: true });
    host.updateSharedState({ phase: "fire" });
    host.sendEvent("shot", null);

    const order = (): string[] =>
      watching.messages
        .slice(from)
        .filter((message) => ["event", "player_state", "state_patch"].includes(message.type))
        .map(summary);
    await waitFor(() => order().includes("event shot null"), "the last message");
    await delay(200);
    assert.deepEqual(order(), [
      'player_state {"x":1,"y":2}',
      'state_patch [[["phase"],"aim"]]',
      "event cursor 2",
      'state_patch [[["phase"],"fire"]]',
      "event shot null",
    ]);
  } finally {
    observer?.close(1000);
    host.destroy();
  }
});

/**
 * One round of a made-up game's world: units move, spawn and die, a log grows
 * and is trimmed, a banner comes and goes.
 */
const worldStep = (prev: JsonRecord, roll: () => number, round: number): JsonRecord => {
  const units: JsonRecord = {};
  const previous = prev.units === undefined ? {} : toRecord(prev.units);
  for (const [id, unit] of Object.entries(previous)) {
    if (roll() < 0.15) {
      continue;
    }
    const body = toRecord(unit);
    units[id] = roll() < 0.6 ? { ...body, x: Math.round(roll() * 100) } : body;
  }
  if (roll() < 0.5) {
    units[`u${round}`] = { hp: 10, tags: roll() < 0.5 ? ["fresh"] : [], x: 0 };
  }
  const log = Array.isArray(prev.log) ? prev.log : [];
  const { banner: _banner, ...rest } = prev;
  const next: JsonRecord = {
    ...rest,
    log: roll() < 0.3 ? [...log, round].slice(-5) : log,
    round,
    units,
  };
  if (roll() < 0.5) {
    next.banner = { text: `round ${round}` };
  }
  return next;
};

test("over a run of writes, a guest and a late joiner hold exactly the host's state", async () => {
  const room = uniqueRoom("delta-run");
  const clientA = connect(room);
  const clientB = connect(room);
  let late: MultiplayerClient | null = null;
  try {
    await waitFor(() => admitted(clientA) && admitted(clientB), "both admitted");
    await waitFor(() => clientA.isHost || clientB.isHost, "a host is elected");
    const [writer, reader] = clientA.isHost ? [clientA, clientB] : [clientB, clientA];
    let seed = 11;
    const roll = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 1; round <= 60; round += 1) {
      writer.updateSharedState((prev) => worldStep(prev, roll, round));
      if (roll() < 0.4) {
        // A key that changes shape: an object, then an array, then back.
        writer.updateSharedState({ [`k${round % 3}`]: roll() < 0.5 ? { at: round } : [round] });
      }
      if (round % 4 === 0) {
        await delay(5);
      }
    }
    await waitFor(
      () => isDeepStrictEqual(reader.sharedState, writer.sharedState),
      "the guest caught up",
    );
    const joiner = connect(room);
    late = joiner;
    await waitFor(() => admitted(joiner), "late joiner admitted");
    assert.deepEqual(joiner.sharedState, writer.sharedState, "the server's copy is the host's");
  } finally {
    late?.destroy();
    clientA.destroy();
    clientB.destroy();
  }
});

test("a shared write made before admission reaches the room once it is in", async () => {
  const room = uniqueRoom("early-write");
  const host = connect(room);
  let guest: MultiplayerClient | null = null;
  try {
    host.updateSharedState({ early: { ready: true } });
    await waitFor(() => admitted(host), "host admitted");
    const reader = connect(room);
    guest = reader;
    await waitFor(() => admitted(reader), "guest admitted");
    await waitFor(
      () => isDeepStrictEqual(reader.sharedState, host.sharedState),
      "the guest agrees",
    );
    assert.deepEqual(reader.sharedState, { early: { ready: true } });
  } finally {
    guest?.destroy();
    host.destroy();
  }
});

test("targeted events reach exactly their audience", async () => {
  const room = uniqueRoom("targeting");
  const eventsA: string[] = [];
  const eventsB: string[] = [];
  const eventsC: string[] = [];
  const clientA = connect(room, { onEvent: (event) => eventsA.push(event) });
  const clientB = connect(room, { onEvent: (event) => eventsB.push(event) });
  const clientC = connect(room, { onEvent: (event) => eventsC.push(event) });
  try {
    await waitFor(
      () => admitted(clientA) && admitted(clientB) && admitted(clientC),
      "all three admitted",
    );
    const bId = clientB.playerId;
    const cId = clientC.playerId;
    assert.ok(bId !== null && cId !== null);

    // Per-connection delivery is FIFO, so once the untargeted fence lands
    // everywhere, any earlier event addressed to that recipient landed too.
    clientA.sendEvent("secret", null, { to: [bId] });
    clientA.sendEvent("fence-to", null);
    await waitFor(
      () =>
        eventsA.includes("fence-to") &&
        eventsB.includes("fence-to") &&
        eventsC.includes("fence-to"),
      "fence after to-targeted event reached everyone",
    );
    assert.ok(eventsB.includes("secret"), "targeted recipient got the event");
    assert.ok(!eventsA.includes("secret"), "sender not in `to` list is excluded");
    assert.ok(!eventsC.includes("secret"), "bystander is excluded");

    clientA.sendEvent("boom", null, { except: [cId] });
    clientA.sendEvent("fence-except", null);
    await waitFor(
      () =>
        eventsA.includes("fence-except") &&
        eventsB.includes("fence-except") &&
        eventsC.includes("fence-except"),
      "fence after except-targeted event reached everyone",
    );
    assert.ok(eventsA.includes("boom"), "sender receives its own except-broadcast");
    assert.ok(eventsB.includes("boom"), "unexcluded peer receives it");
    assert.ok(!eventsC.includes("boom"), "excepted peer is excluded");
  } finally {
    clientA.destroy();
    clientB.destroy();
    clientC.destroy();
  }
});

test("sendToHost reaches the host alone, and the host handles its own at once", async () => {
  const room = uniqueRoom("to-host");
  const heardA: [string, string][] = [];
  const heardB: [string, string][] = [];
  const heardC: [string, string][] = [];
  const clientA = connect(room, { onEvent: (event, _payload, from) => heardA.push([event, from]) });
  await waitFor(() => admitted(clientA), "A admitted first, so A hosts");
  const clientB = connect(room, { onEvent: (event, _payload, from) => heardB.push([event, from]) });
  const clientC = connect(room, { onEvent: (event, _payload, from) => heardC.push([event, from]) });
  try {
    await waitFor(() => admitted(clientB) && admitted(clientC), "guests admitted");
    const hostId = clientA.playerId;
    const guestId = clientB.playerId;
    assert.ok(hostId !== null && guestId !== null);
    assert.equal(clientB.hostId, hostId);

    clientA.sendToHost("host-intent", 1);
    assert.deepEqual(heardA, [["host-intent", hostId]], "handled before sendToHost returns");
    clientB.sendToHost("guest-intent", 2);
    await waitFor(() => heardA.length === 2, "the host hears the guest's intent");
    assert.deepEqual(heardA[1], ["guest-intent", guestId]);
    await delay(200);
    assert.deepEqual(heardB, [], "the sending guest doesn't hear its own intent");
    assert.deepEqual(heardC, [], "another guest hears neither");
  } finally {
    clientA.destroy();
    clientB.destroy();
    clientC.destroy();
  }
});

test("coalesced events collapse to the latest payload and never trail the state they precede", async () => {
  const room = uniqueRoom("coalesce");
  const clientA = connect(room);
  try {
    // A joins alone first so it is deterministically the host (and may write
    // shared state below).
    await waitFor(() => admitted(clientA), "A admitted");
    assert.equal(clientA.isHost, true);

    const arrivals: string[] = [];
    const clientB = connect(room, {
      onEvent: (event, payload) => arrivals.push(`event:${event}:${JSON.stringify(payload)}`),
    });
    const unsubscribe = clientB.subscribe(() => {
      if (clientB.sharedState.round === 1 && !arrivals.includes("state:round")) {
        arrivals.push("state:round");
      }
    });
    try {
      await waitFor(() => admitted(clientB), "B admitted");
      await waitFor(() => Object.keys(clientA.players).length === 2, "A sees B");

      // Burst five coalesced events, then a state write in the same tick. The
      // burst must collapse to ONE wire message carrying the last payload, and
      // it must arrive before the state patch it precedes.
      for (let i = 1; i <= 5; i += 1) {
        clientA.sendEvent("tick", { i }, { coalesce: true });
      }
      clientA.updateSharedState({ round: 1 });

      await waitFor(() => arrivals.includes("state:round"), "B saw the state write");
      const ticks = arrivals.filter((entry) => entry.startsWith("event:tick:"));
      assert.equal(ticks.length, 1, `burst collapsed to one event (got: ${ticks.join(", ")})`);
      assert.equal(ticks[0], 'event:tick:{"i":5}', "latest payload won");
      assert.ok(
        arrivals.indexOf(ticks[0]) < arrivals.indexOf("state:round"),
        "coalesced event arrived before the state patch sent after it",
      );
    } finally {
      unsubscribe();
      clientB.destroy();
    }
  } finally {
    clientA.destroy();
  }
});

test("a dropped player is held in grace, reclaimed by token, and a 1000-close leaves immediately", async () => {
  const room = uniqueRoom("grace");
  const clientB = connect(room);
  const rawId = `raw-grace-${process.pid}`;
  const token = `tok-grace-${process.pid}`;
  let rawA: RawClient | null = null;
  try {
    await waitFor(() => admitted(clientB), "B admitted");

    rawA = new RawClient(room, { _pk: rawId, _reconnectToken: token });
    await waitFor(() => rawA?.synced() === true, "raw A synced");
    rawA.send({ data: { hp: 5 }, type: "player_state_patch" });
    await waitFor(() => clientB.players[rawId]?.state?.hp === 5, "B sees A's state");

    // Abrupt close (≠1000): the seat must be HELD, flagged disconnected.
    rawA.close(4001);
    await waitFor(
      () => clientB.players[rawId]?.connected === false,
      "B sees A flagged disconnected during grace",
    );
    assert.ok(rawId in clientB.players, "A still occupies its seat mid-grace");
    assert.equal(clientB.players[rawId]?.state?.hp, 5, "held seat keeps its state");

    // Same token returns: seat + state come back, no longer flagged.
    rawA = new RawClient(room, { _pk: rawId, _reconnectToken: token });
    await waitFor(() => rawA?.synced() === true, "raw A reclaimed and synced");
    await waitFor(
      () => clientB.players[rawId] !== undefined && clientB.players[rawId]?.connected !== false,
      "B sees A connected again after reclaim",
    );
    assert.equal(clientB.players[rawId]?.state?.hp, 5, "reclaimed seat kept its state");

    // Deliberate leave (1000): removed well within the 30s grace window —
    // waitFor's 10s default timeout is itself the proof of immediacy.
    rawA.close(1000);
    await waitFor(() => !(rawId in clientB.players), "1000-close removes the player immediately");
  } finally {
    rawA?.close(1000);
    clientB.destroy();
  }
});

test("a page that unloads (1001) leaves at once: nothing can reclaim its seat", async () => {
  const room = uniqueRoom("going-away");
  const observer = connect(room);
  const rawId = `raw-away-${process.pid}`;
  try {
    await waitFor(() => admitted(observer), "observer admitted");
    // A browser closes an unloading page's sockets with 1001, which a WHATWG
    // WebSocket can't send; Miniflare's can.
    const query = new URLSearchParams({ _pk: rawId, _reconnectToken: `tok-away-${process.pid}` });
    const response = await miniflare.dispatchFetch(
      `http://localhost/parties/vg-server/${room}?${query}`,
      { headers: { Upgrade: "websocket" } },
    );
    const socket = response.webSocket;
    assert.ok(socket, "upgraded");
    socket.accept();
    await waitFor(() => rawId in observer.players, "observer sees the page's player");
    socket.close(1001, "going away");
    // waitFor's 10 s timeout, inside the 30 s grace window, is the proof.
    await waitFor(() => !(rawId in observer.players), "the seat frees at once, no grace");
  } finally {
    observer.destroy();
  }
});

test("player state fans out as keyed deltas; a client with no reconnect token is refused", async () => {
  const room = uniqueRoom("deltas");
  const observer = new RawClient(room, { _pk: `obs-${process.pid}` });
  const sdk = connect(room);
  try {
    await waitFor(() => observer.synced() && admitted(sdk), "both clients in the room");
    const sdkId = sdk.playerId;
    assert.ok(sdkId !== null);

    const states = (): JsonRecord[] =>
      observer
        .received("player_state")
        .filter((data) => data.id === sdkId)
        .map((data) => toRecord(data.state));
    // Two frames: writes in one task would leave as one message.
    sdk.updateMyState({ x: 1, y: 2 });
    await waitFor(() => states().length === 1, "observer saw the first player_state");
    sdk.updateMyState({ y: 3 });
    await waitFor(() => states().length === 2, "observer saw two player_state messages");
    assert.deepEqual(states()[1], { y: 3 }, "the second message carried only the changed key");

    const tokenless = new RawClient(room, { _pk: `anon-${process.pid}`, _reconnectToken: "" });
    await waitFor(() => tokenless.closed, "tokenless client closed");
    assert.equal(tokenless.closeCode, 4002, "closed as reconnect_token_required");
    assert.equal(tokenless.synced(), false, "never admitted");
  } finally {
    observer.close(1000);
    sdk.destroy();
  }
});

test("time probes give every client the server's clock", async () => {
  const room = uniqueRoom("time");
  const client = connect(room);
  try {
    await waitFor(() => admitted(client), "client admitted");
    await waitFor(() => client.serverClock.synced, "first probe answered");
    assert.ok(Number.isFinite(client.rtt) && client.rtt >= 0, "round trip measured");
    // workerd and this process read the same wall clock, so the estimate
    // should land within a round trip of it.
    const error = Math.abs(client.serverNow() - Date.now());
    assert.ok(error < 50 + client.rtt, `server clock off by ${error.toFixed(1)} ms`);
  } finally {
    client.destroy();
  }
});

test("claims go to the first claimer; the loser hears the owner; release, clear and TTL free them", async () => {
  const room = uniqueRoom("claims");
  const heardByA: [string, string | null][] = [];
  const clientA = connect(room, { onClaim: (key, owner) => heardByA.push([key, owner]) });
  await waitFor(() => admitted(clientA), "A admitted first (host)");
  const clientB = connect(room);
  try {
    await waitFor(() => admitted(clientB), "B admitted");
    assert.ok(clientA.isHost, "A hosts");
    const aId = clientA.playerId;
    const bId = clientB.playerId;
    assert.ok(aId !== null && bId !== null);

    clientB.claim("pellet:1");
    await waitFor(() => clientA.ownerOf("pellet:1") === bId, "A sees B's grant");
    clientA.claim("pellet:1");
    await waitFor(
      () => heardByA.filter(([key, owner]) => key === "pellet:1" && owner === bId).length === 2,
      "A's refused claim is answered with the owner (after the grant it heard)",
    );
    assert.equal(clientB.ownerOf("pellet:1"), bId, "B still owns it");

    clientB.release("pellet:1");
    await waitFor(() => clientA.ownerOf("pellet:1") === null, "release reaches A");

    clientA.claim("round:a");
    clientA.claim("round:b");
    clientA.claim("keep");
    await waitFor(() => clientB.ownerOf("keep") === aId, "B sees A's three claims");
    clientB.clearClaims("round:");
    clientA.clearClaims("round:");
    await waitFor(() => clientB.ownerOf("round:a") === null, "host clear reaches B");
    assert.equal(clientB.ownerOf("round:b"), null, "every key under the prefix cleared");
    assert.equal(clientB.ownerOf("keep"), aId, "other keys untouched");

    clientB.claim("brief", { ttlMs: 200 });
    await waitFor(() => clientA.ownerOf("brief") === bId, "A sees the TTL grant");
    await waitFor(() => !("brief" in clientA.claims), "the server announces the lapse");

    const heardByLate: [string, string | null][] = [];
    const late = connect(room, { onClaim: (key, owner) => heardByLate.push([key, owner]) });
    try {
      await waitFor(() => admitted(late), "late joiner admitted");
      assert.equal(late.ownerOf("keep"), aId, "sync carries live claims");
      assert.equal(late.ownerOf("brief"), null, "and not lapsed ones");
      assert.deepEqual(heardByLate, [["keep", aId]], "and reports them through onClaim");
    } finally {
      late.destroy();
    }
  } finally {
    clientA.destroy();
    clientB.destroy();
  }
});

test("interest: far players stop updating, return with their whole state, and the host sees everyone", async () => {
  const room = uniqueRoom("interest");
  const interest = { radius: 10 };
  const host = connect(room, { interest });
  await waitFor(() => admitted(host), "host admitted first");
  const clientA = connect(room, { interest });
  const clientB = connect(room, { interest });
  try {
    await waitFor(() => admitted(clientA) && admitted(clientB), "A and B admitted");
    const aId = clientA.playerId;
    const bId = clientB.playerId;
    assert.ok(aId !== null && bId !== null);
    host.updateMyState({ x: 0, y: 0 });
    clientA.updateMyState({ x: 0, y: 0 });
    clientB.updateMyState({ x: 100, y: 0 });
    await waitFor(() => clientA.players[bId]?.visible === false, "A loses sight of far-off B");
    await waitFor(() => clientB.players[aId]?.visible === false, "B loses sight of A");

    clientB.updateMyState({ hp: 7, x: 101 });
    await waitFor(() => host.players[bId]?.state?.x === 101, "the host still hears B");
    assert.notEqual(clientA.players[bId]?.state?.hp, 7, "A heard nothing while B was away");

    clientB.updateMyState({ x: 5 });
    await waitFor(() => clientA.players[bId]?.visible === true, "B comes back into A's view");
    assert.equal(clientA.players[bId]?.state?.hp, 7, "with the state that changed while hidden");
    assert.equal(clientA.players[bId]?.state?.x, 5);
    await waitFor(() => clientB.players[aId]?.visible === true, "and B sees A again");
  } finally {
    host.destroy();
    clientA.destroy();
    clientB.destroy();
  }
});

test("tick rooms: inputs land on numbered ticks, in order, held across a late join", async () => {
  const room = uniqueRoom("ticks");
  const seen: number[] = [];
  let landed: number | null = null;
  let cleared = false;
  const clientA = connect(room, { tickRate: 20 });
  await waitFor(() => admitted(clientA), "A admitted first (sets the rules)");
  const aId = clientA.playerId;
  assert.ok(aId !== null);
  const clientB = connect(room, {
    onTick: (tick) => {
      seen.push(tick.n);
      if (landed === null && aId in tick.changed) {
        landed = tick.n;
        assert.deepEqual(tick.inputs[aId], { dx: 1 }, "held inputs include the new one");
      }
      if (tick.changed[aId] === null) {
        cleared = true;
      }
    },
    tickRate: 30,
  });
  try {
    await waitFor(() => admitted(clientB), "B admitted");
    assert.equal(clientB.tickClock?.ms, 50, "the room keeps the first client's 20 Hz");

    clientA.sendInput({ dx: 1 });
    await waitFor(() => landed !== null, "B hears A's input on a tick");
    await waitFor(() => seen.length > 3, "ticks keep coming");
    for (let i = 1; i < seen.length; i += 1) {
      assert.equal(seen[i], (seen[i - 1] ?? 0) + 1, "ticks arrive in order with no gaps");
    }
    const lag = clientB.serverTick() - (clientB.tickClock?.n ?? 0);
    assert.ok(Math.abs(lag) <= 2, `serverTick tracks the broadcast (off by ${lag})`);

    const late = connect(room);
    try {
      await waitFor(() => admitted(late), "late joiner admitted");
      assert.deepEqual(late.tickInputs()?.[aId], { dx: 1 }, "sync carries every held input");
      assert.ok(landed !== null);
      assert.equal(late.tickInputs(landed - 1)?.[aId], undefined, "and the history before it");
    } finally {
      late.destroy();
    }

    clientA.destroy();
    await waitFor(() => cleared, "a departed player's input clears on a tick");
  } finally {
    clientA.destroy();
    clientB.destroy();
  }
});

test("a client back from a transport blip replays the ticks it missed, and its input resumes", async () => {
  const room = uniqueRoom("tick-replay");
  const seen: number[] = [];
  const client = connect(room, { onTick: (tick) => seen.push(tick.n), tickRate: 30 });
  try {
    await waitFor(() => admitted(client), "client admitted");
    const me = client.playerId;
    assert.ok(me !== null);
    client.sendInput("left");
    await waitFor(() => client.tickInputs()?.[me] === "left", "input held");

    // Drop the transport (not a deliberate leave), stay away a dozen ticks, come back.
    // The SDK exposes no way to drop its transport, and only a dropped
    // transport (not a leave) exercises the replay, so reach its socket.
    // oxlint-disable-next-line anti-slop/no-reflect-get -- a test simulating a network blip on the SDK's private socket
    const socket: { close: (code: number) => void; reconnect: () => void } = Reflect.get(
      client,
      "socket",
    );
    socket.close(4000);
    await waitFor(() => client.connectionStatus === "reconnecting", "transport down");
    const away = seen.length;
    await delay(400);
    assert.equal(seen.length, away, "no ticks while away");
    socket.reconnect();
    await waitFor(() => admitted(client) && seen.length > away + 12, "back, and caught up");

    for (let i = 1; i < seen.length; i += 1) {
      assert.equal(seen[i], (seen[i - 1] ?? 0) + 1, `tick ${seen[i]} follows ${seen[i - 1]}`);
    }
    await waitFor(() => client.tickInputs()?.[me] === "left", "the held input was re-sent");
  } finally {
    client.destroy();
  }
});

test("a client back from a drop sends the latest of each stream once, not every frame it made away", async () => {
  const room = uniqueRoom("drop-streams");
  const host = connect(room, { tickRate: 30 });
  let observer: RawClient | null = null;
  try {
    // The SDK client joins first, so it hosts.
    await waitFor(() => admitted(host), "host admitted");
    const hostId = host.playerId;
    assert.ok(hostId !== null);
    assert.equal(host.hostId, hostId, "the SDK client hosts");
    const watching = new RawClient(room, { _pk: `drop-obs-${process.pid}` });
    observer = watching;
    await waitFor(() => watching.synced(), "observer synced");

    // oxlint-disable-next-line anti-slop/no-reflect-get -- a test simulating a network blip on the SDK's private socket
    const socket: { close: (code: number) => void; reconnect: () => void } = Reflect.get(
      host,
      "socket",
    );
    socket.close(4000);
    await waitFor(() => host.connectionStatus === "reconnecting", "transport down");
    // Two seconds of a 30 Hz game loop, all while away.
    for (let frame = 1; frame <= 60; frame += 1) {
      host.updateMyState({ frame });
      host.updateSharedState({ frame });
      host.sendInput(frame);
    }
    const from = watching.messages.length;
    socket.reconnect();

    const since = (type: string): JsonRecord[] =>
      watching.messages
        .slice(from)
        .filter((message) => message.type === type)
        .map((message) => toRecord(message.data));
    // The host's inputs on the observer's ticks, less the server's own null
    // clearing them when the transport dropped.
    const hostInputs = (): JsonValue[] =>
      since("tick").flatMap((data) => {
        const input = toRecord(data.i)[hostId];
        return input === undefined || input === null ? [] : [input];
      });
    await waitFor(
      () =>
        since("player_state").length > 0 &&
        watching.dataOf("state_patch").length > 0 &&
        hostInputs().length > 0,
      "the observer hears the host's state, world and input again",
    );
    // Let anything still queued land before counting.
    await delay(300);
    assert.deepEqual(
      since("player_state").map((data) => data.state),
      [{ frame: 60 }],
      "the player's state arrives once, as it stands",
    );
    assert.deepEqual(
      watching.dataOf("state_patch"),
      [[[["frame"], 60]]],
      "the world arrives once, as it stands",
    );
    assert.deepEqual(hostInputs(), [60], "the held input arrives, and no stale one");
  } finally {
    observer?.close(1000);
    host.destroy();
  }
});

test("a quiet tick room's history still ends MAX_TICK_HISTORY ticks back", async () => {
  const room = uniqueRoom("tick-quiet");
  const client = connect(room, { tickRate: MAX_TICK_RATE });
  const past = MAX_TICK_HISTORY + 30;
  try {
    await waitFor(() => admitted(client), "client admitted");
    // No input ever changes, so the tick log stays empty the whole time.
    await waitFor(
      () => (client.tickClock?.n ?? 0) > past,
      "the room ticks past its history",
      (past / MAX_TICK_RATE) * 1000 + 5000,
    );
    assert.equal(client.tickInputs(1), null, "the client's history moved on");
    const raw = new RawClient(room, { _pk: `quiet-${process.pid}` });
    try {
      await waitFor(() => raw.synced(), "raw client admitted");
      const [sync] = raw.received("sync");
      const tick = toRecord(sync?.tick);
      assert.equal(
        Number(tick.base),
        Number(tick.n) - MAX_TICK_HISTORY,
        "and so did the room's: a client further back resyncs instead of replaying it all",
      );
    } finally {
      raw.close(1000);
    }
  } finally {
    client.destroy();
  }
});

test("a room's world and claims survive a server restart, and its host re-sends what was lost", async () => {
  const room = uniqueRoom("restart");
  const host = connect(room);
  await waitFor(() => admitted(host), "host admitted first");
  const guest = connect(room);
  let drops = 0;
  const unsubscribe = guest.subscribe(() => {
    if (guest.connectionStatus === "reconnecting") {
      drops += 1;
    }
  });
  try {
    await waitFor(() => admitted(guest), "guest admitted");
    host.updateSharedState({ level: 3 });
    host.claim("door");
    await waitFor(
      () => guest.sharedState.level === 3 && guest.ownerOf("door") === host.playerId,
      "guest sees the world and the claim",
    );
    // Past the persist debounce, then a change too new to have been persisted.
    await delay(1500);
    host.updateSharedState({ level: 4 });
    await waitFor(() => guest.sharedState.level === 4, "guest sees the newest world");

    await miniflare.setOptions(miniflareOptions);
    await waitFor(() => drops > 0, "the restart dropped the guest");
    await waitFor(() => admitted(host) && admitted(guest), "both reconnected");

    const late = connect(room);
    try {
      await waitFor(() => admitted(late), "late joiner admitted after the restart");
      assert.equal(late.ownerOf("door"), host.playerId, "the claim was persisted");
      await waitFor(() => late.sharedState.level === 4, "the host re-sent the newer world");
    } finally {
      late.destroy();
    }
  } finally {
    unsubscribe();
    host.destroy();
    guest.destroy();
  }
});

test("a dropped player's inputs scheduled ahead are cancelled, not replayed later", async () => {
  const room = uniqueRoom("tick-cancel");
  const observer = connect(room, { tickRate: 30 });
  await waitFor(() => admitted(observer), "observer admitted first (sets the rules)");
  const raw = new RawClient(room, { _pk: `ahead-${process.pid}` });
  const heard: (JsonValue | undefined)[] = [];
  let last = 0;
  observer.onTick = (tick) => {
    last = tick.n;
    if (raw.id in tick.changed) {
      heard.push(tick.changed[raw.id]);
    }
  };
  try {
    await waitFor(() => raw.synced() && last > 0, "raw client admitted and ticks flowing");
    // Twenty ticks ahead (~0.7 s), then the transport drops before it lands.
    raw.send({ data: { n: last + 20, v: "ahead" }, type: "input" });
    raw.close(4000);
    await waitFor(() => heard.includes(null), "the drop clears its input");
    const clearedAt = last;
    await waitFor(() => last > clearedAt + 30, "well past the tick it was scheduled for");
    assert.deepEqual(heard, [null], "the input scheduled ahead never landed");
  } finally {
    observer.destroy();
  }
});

test("a room's rules come from its first client, even when that client sets none", async () => {
  const room = uniqueRoom("rules-frozen");
  const first = connect(room);
  await waitFor(() => admitted(first), "first client admitted, with no rules");
  const late = connect(room, { tickRate: 30 });
  try {
    await waitFor(() => admitted(late), "late client admitted");
    assert.equal(late.tickClock, null, "the late client's tick rate was not adopted");
  } finally {
    first.destroy();
    late.destroy();
  }
});

test("reserved claim keys are refused, so every client's claim map agrees", async () => {
  const room = uniqueRoom("claim-reserved");
  const heard: [string, string | null][] = [];
  const observer = connect(room, { onClaim: (key, owner) => heard.push([key, owner]) });
  await waitFor(() => admitted(observer), "observer admitted");
  const raw = new RawClient(room, { _pk: `proto-${process.pid}` });
  try {
    await waitFor(() => raw.synced(), "raw client admitted");
    raw.send({ data: { key: "__proto__" }, type: "claim" });
    raw.send({ data: { key: "ok" }, type: "claim" });
    await waitFor(() => heard.length > 0, "the valid claim is granted");
    assert.deepEqual(heard, [["ok", raw.id]], "the reserved key was never granted");
    const late = connect(room);
    try {
      await waitFor(() => admitted(late), "late joiner admitted");
      assert.deepEqual(Object.keys(late.claims), ["ok"], "and the sync agrees");
    } finally {
      late.destroy();
    }
  } finally {
    raw.close(1000);
    observer.destroy();
  }
});

test("a claim whose ttl isn't positive is refused, not held for good", async () => {
  const room = uniqueRoom("claim-ttl");
  const heard: [string, string | null][] = [];
  const observer = connect(room, { onClaim: (key, owner) => heard.push([key, owner]) });
  await waitFor(() => admitted(observer), "observer admitted");
  const raw = new RawClient(room, { _pk: `ttl-${process.pid}` });
  try {
    await waitFor(() => raw.synced(), "raw client admitted");
    for (const ttl of [0, -500, null]) {
      raw.send({ data: { key: "door", ttl }, type: "claim" });
    }
    raw.send({ data: { key: "ok" }, type: "claim" });
    await waitFor(() => heard.length > 0, "the valid claim is granted");
    assert.deepEqual(heard, [["ok", raw.id]], "no claim with a bad ttl was granted");
    observer.claim("door");
    await waitFor(() => heard.length > 1, "the door is claimed");
    assert.deepEqual(heard[1], ["door", observer.playerId], "and it was still free");
  } finally {
    raw.close(1000);
    observer.destroy();
  }
});

test("declared limits drop out-of-range player state", async () => {
  const room = uniqueRoom("limits");
  const limits = { hp: { max: 100, min: 0 } };
  const raw = new RawClient(room, { _pk: `lim-${process.pid}`, _room: JSON.stringify({ limits }) });
  try {
    await waitFor(() => raw.synced(), "raw client admitted (sets the rules)");
    const observer = connect(room);
    try {
      await waitFor(() => admitted(observer), "observer admitted");
      raw.send({ data: { hp: 500 }, type: "player_state_patch" });
      raw.send({ data: { hp: "full" }, type: "player_state_patch" });
      raw.send({ data: { hp: 50 }, type: "player_state_patch" });
      await waitFor(() => observer.players[raw.id]?.state?.hp === 50, "the in-range patch lands");
      assert.equal(
        observer.players[raw.id]?.state?.hp,
        50,
        "neither the out-of-range nor the non-numeric patch got through",
      );
    } finally {
      observer.destroy();
    }
  } finally {
    raw.close(1000);
  }
});

test("an emptied room forgets its rules, claims and world", async () => {
  const room = uniqueRoom("reset");
  const first = connect(room, { tickRate: 10 });
  try {
    await waitFor(() => admitted(first), "first session admitted");
    assert.equal(first.tickClock?.ms, 100, "the room ticks at 10 Hz");
    first.updateSharedState({ level: 3 });
    // Same socket, so the server merged the world before it granted this.
    first.claim("k");
    await waitFor(() => first.ownerOf("k") !== null, "claim granted");
  } finally {
    first.destroy();
  }
  const deadline = Date.now() + 10_000;
  for (;;) {
    const info = await roomInfo(room);
    if (info.playerCount === 0) {
      break;
    }
    assert.ok(Date.now() < deadline, "the room never emptied");
    await delay(25);
  }
  const second = connect(room);
  try {
    await waitFor(() => admitted(second), "second session admitted");
    assert.equal(second.tickClock, null, "no tick: the new session set no rules");
    assert.equal(second.ownerOf("k"), null, "claims cleared");
    assert.equal(second.sharedState.level, undefined, "world cleared");
  } finally {
    second.destroy();
  }
});

test("a shared write the server would refuse is undone on the writer too", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const room = uniqueRoom("refused-local");
  const host = connect(room);
  try {
    await waitFor(() => admitted(host), "host admitted");
    const guest = connect(room);
    try {
      await waitFor(() => admitted(guest), "guest admitted");
      host.updateSharedState({ keep: 1 });
      await waitFor(() => guest.sharedState.keep === 1, "a valid write lands");

      // Past the message cap: the client refuses it before it leaves.
      host.updateSharedState({ big: "x".repeat(1_100_000), keep: 2 });
      await waitFor(() => host.sharedState.keep === 1, "the host's copy went back to the room's");
      assert.equal(host.sharedState.big, undefined, "a key the room never had is gone again");
      assert.equal(warn.mock.callCount(), 1, "the refusal warned once");

      host.updateSharedState({ after: true });
      await waitFor(
        () => guest.sharedState.after === true,
        "a write after the refusal still lands",
      );
      assert.equal(guest.sharedState.keep, 1, "the guest never saw the refused write");
      assert.equal(guest.sharedState.big, undefined);
    } finally {
      guest.destroy();
    }
  } finally {
    host.destroy();
  }
});

test("malformed and oversized state patches are dropped without harming the room", async () => {
  const room = uniqueRoom("validation");
  // Raw host joins first: only the host may write shared state, and only a raw
  // client can put malformed payloads on the wire.
  const rawHost = new RawClient(room, { _pk: `val-host-${process.pid}` });
  try {
    await waitFor(() => rawHost.synced(), "raw host admitted before guest connects");
    const guest = connect(room);
    try {
      await waitFor(() => admitted(guest), "guest admitted");
      assert.equal(guest.hostId, rawHost.id, "raw sender owns shared state");

      rawHost.send({ data: [[["__proto__", "polluted"], true]], type: "state_patch" });
      rawHost.send({
        data: [[["safe"], { ["__proto__"]: { polluted: true } }]],
        type: "state_patch",
      });
      rawHost.send({ data: "not-ops", type: "state_patch" });
      rawHost.send({ data: { record: "not ops" }, type: "state_patch" });
      rawHost.send({ data: [[[], ["a", "b"]]], type: "state_patch" });
      rawHost.send({ data: [[["blob"], "x".repeat(1_100_000)]], type: "state_patch" });
      // Fence: same sender, so the server processed (and dropped) every
      // reject before this valid patch.
      rawHost.send({ data: [[["ok"], 1]], type: "state_patch" });

      await waitFor(() => guest.sharedState.ok === 1, "valid patch after rejects still lands");
      assert.equal(
        Object.hasOwn(guest.sharedState, "__proto__"),
        false,
        "prototype-polluting key never reached the guest",
      );
      assert.equal(guest.sharedState.safe, undefined, "a prototype key inside a value was refused");
      assert.equal(guest.sharedState.record, undefined, "a record is not a patch");
      assert.equal(guest.sharedState.blob, undefined, "oversized frame was refused");
      assert.equal(
        Object.keys(guest.sharedState).some((key) => /^\d+$/u.test(key)),
        false,
        "non-object root never scattered index keys into shared state",
      );
      assert.equal(rawHost.closed, false, "rejects did not kill the host's connection");
    } finally {
      guest.destroy();
    }
  } finally {
    rawHost.close(1000);
  }
});

test("goOffline leaves the room at once and plays on alone from the room's world", async () => {
  const room = uniqueRoom("go-offline");
  const host = connect(room);
  await waitFor(() => admitted(host), "host admitted first");
  const heard: string[] = [];
  const guest = connect(room, { onEvent: (event) => heard.push(event) });
  try {
    assert.equal(guest.connectionStatus, "connecting", "not admitted yet");
    await waitFor(() => admitted(guest), "guest admitted");
    const guestId = guest.playerId;
    assert.ok(guestId !== null);
    host.updateSharedState({ level: 2 });
    await waitFor(() => guest.sharedState.level === 2, "guest sees the world");

    guest.goOffline();
    assert.equal(guest.connectionStatus, "offline");
    assert.ok(guest.isHost, "alone, it hosts");
    assert.equal(guest.sharedState.level, 2, "the room's world carries over");
    // Well inside the 30 s grace window: waitFor's 10 s timeout is the proof.
    await waitFor(() => !(guestId in host.players), "the room frees the seat at once");

    guest.updateSharedState({ level: 3 });
    guest.sendEvent("ping", 1);
    assert.deepEqual(heard, ["ping"], "its own events loop back");
    await delay(200);
    assert.equal(host.sharedState.level, 2, "nothing it writes offline reaches the room");
  } finally {
    host.destroy();
    guest.destroy();
  }
});

test("when the host leaves, a remaining guest is promoted", async () => {
  const room = uniqueRoom("promotion");
  const clientA = connect(room);
  const clientB = connect(room);
  try {
    await waitFor(() => admitted(clientA) && admitted(clientB), "both clients admitted");
    await waitFor(() => clientA.isHost || clientB.isHost, "a host is elected");
    const host = clientA.isHost ? clientA : clientB;
    const guest = clientA.isHost ? clientB : clientA;
    const hostPlayerId = host.playerId;
    assert.ok(hostPlayerId !== null);

    host.destroy();

    await waitFor(() => guest.isHost, "guest promoted to host after host left");
    await waitFor(
      () => hostPlayerId !== null && !(hostPlayerId in guest.players),
      "departed host removed from player map",
    );
  } finally {
    clientA.destroy();
    clientB.destroy();
  }
});

test("a locked room sends newcomers on to an overflow room, and its meta reaches everyone", async () => {
  const room = uniqueRoom("lock");
  const host = connect(room);
  const clients: MultiplayerClient[] = [host];
  try {
    await waitFor(() => admitted(host), "host admitted");
    const guest = connect(room);
    clients.push(guest);
    await waitFor(() => admitted(guest), "guest admitted");

    host.setRoomInfo({ locked: true, meta: { mode: "duel" } });
    await waitFor(() => guest.roomInfo.locked && host.roomInfo.locked, "both hear the lock");
    assert.deepEqual(guest.roomInfo, { locked: true, meta: { mode: "duel" } });

    // Neither a guest nor oversized meta moves the room.
    guest.setRoomInfo({ locked: false });
    host.setRoomInfo({ meta: { blob: "x".repeat(MAX_ROOM_META_CHARS) } });
    host.sendEvent("fence", null);
    await delay(200);
    assert.deepEqual(host.roomInfo, { locked: true, meta: { mode: "duel" } });

    const late = connect(room);
    clients.push(late);
    await waitFor(() => admitted(late), "the newcomer is admitted somewhere");
    assert.equal(late.room, `${room}~2`, "a locked room sends a newcomer on");
    assert.equal(Object.keys(host.players).length, 2, "the locked room kept its two");

    host.setRoomInfo({ locked: false });
    await waitFor(() => !guest.roomInfo.locked, "the unlock reaches the guest");
    const later = connect(room);
    clients.push(later);
    await waitFor(() => admitted(later), "the next newcomer is admitted");
    assert.equal(later.room, room, "an unlocked room takes newcomers again");
    assert.deepEqual(later.roomInfo, { locked: false, meta: { mode: "duel" } }, "sync carries it");
  } finally {
    for (const client of clients) {
      client.destroy();
    }
  }
});

test("a dropped player reclaims its seat in a locked room", async () => {
  const room = uniqueRoom("lock-reclaim");
  const host = connect(room);
  let back: RawClient | null = null;
  try {
    await waitFor(() => admitted(host), "host admitted");
    const guest = new RawClient(room, { _pk: `lock-guest-${process.pid}` });
    await waitFor(() => guest.synced(), "guest admitted");
    host.setRoomInfo({ locked: true });
    await waitFor(() => host.roomInfo.locked, "locked");

    guest.close(4000);
    await waitFor(() => host.players[guest.id]?.connected === false, "the seat is held");
    const returning = new RawClient(room, { _pk: guest.id });
    back = returning;
    await waitFor(() => returning.synced() || returning.closed, "the guest is answered");
    assert.equal(returning.synced(), true, "a reclaim is not turned away");
    assert.deepEqual(returning.received("room_full"), []);
  } finally {
    back?.close(1000);
    host.destroy();
  }
});

/** Each test gets its own lobby, as it gets its own rooms. */
const uniqueLobby = (label: string): string => uniqueRoom(`lobby-${label}`).replaceAll("~", "-");

test("a lobby lists its rooms with players, lock and meta; a private room stays off it", async () => {
  const lobby = uniqueLobby("list");
  const roomA = uniqueRoom("listed-a");
  const roomB = uniqueRoom("listed-b");
  const roomP = uniqueRoom("private");
  const hostA = connect(roomA, { lobby });
  const guestA = connect(roomA, { lobby });
  const hostB = connect(roomB, { lobby, maxPlayers: 4 });
  const hostP = connect(roomP);
  const clients = [hostA, guestA, hostB, hostP];
  const host = { host: worker.origin, lobby };
  try {
    await waitFor(() => clients.every(admitted), "everyone admitted");
    const leaderA = hostA.isHost ? hostA : guestA;
    leaderA.setRoomInfo({ meta: { mode: "ffa" } });
    await eventually(async () => {
      const rooms = await listRooms(host);
      return rooms.length === 2 && rooms.some((entry) => entry.meta.mode === "ffa");
    }, "both rooms listed, the meta with them");
    assert.deepEqual(await listRooms(host), [
      { capacity: null, locked: false, meta: { mode: "ffa" }, players: 2, room: roomA },
      { capacity: 4, locked: false, meta: {}, players: 1, room: roomB },
    ]);

    hostB.destroy();
    await eventually(async () => {
      const rooms = await listRooms(host);
      return rooms.every((entry) => entry.room !== roomB);
    }, "an emptied room leaves the lobby");
  } finally {
    for (const client of clients) {
      client.destroy();
    }
  }
});

test("quick match fills one room before opening another, and skips a locked one", async () => {
  const lobby = uniqueLobby("match");
  const options = { host: worker.origin, lobby, maxPlayers: 2 };
  const clients: MultiplayerClient[] = [];
  try {
    const first = await quickMatch(options);
    const second = await quickMatch(options);
    const third = await quickMatch(options);
    assert.equal(second, first, "a seat is held for each match, so two fill one room");
    assert.notEqual(third, first, "a full room sends the third to a new one");
    assert.ok(first.startsWith(`${lobby}-`), "a new room is named after its lobby");

    for (const room of [first, first, third]) {
      const client = connect(room, { lobby, maxPlayers: 2 });
      clients.push(client);
      await waitFor(() => admitted(client), `admitted to ${room}`);
    }
    await eventually(async () => {
      const rooms = await listRooms(options);
      return (
        rooms.length === 2 &&
        rooms.every((entry) => entry.players === (entry.room === first ? 2 : 1))
      );
    }, "both rooms listed with their players");

    const lone = clients.at(-1);
    lone?.setRoomInfo({ locked: true });
    await eventually(async () => {
      const rooms = await listRooms(options);
      return rooms.some((entry) => entry.room === third && entry.locked);
    }, "the lock is listed");
    const fourth = await quickMatch(options);
    assert.ok(fourth !== first && fourth !== third, "neither a full nor a locked room is matched");

    await assert.rejects(quickMatch({ ...options, lobby: "no spaces" }), /not a lobby name/u);
  } finally {
    for (const client of clients) {
      client.destroy();
    }
  }
});
