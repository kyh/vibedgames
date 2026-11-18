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
import type { ClaimTarget } from "../src/net/claims";
import { FarmSync } from "../src/net/farm-sync";
import { applyTileIntent, tileKey, tileValue } from "../src/net/tile-codec";
import { Inventory } from "../src/systems/inventory";
import { generateFarm } from "../src/world/mapgen";
import type { World } from "../src/world/world";
import { parseWorldMap } from "../src/world/worldmap";

const map = parseWorldMap(
  JSON.parse(readFileSync(new URL("../public/assets/map.json", import.meta.url), "utf-8")),
);

const partyServer = () => {
  let now = 0;
  const held = new Map<string, { owner: string; until: number | null }>();
  const inboxes = new Map<string, [string, string | null][]>();

  const broadcast = (key: string, owner: string | null) => {
    for (const inbox of inboxes.values()) {
      inbox.push([key, owner]);
    }
  };

  return {
    advance(ms: number) {
      now += ms;

      for (const [key, claim] of held) {
        if (claim.until !== null && claim.until <= now) {
          held.delete(key);
          broadcast(key, null);
        }
      }
    },
    claim(from: string, key: string, ttlMs?: number) {
      const current = held.get(key);

      if (current && current.owner !== from) {
        inboxes.get(from)?.push([key, current.owner]);

        return;
      }

      held.set(key, { owner: from, until: ttlMs === undefined ? null : now + ttlMs });
      broadcast(key, from);
    },
    inbox(id: string) {
      const inbox = inboxes.get(id) ?? [];
      inboxes.set(id, inbox);

      return inbox;
    },
    release(key: string) {
      if (held.delete(key)) {
        broadcast(key, null);
      }
    },
  };
};

type Server = ReturnType<typeof partyServer>;

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
    flush() {
      for (const { key, ttlMs } of outbox.splice(0)) {
        server.claim(net.playerId, key, ttlMs);
      }
    },
    net,
    read(onClaim: (key: string, owner: string | null) => void = () => {}) {
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
const freshFarm = () => generateFarm(FARM_SEED, map).world;

const ripeTile = (worlds: World[], gen: number) => {
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

const harvest = (f: Farmer, idx: number) => {
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

const parsnips = (f: Farmer) => f.bag.count((it) => it.kind === "produce" && it.crop === "parsnip");

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

const hosting = (host: Farmer) => {
  const shared: JsonObject = {};
  const writer = { updateSharedState: (patch: JsonObject) => Object.assign(shared, patch) };

  const sync = new FarmSync(
    { objectBack: () => {}, objectGone: () => {}, redrawTile: () => {}, world: () => host.world },
    () => [],
  );

  const grants: [string, boolean][] = [];

  const onClaim = (key: string, owner: string | null) => {
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

  const aTicket = harvest(a, idx);
  const bTicket = harvest(b, idx);
  assert.ok(aTicket && bTicket);
  assert.equal(parsnips(a), 1);
  assert.equal(parsnips(b), 1);

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
  server.claim("new-id", key);
  guest.read();
  assert.equal(ticket.lostTo, null, "unheard while connecting");
  guest.net.playerId = "new-id";
  guest.book.poll(guest.net);
  assert.equal(gaveBack, false, "won");
  assert.equal(ticket.lostTo, null);
});
