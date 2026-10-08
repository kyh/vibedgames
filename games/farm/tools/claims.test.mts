import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MAX_CLAIM_KEY_LENGTH } from "@vibedgames/multiplayer";
import { FARM_SEED } from "../src/config";
import { CROPS } from "../src/data/crops";
import type { Item } from "../src/data/items";
import type { JsonObject } from "../src/json";
import { ClaimBook } from "../src/net/claim-book";
import type { ClaimNet } from "../src/net/claim-book";
import { WORK_HOLD_MS, claimKey, claimPrefix, parseClaimKey } from "../src/net/claims";
import type { ClaimTarget, ClaimTicket } from "../src/net/claims";
import { FarmSync } from "../src/net/farm-sync";
import { applyTileIntent, tileKey, tileValue } from "../src/net/tile-codec";
import { Inventory } from "../src/systems/inventory";
import { generateFarm } from "../src/world/mapgen";
import type { World } from "../src/world/world";
import { parseWorldMap } from "../src/world/worldmap";

const map = parseWorldMap(
  JSON.parse(readFileSync(new URL("../public/assets/map.json", import.meta.url), "utf-8")),
);

/**
 * The party server's claims, as apps/party arbitrates them: a free (or lapsed)
 * key goes to the claimer and every client hears the grant; a key someone else
 * holds stays put and only the claimer hears who holds it. Each client's
 * messages arrive in order, when the test delivers them.
 */
const partyServer = () => {
  let now = 0;
  const held = new Map<string, { owner: string; until: number | null }>();
  const inboxes = new Map<string, [string, string | null][]>();
  const broadcast = (key: string, owner: string | null): void => {
    for (const inbox of inboxes.values()) {
      inbox.push([key, owner]);
    }
  };
  return {
    advance(ms: number): void {
      now += ms;
      for (const [key, claim] of held) {
        if (claim.until !== null && claim.until <= now) {
          held.delete(key);
          broadcast(key, null);
        }
      }
    },
    claim(from: string, key: string, ttlMs?: number): void {
      const current = held.get(key);
      if (current && current.owner !== from) {
        inboxes.get(from)?.push([key, current.owner]);
        return;
      }
      held.set(key, { owner: from, until: ttlMs === undefined ? null : now + ttlMs });
      broadcast(key, from);
    },
    inbox(id: string): [string, string | null][] {
      const inbox = inboxes.get(id) ?? [];
      inboxes.set(id, inbox);
      return inbox;
    },
    release(key: string): void {
      if (held.delete(key)) {
        broadcast(key, null);
      }
    },
  };
};

type Server = ReturnType<typeof partyServer>;

/** A farmer's client: the SDK's claim map, an outbox the test flushes to the
 *  server, and this farmer's own bag and world. */
const farmer = (server: Server, playerId: string, world: World) => {
  const claims = new Map<string, string>();
  const outbox: { key: string; ttlMs?: number }[] = [];
  const net: ClaimNet & { playerId: string } = {
    claim: (key, options) => outbox.push({ key, ttlMs: options?.ttlMs }),
    ownerOf: (key) => claims.get(key) ?? null,
    playerId,
  };
  return {
    bag: Inventory.fresh(),
    book: new ClaimBook(),
    claims,
    /** Hand the queued claims to the server. */
    flush(): void {
      for (const { key, ttlMs } of outbox.splice(0)) {
        server.claim(net.playerId, key, ttlMs);
      }
    },
    net,
    /** Take the server's messages in, as the SDK does, calling onClaim. */
    read(onClaim: (key: string, owner: string | null) => void = () => {}): void {
      for (const [key, owner] of server.inbox(net.playerId).splice(0)) {
        if (owner === null) {
          claims.delete(key);
        } else {
          claims.set(key, owner);
        }
        onClaim(key, owner);
      }
    },
    world,
  };
};

type Farmer = ReturnType<typeof farmer>;

const EPOCH = 1_791_000_000_000;
const freshFarm = (): World => generateFarm(FARM_SEED, map).world;

/** A tilled tile carrying a ripe crop, generation `gen`, in every world given. */
const ripeTile = (worlds: World[], gen: number): number => {
  const [first] = worlds;
  assert.ok(first);
  const idx = first.tilled.findIndex((_, i) => first.canTill(i % 86, Math.trunc(i / 86)));
  for (const world of worlds) {
    world.tilled[idx] = 1;
    world.gens[idx] = gen;
    world.crops.set(idx, { crop: "parsnip", daysGrown: CROPS.parsnip.growthDays });
  }
  return idx;
};

const parsnip: Item = { crop: "parsnip", kind: "produce" };

/**
 * The scene's harvest, cut to its claim: the farmer checks no one else holds
 * the crop, claims it and harvests at once — the crop off its own world, the
 * produce in its bag — and gives the produce back if the claim is lost.
 */
