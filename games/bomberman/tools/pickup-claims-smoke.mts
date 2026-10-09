import assert from "node:assert/strict";
import { test } from "node:test";
import { MultiplayerClient, OFFLINE_PLAYER_ID } from "@vibedgames/multiplayer";
import { PICKUP_CLAIMS, PickupClaims, pickupKey } from "../src/net/pickup-claims";
import type { ClaimRoom } from "../src/net/pickup-claims";
import { BASE_RANGE, baseStats, newGrid } from "../src/shared/constants";
import type { Powerup, SharedState } from "../src/shared/constants";

const world = (powerups: Powerup[], round = 1): SharedState => ({
  blasts: {},
  bombs: {},
  bots: {},
  deaths: {},
  grid: newGrid(),
  powerups: Object.fromEntries(powerups.map((pu) => [`${pu.col},${pu.row}`, pu])),
  startedAt: round,
  stats: {},
  winner: null,
});

interface Peer {
  id: string;
  room: ClaimRoom;
  claims: PickupClaims;
  /** What `onClaim` handed back: claims this peer lost. */
  lost: string[];
}

/**
 * The party server's claims, first come first served, with delivery the test
 * drives: claims queue up in the order they reach the server, and `deliver`
 * answers them. Everyone hears a grant; a refused claimer alone hears the owner.
 */
const server = () => {
  const owners = new Map<string, string>();
  const queue: { from: Peer; key: string }[] = [];
  const peers: Peer[] = [];
  const hear = (
    peer: Peer,
    views: Map<string, Map<string, string>>,
    key: string,
    owner: string,
  ) => {
    views.get(peer.id)?.set(key, owner);
    const lost = peer.claims.heard(key, owner, peer.id);
    if (lost) {
      peer.lost.push(lost.fighter);
    }
  };
  const views = new Map<string, Map<string, string>>();
  return {
    deliver(): void {
      for (const { from, key } of queue.splice(0)) {
        const owner = owners.get(key);
        if (owner === undefined) {
          owners.set(key, from.id);
          for (const peer of peers) {
            hear(peer, views, key, from.id);
          }
        } else {
          hear(from, views, key, owner);
        }
      }
    },
    join(id: string): Peer {
      const view = new Map<string, string>();
      views.set(id, view);
      const peer: Peer = {
        claims: new PickupClaims(),
        id,
        lost: [],
        room: {
          claim: (key) => queue.push({ from: peer, key }),
          clearClaims: (prefix) => {
            for (const key of [...owners.keys()].filter((k) => k.startsWith(prefix))) {
              owners.delete(key);
              for (const each of views.values()) {
                each.delete(key);
              }
            }
          },
          ownerOf: (key) => view.get(key) ?? null,
        },
      };
      peers.push(peer);
      return peer;
    },
  };
};

const fire: Powerup = { col: 3, kind: "fire", row: 1 };

test("two players on one power-up: the first claim to reach the room wins, the other undoes", () => {
  const room = server();
  const host = room.join("h");
  const guest = room.join("g");
  let state = world([fire]);
  // Both step onto it in the same instant, each applying it at once.
  assert.deepEqual(guest.claims.reach(guest.room, state, "g", fire), fire);
  assert.deepEqual(host.claims.reach(host.room, state, "h", fire), fire);
  for (const peer of [host, guest]) {
    assert.equal(peer.claims.stats(state, peer.id).range, BASE_RANGE + 1, "applied on the step");
    assert.deepEqual(peer.claims.visible(peer.room, state), {}, "and off the board here");
    assert.equal(peer.claims.reach(peer.room, state, peer.id, fire), null, "asked once");
  }
  // The guest's claim reached the room first: the host's own body has no edge.
  room.deliver();
  assert.deepEqual(host.lost, ["h"], "the host hears the guest holds it, and undoes");
  assert.deepEqual(guest.lost, []);
  assert.equal(host.claims.stats(state, "h").range, BASE_RANGE);
  assert.equal(guest.claims.stats(state, "g").range, BASE_RANGE + 1);
  // The host applies the grant, once.
  const granted = host.claims.settle(host.room, state, "h");
  assert.deepEqual(granted, {
    powerups: {},
    stats: { g: { ...baseStats(), range: BASE_RANGE + 1 } },
  });
  state = { ...state, ...granted };
  assert.equal(host.claims.settle(host.room, state, "h"), null, "nothing left to grant");
  // Settled: the guest's stats come from the room now, not counted twice.
  guest.claims.prune(state);
  assert.equal(guest.claims.fighterOf(pickupKey(1, fire)), null);
  assert.equal(guest.claims.stats(state, "g").range, BASE_RANGE + 1);
});

