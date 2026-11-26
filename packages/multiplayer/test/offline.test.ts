import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";

import { WebSocketServer } from "ws";

import { MultiplayerClient } from "../src/client.js";
import { OFFLINE_PLAYER_ID } from "../src/types.js";
import type { FrameClock, JsonValue } from "../src/types.js";

const UNREACHABLE = "http://127.0.0.1:9";

const offlineClient = (
  heard: [string, JsonValue, string][] = [],
  claims: [string, string | null][] = [],
  claimEvents = new EventTarget(),
) =>
  new MultiplayerClient({
    host: UNREACHABLE,
    initialState: { round: 1 },
    offline: true,
    onClaim: (key, owner) => {
      claims.push([key, owner]);
      claimEvents.dispatchEvent(new CustomEvent("claim", { detail: [key, owner] }));
    },
    onEvent: (event, payload, from) => {
      heard.push([event, payload, from]);
    },
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
  const claimEvents = new EventTarget();
  const client = offlineClient([], claims, claimEvents);

  try {
    client.claim("pellet:1");
    assert.deepEqual(claims, [["pellet:1", OFFLINE_PLAYER_ID]], "granted before claim() returns");
    assert.equal(client.ownerOf("pellet:1"), OFFLINE_PLAYER_ID);

    client.claim("door", { ttlMs: 30 });
    assert.equal(client.ownerOf("door"), OFFLINE_PLAYER_ID);
    const { promise: released, resolve: onLapse } = Promise.withResolvers<Event>();
    claimEvents.addEventListener("claim", onLapse, { once: true });
    const lapse = await released;
    assert.ok(lapse instanceof CustomEvent);
    assert.deepEqual(lapse.detail, ["door", null]);
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

const testFrames = () => {
  const pending = new Map<number, (time: number) => void>();
  let handles = 0;

  const clock: FrameClock = {
    cancel: (handle) => {
      pending.delete(handle);
    },
    request: (draw) => {
      handles += 1;
      pending.set(handles, draw);

      return handles;
    },
  };

  const run = (from: number, to: number) => {
    for (let time = from; time <= to; time += 1000 / 60) {
      const draws = [...pending.values()];
      pending.clear();

      for (const draw of draws) {
        draw(time);
      }
    }
  };

  return { clock, pending, run };
};

const dialing = (frames: FrameClock) =>
  new MultiplayerClient({
    fallbackMs: 4000,
    frames,
    host: UNREACHABLE,
    party: "vg-server",
    room: "fallback-test",
  });

test("fallbackMs counts rendered frames: no room in time, and the client goes offline", () => {
  const frames = testFrames();
  const client = dialing(frames.clock);
  let notified = 0;
  client.subscribe(() => {
    notified += 1;
  });

  try {
    assert.equal(client.connectionStatus, "connecting");
    frames.run(60_000, 62_000);
    frames.run(122_000, 123_500);
    assert.equal(client.connectionStatus, "connecting", "3.6 s of frames: inside the deadline");
    const before = notified;
    frames.run(123_500, 124_000);
    assert.equal(client.connectionStatus, "offline", "4 s of frames without a room");
    assert.ok(notified > before, "subscribers heard it");
    assert.ok(client.isHost);
    assert.equal(frames.pending.size, 0, "the heartbeat stopped");
  } finally {
    client.destroy();
  }
});

test("a client a room admitted never falls back, even redirected to an overflow room", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address instanceof Object, "the server listens on a port");
  const sync = { claims: {}, hostId: "host", players: {}, state: {}, tick: null, time: 0 };
  let dials = 0;

  server.on("connection", (socket) => {
    dials += 1;

    if (dials === 1) {
      socket.send(JSON.stringify({ data: sync, type: "sync" }));
      socket.send(
        JSON.stringify({ data: { capacity: 2, room: "fallback-test~2" }, type: "room_full" }),
      );
    }
  });

  const frames = testFrames();

  const client = new MultiplayerClient({
    fallbackMs: 4000,
    frames: frames.clock,
    host: `127.0.0.1:${address.port}`,
    party: "vg-server",
    room: "fallback-test",
  });

  const statuses: string[] = [];
  const reconnecting = new EventTarget();

  client.subscribe(() => {
    statuses.push(client.connectionStatus);

    if (client.connectionStatus === "reconnecting") {
      reconnecting.dispatchEvent(new Event("reconnecting"));
    }
  });

  try {
    await once(reconnecting, "reconnecting");
    assert.ok(statuses.includes("connected"), "the room admitted it first");
    frames.run(0, 10_000);
    assert.equal(client.connectionStatus, "reconnecting", "and it never falls back");
  } finally {
    client.destroy();
    server.close();
  }
});

test("getSnapshot hands out the same object until the state in it changes", () => {
  const client = offlineClient();

  try {
    const first = client.getSnapshot();
    assert.equal(client.getSnapshot(), first, "unchanged: the same object, as React requires");
    client.updateSharedState({ round: 2 });
    const second = client.getSnapshot();
    assert.notEqual(second, first, "a change makes a new snapshot");
    assert.deepEqual(second.sharedState, { round: 2 });
    assert.equal(client.getSnapshot(), second);
  } finally {
    client.destroy();
  }
});

test("offline, the room's lock and meta are this client's to set", () => {
  const client = offlineClient();

  try {
    const before = client.getSnapshot();
    assert.deepEqual(client.roomInfo, { locked: false, meta: {} });
    client.setRoomInfo({ meta: { mode: "solo" } });
    client.setRoomInfo({ locked: true });
    assert.deepEqual(client.roomInfo, { locked: true, meta: { mode: "solo" } });
    assert.notEqual(client.getSnapshot(), before, "a new snapshot carries it");
    assert.equal(client.getSnapshot().roomInfo, client.roomInfo);
  } finally {
    client.destroy();
  }
});
