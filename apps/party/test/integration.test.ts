import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Unstable_DevWorker } from "wrangler";
import { unstable_dev } from "wrangler";

import type { MultiplayerClientOptions } from "@vibedgames/multiplayer";
import { MultiplayerClient } from "@vibedgames/multiplayer";

/**
 * Integration tests that drive the real VgServer — Durable Object, partyserver
 * routing, wire protocol and all — through wrangler's local runtime
 * (`unstable_dev` → workerd), with `MultiplayerClient` instances as the
 * clients. Node 22+ provides the global WebSocket that PartySocket picks up,
 * and the client's heartbeat falls back to setInterval off-browser, so the SDK
 * runs here unmodified.
 */

let worker: Unstable_DevWorker;

before(async () => {
  worker = await unstable_dev("src/server.ts", {
    config: "wrangler.jsonc",
    logLevel: "error",
    experimental: { disableExperimentalWarning: true },
  });
});

after(async () => {
  await worker.stop();
});

/** Each test gets its own room, i.e. its own Durable Object instance. */
let roomCounter = 0;
const uniqueRoom = (label: string): string => `it-${process.pid}-${roomCounter++}-${label}`;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  options?: Pick<MultiplayerClientOptions, "onEvent">,
): MultiplayerClient =>
  new MultiplayerClient({
    host: `http://${worker.address}:${worker.port}`,
    party: "vg-server",
    room,
    ...options,
  });

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
  const clientB = connect(room);
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
// Some behaviors are only observable at the wire (per-recipient delta vs full
// snapshots) or require a client the SDK deliberately doesn't expose (legacy
// pre-delta clients, abrupt non-1000 closes, a chosen reconnect token). A
// minimal raw-WebSocket client covers those; everything else uses the real SDK.

/** Structural record view of an unknown value; throws when it isn't one. */
const toRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected a plain object, got: ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value));
};

type WireMessage = { type: string; data: unknown };

const parseWireMessage = (raw: string): WireMessage => {
  const record = toRecord(JSON.parse(raw));
  const { type } = record;
  if (typeof type !== "string") throw new Error(`message without a type: ${raw}`);
  return { type, data: record.data };
};

/**
 * Raw wire client speaking the party protocol directly. `_pk` is partyserver's
 * connection-id query param (PartySocket sends one too), so tests can pick
 * stable player ids for it. Auto-answers server pings so a long test never
 * gets a raw client evicted.
 */
class RawClient {
  readonly messages: WireMessage[] = [];
  readonly id: string;
  closed = false;
  private ws: WebSocket;

  constructor(room: string, params: Record<string, string>) {
    const id = params._pk;
    if (!id) throw new Error("RawClient requires an explicit _pk connection id");
    this.id = id;
    const query = new URLSearchParams(params).toString();
    this.ws = new WebSocket(
      `ws://${worker.address}:${worker.port}/parties/vg-server/${room}?${query}`,
    );
    this.ws.addEventListener("close", () => {
      this.closed = true;
    });
    this.ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = parseWireMessage(event.data);
      if (message.type === "ping") {
        this.ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      this.messages.push(message);
    });
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  close(code?: number): void {
    this.ws.close(code);
  }

  synced(): boolean {
    return this.messages.some((message) => message.type === "sync");
  }

  /** All received messages of one type, data coerced to a record. */
  received(type: string): Record<string, unknown>[] {
    return this.messages
      .filter((message) => message.type === type)
      .map((message) => toRecord(message.data));
  }
}

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
      for (let i = 1; i <= 5; i++) {
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
    rawA.send({ type: "player_state_patch", data: { hp: 5 } });
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

test("delta-capable clients get keyed deltas; legacy clients get full snapshots and can still write", async () => {
  const room = uniqueRoom("deltas");
  const legacy = new RawClient(room, { _pk: `leg-${process.pid}` });
  const modern = new RawClient(room, {
    _pk: `mod-${process.pid}`,
    _delta: "1",
    _reconnectToken: `tok-mod-${process.pid}`,
  });
  const sdk = connect(room);
  try {
    await waitFor(
      () => legacy.synced() && modern.synced() && admitted(sdk),
      "all three clients in the room",
    );
    const sdkId = sdk.playerId;
    assert.ok(sdkId !== null);

    sdk.updateMyState({ x: 1, y: 2 });
    sdk.updateMyState({ y: 3 });

    const statesFor = (client: RawClient): Record<string, unknown>[] =>
      client
        .received("player_state")
        .filter((data) => data.id === sdkId)
        .map((data) => toRecord(data.state));
    await waitFor(
      () => statesFor(legacy).length === 2 && statesFor(modern).length === 2,
      "both observers saw two player_state messages",
    );

    // Second update changed only `y`. A legacy observer must still get the
    // full merged snapshot; a delta-capable one gets just the changed key.
    assert.deepEqual(statesFor(legacy)[1], { x: 1, y: 3 }, "legacy got the full merged snapshot");
    assert.deepEqual(statesFor(modern)[1], { y: 3 }, "delta client got only the changed key");

    // A legacy client's full-state write still round-trips.
    legacy.send({ type: "player_state_patch", data: { a: 1, b: 2 } });
    await waitFor(() => {
      const seen = sdk.players[legacy.id]?.state;
      return seen !== undefined && seen.a === 1 && seen.b === 2;
    }, "SDK client sees the legacy client's state");
  } finally {
    legacy.close(1000);
    modern.close(1000);
    sdk.destroy();
  }
});

test("malformed and oversized state patches are dropped without harming the room", async () => {
  const room = uniqueRoom("validation");
  // Raw host joins first: only the host may write shared state, and only a raw
  // client can put malformed payloads on the wire.
  const rawHost = new RawClient(room, { _pk: `val-host-${process.pid}` });
  const guest = connect(room);
  try {
    await waitFor(() => rawHost.synced() && admitted(guest), "host and guest in the room");

    rawHost.send({ type: "state_patch", data: { ["__proto__"]: { polluted: true } } });
    rawHost.send({ type: "state_patch", data: "not-an-object" });
    rawHost.send({ type: "state_patch", data: { blob: "x".repeat(1_100_000) } });
    // Fence: same sender, so the server processed (and dropped) all three
    // rejects before this valid patch.
    rawHost.send({ type: "state_patch", data: { ok: 1 } });

    await waitFor(() => guest.sharedState.ok === 1, "valid patch after rejects still lands");
    assert.equal(
      Object.prototype.hasOwnProperty.call(guest.sharedState, "__proto__"),
      false,
      "prototype-polluting key never reached the guest",
    );
    assert.equal(guest.sharedState.blob, undefined, "oversized frame was refused");
    assert.equal(
      Object.keys(guest.sharedState).some((key) => /^\d+$/.test(key)),
      false,
      "non-object root never scattered index keys into shared state",
    );
    assert.equal(rawHost.closed, false, "rejects did not kill the host's connection");
  } finally {
    rawHost.close(1000);
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