const harvest = (f: Farmer, idx: number): ClaimTicket | null => {
  const target: ClaimTarget = { gen: f.world.gens[idx] ?? 0, idx, kind: "harvest" };
  const key = claimKey(EPOCH, target);
  const owner = f.net.ownerOf(key);
  if (owner !== null && owner !== f.net.playerId) {
    return null;
  }
  const ticket = f.book.ask(f.net, key);
  f.world.crops.delete(idx);
  f.world.watered[idx] = 0;
  f.bag.add(parsnip, 1);
  ticket.land({ lost: () => f.bag.remove(parsnip, 1) });
  return ticket;
};

const parsnips = (f: Farmer): number =>
  f.bag.count((it) => it.kind === "produce" && it.crop === "parsnip");

test("a claim key names its farm and target, and nothing else parses", () => {
  const targets: ClaimTarget[] = [
    { gen: 3, idx: 4127, kind: "harvest" },
    { gen: 65_535, idx: 0, kind: "plant" },
    { id: 812, kind: "hold" },
    { id: 7, kind: "clear" },
  ];
  for (const target of targets) {
    const key = claimKey(EPOCH, target);
    assert.ok(key.length <= MAX_CLAIM_KEY_LENGTH, key);
    assert.ok(key.startsWith(claimPrefix(EPOCH)));
    assert.deepEqual(parseClaimKey(key), { epoch: EPOCH, target });
  }
  for (const bad of ["", "pellet:3", `${EPOCH}:h:3`, `${EPOCH}:x:3:1`, `${EPOCH}:q:3`, "x:3"]) {
    assert.equal(parseClaimKey(bad), null, bad);
  }
  assert.notEqual(
    claimKey(EPOCH, { id: 7, kind: "clear" }),
    claimKey(EPOCH + 1, { id: 7, kind: "clear" }),
    "a new farm's tree is a new target",
  );
  assert.notEqual(
    claimKey(EPOCH, { gen: 1, idx: 9, kind: "harvest" }),
    claimKey(EPOCH, { gen: 2, idx: 9, kind: "harvest" }),
    "each crop on a tile is its own target",
  );
});

/** The host's side of every claim: its own tickets settle, and the world's side
 *  of each grant lands in the host's farm and the room's shared keys. */
const hosting = (host: Farmer) => {
  const shared: JsonObject = {};
  const writer = { patchShared: (patch: JsonObject) => Object.assign(shared, patch) };
  const sync = new FarmSync(
    { objectBack: () => {}, objectGone: () => {}, redrawTile: () => {}, world: () => host.world },
    () => [],
  );
  /** Each grant the host applied, and whether it changed the host's farm. */
  const grants: [string, boolean][] = [];
  const onClaim = (key: string, owner: string | null): void => {
    host.book.hear(host.net, key, owner);
    const claim = owner === null ? null : parseClaimKey(key);
    if (claim?.target.kind === "harvest") {
      grants.push([key, sync.harvest(writer, claim.target.idx, claim.target.gen)]);
    }
  };
  return { grants, onClaim, shared };
};

const hear = (f: Farmer) => (key: string, owner: string | null) => f.book.hear(f.net, key, owner);

test("two farmers harvest one crop at once: the first claim wins, the other gives it back", () => {
  const server = partyServer();
  const host = farmer(server, "host", freshFarm());
  const a = farmer(server, "a", freshFarm());
  const b = farmer(server, "b", freshFarm());
  for (const id of ["host", "a", "b"]) {
    server.inbox(id);
  }
  const idx = ripeTile([host.world, a.world, b.world], 1);
  const room = hosting(host);

  // Both swing in the same moment, and each harvests at once, locally.
  const aTicket = harvest(a, idx);
  const bTicket = harvest(b, idx);
  assert.ok(aTicket && bTicket);
  assert.equal(parsnips(a), 1);
  assert.equal(parsnips(b), 1);

  // a's claim reaches the server first.
  a.flush();
  b.flush();
  host.read(room.onClaim);
  a.read(hear(a));
  b.read(hear(b));
  assert.equal(aTicket.lostTo, null);
  assert.equal(bTicket.lostTo, "a");
  assert.equal(parsnips(a), 1, "the winner keeps the crop");
  assert.equal(parsnips(b), 0, "the loser gives it back");
  const key = claimKey(EPOCH, { gen: 1, idx, kind: "harvest" });
  assert.deepEqual(room.grants, [[key, true]], "the host harvests it once, hearing a's grant");
  assert.equal(host.world.crops.has(idx), false);
  assert.equal(room.shared[tileKey(idx)], tileValue(host.world, idx), "and publishes it");

  // A latecomer is turned away before it swings: the claim map names a.
  const late = farmer(server, "late", freshFarm());
  late.claims.set(key, "a");
  ripeTile([late.world], 1);
  assert.equal(harvest(late, idx), null);
  assert.equal(parsnips(late), 0);
});