test("the host claims for its bots through the room, and grants what it won to the bot", () => {
  const room = server();
  const host = room.join("h");
  const guest = room.join("g");
  const bomb: Powerup = { col: 5, kind: "bomb", row: 1 };
  let state = world([fire, bomb]);
  host.claims.reach(host.room, state, "bot-2", bomb);
  guest.claims.reach(guest.room, state, "g", fire);
  room.deliver();
  // Every client sees both go, the one a bot took included.
  assert.deepEqual(guest.claims.visible(guest.room, state), {});
  assert.equal(guest.room.ownerOf(pickupKey(1, bomb)), "h", "the room knows only the host's id");
  const granted = host.claims.settle(host.room, state, "h");
  assert.ok(granted);
  assert.equal(granted.stats["bot-2"]?.bombs, 2, "the bot it claimed for gets it");
  assert.equal(granted.stats["g"]?.range, BASE_RANGE + 1);
  assert.equal(granted.stats["h"], undefined, "not the host's own body");
  state = { ...state, ...granted };
  assert.deepEqual(state.powerups, {});
});

test("a power-up burnt before the host settled it grants nothing, and the claimer's stats come back", () => {
  const room = server();
  const host = room.join("h");
  const guest = room.join("g");
  const state = world([fire]);
  guest.claims.reach(guest.room, state, "g", fire);
  room.deliver();
  // A blast clears the tile on the host before it settles the claim.
  const burnt = { ...state, powerups: {} };
  assert.equal(host.claims.settle(host.room, burnt, "h"), null);
  guest.claims.prune(burnt);
  assert.equal(guest.claims.stats(burnt, "g").range, BASE_RANGE);
});

test("a new round names its power-ups afresh, and the host clears the last round's claims", () => {
  const room = server();
  const host = room.join("h");
  const round1 = world([fire], 1);
  host.claims.reach(host.room, round1, "h", fire);
  room.deliver();
  // Same tile, next round: a different key, free to claim.
  const round2 = world([fire], 2);
  assert.notEqual(pickupKey(2, fire), pickupKey(1, fire));
  assert.deepEqual(host.claims.visible(host.room, round2), round2.powerups);
  host.room.clearClaims(PICKUP_CLAIMS);
  assert.equal(host.room.ownerOf(pickupKey(1, fire)), null, "cleared");
  host.claims.prune(round2);
  assert.deepEqual(host.claims.reach(host.room, round2, "h", fire), fire);
});

test("offline, the room grants a claim before claim() returns, and the host step grants it once", () => {
  const me = OFFLINE_PLAYER_ID;
  const heard: [string, string | null][] = [];
  // The room the scene plays offline: a client that never dials.
  const room = new MultiplayerClient({
    host: "http://127.0.0.1:9",
    offline: true,
    onClaim: (key, owner) => heard.push([key, owner]),
    party: "vg-server",
    room: "pickup-claims-smoke",
  });
  try {
    const claims = new PickupClaims();
    const speed: Powerup = { col: 7, kind: "speed", row: 1 };
    let state = world([fire, speed]);
    claims.reach(room, state, me, fire);
    claims.reach(room, state, "bot-1", speed);
    const keys = [pickupKey(1, fire), pickupKey(1, speed)];
    assert.deepEqual(heard, [
      [keys[0], me],
      [keys[1], me],
    ]);
    for (const [key, owner] of heard) {
      assert.equal(claims.heard(key, owner, me), null, "a grant to this client is no loss");
    }
    const granted = claims.settle(room, state, me);
    assert.equal(granted?.stats[me]?.range, BASE_RANGE + 1);
    assert.ok((granted?.stats["bot-1"]?.speed ?? Infinity) < baseStats().speed);
    assert.deepEqual(granted?.powerups, {});
    state = { ...state, ...granted };
    assert.equal(claims.settle(room, state, me), null, "nothing left to grant");
    assert.equal(claims.stats(state, me).range, BASE_RANGE + 1, "counted once");
    heard.length = 0;
    room.clearClaims(PICKUP_CLAIMS);
    assert.deepEqual(heard, [
      [keys[0], null],
      [keys[1], null],
    ]);
    assert.equal(room.ownerOf(pickupKey(1, fire)), null);
  } finally {
    room.destroy();
  }
});
