import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { MultiplayerClient } from "../src/client.js";
import { OFFLINE_PLAYER_ID } from "../src/types.js";
import type { JsonValue } from "../src/types.js";

/** Nothing listens here: a client that dials it is never admitted. */
const UNREACHABLE = "http://127.0.0.1:9";

const offlineClient = (
  heard: [string, JsonValue, string][] = [],
  claims: [string, string | null][] = [],
): MultiplayerClient =>
  new MultiplayerClient({
    host: UNREACHABLE,
    initialState: { round: 1 },
    offline: true,
    onClaim: (key, owner) => claims.push([key, owner]),
    onEvent: (event, payload, from) => heard.push([event, payload, from]),
    party: "vg-server",
    room: "offline-test",
  });

test("an offline client is a room of one: it hosts, and its state applies locally", () => {
  const client = offlineClient();
  let notified = 0;
  client.subscribe(() => {
    notified += 1;
  });
  try {
    assert.equal(client.connectionStatus, "offline");
    assert.equal(client.playerId, OFFLINE_PLAYER_ID);
    assert.equal(client.hostId, OFFLINE_PLAYER_ID);
    assert.ok(client.isHost);
    assert.deepEqual(Object.keys(client.players), [OFFLINE_PLAYER_ID]);
    assert.deepEqual(client.sharedState, { round: 1 }, "seeded with initialState");

    client.updateSharedState({ round: 2 });
    client.updateMyState({ x: 1 });
    assert.deepEqual(client.sharedState, { round: 2 });
    assert.deepEqual(client.players[OFFLINE_PLAYER_ID]?.state, { x: 1 });
    assert.equal(notified, 2, "each write notifies");

    assert.ok(client.serverClock.synced, "the local clock is the room's");
    assert.equal(client.rtt, 0);
    const now = performance.now();
    assert.ok(Math.abs(client.serverNow(now) - now) < 1, "server time reads the local clock");
  } finally {
    client.destroy();
  }
});

test("offline, events reach their own audience at once, and host intents are handled here", () => {
  const heard: [string, JsonValue, string][] = [];
  const client = offlineClient(heard);
  try {
    client.sendEvent("broadcast", 1);
    client.sendEvent("aimed-here", 2, { to: OFFLINE_PLAYER_ID });
    client.sendEvent("aimed-elsewhere", 3, { to: ["someone"] });
    client.sendEvent("excluding-me", 4, { except: [OFFLINE_PLAYER_ID] });
    client.sendEvent("coalesced", 5, { coalesce: true });
    client.sendToHost("intent", { move: "left" });
    assert.deepEqual(heard, [
      ["broadcast", 1, OFFLINE_PLAYER_ID],
      ["aimed-here", 2, OFFLINE_PLAYER_ID],
      ["coalesced", 5, OFFLINE_PLAYER_ID],
      ["intent", { move: "left" }, OFFLINE_PLAYER_ID],
    ]);
  } finally {
    client.destroy();
  }
});

test("offline claims are granted at once, lapse on their TTL, and release or clear", async () => {
  const claims: [string, string | null][] = [];
  const client = offlineClient([], claims);
  try {
    client.claim("pellet:1");
    assert.deepEqual(claims, [["pellet:1", OFFLINE_PLAYER_ID]], "granted before claim() returns");
    assert.equal(client.ownerOf("pellet:1"), OFFLINE_PLAYER_ID);

    client.claim("door", { ttlMs: 30 });
    assert.equal(client.ownerOf("door"), OFFLINE_PLAYER_ID);
    await delay(80);
    assert.equal(client.ownerOf("door"), null, "the TTL ran out");
    assert.deepEqual(claims.at(-1), ["door", null], "and onClaim heard it");

    client.release("pellet:1");
    assert.deepEqual(claims.at(-1), ["pellet:1", null]);

    client.claim("round:a");
    client.claim("round:b", { ttlMs: 10_000 });
    client.claim("kept");
    claims.length = 0;
    client.clearClaims("round:");
    assert.deepEqual(claims, [
      ["round:a", null],
      ["round:b", null],
    ]);
    assert.deepEqual(Object.keys(client.claims), ["kept"]);
  } finally {
    client.destroy();
  }
});

test("fallbackMs counts rendered frames: no room in time, and the client goes offline", () => {
  // The frames the client counts, stood in for here and removed after.
  const host: {
    requestAnimationFrame?: (draw: (time: number) => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
  } = globalThis;
  const pending = new Map<number, (time: number) => void>();
  let handles = 0;
  host.requestAnimationFrame = (draw) => {
    handles += 1;
    pending.set(handles, draw);
    return handles;
  };
  host.cancelAnimationFrame = (handle) => {
    pending.delete(handle);
  };
  const frame = (time: number): void => {
    const draws = [...pending.values()];
    pending.clear();
    for (const draw of draws) {
      draw(time);
    }
  };

  const client = new MultiplayerClient({
    fallbackMs: 4000,
    host: UNREACHABLE,
    party: "vg-server",
    room: "fallback-test",
  });
  let notified = 0;
  client.subscribe(() => {
    notified += 1;
  });
  try {
    assert.equal(client.connectionStatus, "connecting");
    // The first frame starts the deadline, whenever it comes: loading, or a
    // hidden tab, renders no frames and counts for nothing.
    frame(60_000);
    frame(63_999);
    assert.equal(client.connectionStatus, "connecting", "still inside the deadline");
    const before = notified;
    frame(64_000);
    assert.equal(client.connectionStatus, "offline", "the deadline passed without a room");
    assert.ok(notified > before, "subscribers heard it");
    assert.ok(client.isHost);
    assert.equal(pending.size, 0, "the heartbeat stopped");
  } finally {
    client.destroy();
    delete host.requestAnimationFrame;
    delete host.cancelAnimationFrame;
  }
});
