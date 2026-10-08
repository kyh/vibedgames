import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Miniflare } from "miniflare";
import type { MiniflareOptions } from "miniflare";
import { z } from "zod";

import type { MultiplayerClientOptions } from "@vibedgames/multiplayer";
import { MultiplayerClient } from "@vibedgames/multiplayer";

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
    durableObjects: { VgServer: "VgServer" },
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
    "interest" | "limits" | "onClaim" | "onEvent" | "onTick" | "tickRate"
  >,
): MultiplayerClient =>
  new MultiplayerClient({
    host: worker.origin,
    party: "vg-server",
    room,
    ...options,
  });

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
}

test("the host's own state_patch is relayed to guests but never echoed back to it", async () => {
  const room = uniqueRoom("no-echo");
  const rawHost = new RawClient(room, { _pk: `echo-host-${process.pid}` });
  const guest = connect(room);
  try {
    await waitFor(() => rawHost.synced(), "raw host synced");
    await waitFor(() => admitted(guest), "guest admitted");
    assert.equal(guest.hostId, rawHost.id, "the raw client is host");

    rawHost.send({ data: { tick: 1 }, type: "state_patch" });
    rawHost.send({ data: { tick: 2 }, type: "state_patch" });
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

test("player state fans out as keyed deltas; a client with no reconnect token is refused", async () => {
  const room = uniqueRoom("deltas");
  const observer = new RawClient(room, { _pk: `obs-${process.pid}` });
  const sdk = connect(room);
  try {
    await waitFor(() => observer.synced() && admitted(sdk), "both clients in the room");
    const sdkId = sdk.playerId;
    assert.ok(sdkId !== null);

    sdk.updateMyState({ x: 1, y: 2 });
    sdk.updateMyState({ y: 3 });
    const states = (): JsonRecord[] =>
      observer
        .received("player_state")
        .filter((data) => data.id === sdkId)
        .map((data) => toRecord(data.state));
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
    await waitFor(() => client.connectionStatus === "disconnected", "transport down");
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

test("a room's world and claims survive a server restart, and its host re-sends what was lost", async () => {
  const room = uniqueRoom("restart");
  const host = connect(room);
  await waitFor(() => admitted(host), "host admitted first");
  const guest = connect(room);
  let drops = 0;
  const unsubscribe = guest.subscribe(() => {
    if (guest.connectionStatus === "disconnected") {
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

      rawHost.send({ data: { ["__proto__"]: { polluted: true } }, type: "state_patch" });
      rawHost.send({ data: "not-an-object", type: "state_patch" });
      rawHost.send({ data: { blob: "x".repeat(1_100_000) }, type: "state_patch" });
      // Fence: same sender, so the server processed (and dropped) all three
      // rejects before this valid patch.
      rawHost.send({ data: { ok: 1 }, type: "state_patch" });

      await waitFor(() => guest.sharedState.ok === 1, "valid patch after rejects still lands");
      assert.equal(
        Object.hasOwn(guest.sharedState, "__proto__"),
        false,
        "prototype-polluting key never reached the guest",
      );
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
