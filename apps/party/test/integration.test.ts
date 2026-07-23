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