test("the host claims like anyone: a guest's claim that lands first wins", () => {
  const server = partyServer();
  const host = farmer(server, "host", freshFarm());
  const guest = farmer(server, "guest", freshFarm());
  server.inbox("host");
  server.inbox("guest");
  const idx = ripeTile([host.world, guest.world], 1);
  const room = hosting(host);
  const hostTicket = harvest(host, idx);
  const guestTicket = harvest(guest, idx);
  assert.ok(hostTicket && guestTicket);
  guest.flush();
  host.flush();
  // The host hears the guest's grant, then its own refusal naming the guest;
  // the world's side is the same either way, and lands once.
  host.read(room.onClaim);
  guest.read(hear(guest));
  assert.equal(hostTicket.lostTo, "guest");
  assert.equal(guestTicket.lostTo, null);
  assert.equal(parsnips(host), 0);
  assert.equal(parsnips(guest), 1);
  assert.equal(host.world.crops.has(idx), false, "the host's own harvest already showed it");
  assert.ok(
    room.grants.every(([, changed]) => !changed),
    "so no grant changes it twice",
  );
  assert.equal(room.shared[tileKey(idx)], tileValue(host.world, idx));
});

test("the next crop on a tile is a new target, whatever became of the last one's claim", () => {
  const server = partyServer();
  const world = freshFarm();
  const guest = farmer(server, "guest", world);
  server.inbox("guest");
  const idx = ripeTile([world], 1);
  const first = harvest(guest, idx);
  guest.flush();
  guest.read((key, owner) => guest.book.hear(guest.net, key, owner));
  assert.equal(first?.lostTo, null);

  // Replanted — the tile's next generation — and grown ripe again.
  assert.equal(applyTileIntent(world, { action: "plant", crop: "parsnip", gen: 2, idx }), true);
  world.crops.set(idx, { crop: "parsnip", daysGrown: CROPS.parsnip.growthDays });
  assert.equal(
    guest.net.ownerOf(claimKey(EPOCH, { gen: 1, idx, kind: "harvest" })),
    "guest",
    "the old harvest is still claimed",
  );
  const second = harvest(guest, idx);
  assert.ok(second, "but it never blocks the new crop");
  guest.flush();
  guest.read((key, owner) => guest.book.hear(guest.net, key, owner));
  assert.equal(second.lostTo, null);
  assert.equal(parsnips(guest), 2);

  // Once the new crop is in, the host gives the old crop's claims back.
  server.release(claimKey(EPOCH, { gen: 1, idx, kind: "harvest" }));
  guest.read();
  assert.equal(guest.net.ownerOf(claimKey(EPOCH, { gen: 1, idx, kind: "harvest" })), null);
});

test("a swing holds a tree for its farmer until the hold lapses", () => {
  const server = partyServer();
  const a = farmer(server, "a", freshFarm());
  const b = farmer(server, "b", freshFarm());
  server.inbox("a");
  server.inbox("b");
  const hold = claimKey(EPOCH, { id: 42, kind: "hold" });
  const swing = a.book.ask(a.net, hold, WORK_HOLD_MS);
  a.flush();
  a.read((key, owner) => a.book.hear(a.net, key, owner));
  b.read();
  assert.equal(swing.lostTo, null);
  assert.equal(b.net.ownerOf(hold), "a", "b leaves the tree alone");

  // Each swing renews the hold; a swing someone else raced in loses it.
  server.advance(WORK_HOLD_MS - 500);
  a.book.ask(a.net, hold, WORK_HOLD_MS);
  a.flush();
  const raced = b.book.ask(b.net, hold, WORK_HOLD_MS);
  b.flush();
  b.read((key, owner) => b.book.hear(b.net, key, owner));
  assert.equal(raced.lostTo, "a");
  let undone = false;
  raced.land({ lost: () => (undone = true) });
  assert.ok(undone, "an effect landing after the refusal is undone at once");

  // A farmer who walks away frees the tree for the next.
  server.advance(WORK_HOLD_MS);
  b.read();
  assert.equal(b.net.ownerOf(hold), null);
});

test("a reconnect's claims settle by the room's sync, never by a stale player id", () => {
  const server = partyServer();
  const guest = farmer(server, "old-id", freshFarm());
  const key = claimKey(EPOCH, { id: 5, kind: "clear" });
  const ticket = guest.book.ask(guest.net, key);
  let gaveBack = false;
  ticket.land({ lost: () => (gaveBack = true) });
  // The grant went out while the transport was down. On the reconnect the
  // server hands the claim to the seat's new id — announced before the sync
  // that tells this client its new id, so the scene does not hear it then...
  server.claim("new-id", key);
  guest.read();
  assert.equal(ticket.lostTo, null, "unheard while connecting");
  // ...and once the sync lands, the poll reads the room's claims as this
  // farmer's own.
  guest.net.playerId = "new-id";
  guest.book.poll(guest.net);
  assert.equal(gaveBack, false, "won");
  assert.equal(ticket.lostTo, null);
});
