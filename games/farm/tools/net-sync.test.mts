import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ServerClock } from "@vibedgames/multiplayer";
import { DAY_END_MIN, FARM_SEED, MAP_W, PENDING_EDIT_MS } from "../src/config";
import { CROP_ORDER, CROPS } from "../src/data/crops";
import type { JsonObject } from "../src/json";
import { anchorClock, clockPatch, clockTime, readClock, turnDay } from "../src/net/clock-sync";
import { FarmSync, objectKey, roomEpoch } from "../src/net/farm-sync";
import {
  CROP_SLOTS,
  MAX_GEN,
  applyTileIntent,
  harvestTile,
  packTile,
  parseTileIntent,
  tileIdxOfKey,
  tileKey,
  tileValue,
  unpackTile,
} from "../src/net/tile-codec";
import type { TileState } from "../src/net/tile-codec";
import { store } from "../src/systems/store";
import { generateFarm } from "../src/world/mapgen";
import { isClearable, tileIdx } from "../src/world/world";
import type { World, WorldObject } from "../src/world/world";
import { parseWorldMap } from "../src/world/worldmap";

const map = parseWorldMap(
  JSON.parse(readFileSync(new URL("../public/assets/map.json", import.meta.url), "utf-8")),
);
const freshFarm = (): World => generateFarm(FARM_SEED, map).world;
const generated = freshFarm().objects;

/** A FarmSync over `world`, recording what it asked the scene to redraw. */
const syncOver = (world: World) => {
  const redrawn: number[] = [];
  const gone: number[] = [];
  const back: number[] = [];
  const sync = new FarmSync(
    {
      objectBack: (o) => back.push(o.id),
      objectGone: (o) => gone.push(o.id),
      redrawTile: (idx) => redrawn.push(idx),
      world: () => world,
    },
    () => generated,
  );
  return { back, gone, redrawn, sync };
};

/** The room: patches shallow-merge into one shared object, a new one per patch
 *  (the SDK's semantics), and each patch is kept for inspection. */
const room = () => {
  let shared: JsonObject = {};
  const patches: JsonObject[] = [];
  return {
    patches,
    shared: () => shared,
    writer: {
      patchShared: (patch: JsonObject) => {
        patches.push(patch);
        shared = { ...shared, ...patch };
      },
    },
  };
};

const BARE: TileState = { crop: null, daysGrown: 0, gen: 0, tilled: false, watered: false };

const tillable = (world: World, n: number): number[] => {
  const out: number[] = [];
  for (let i = 0; out.length < n && i < world.tilled.length; i += 1) {
    if (world.canTill(i % MAP_W, Math.trunc(i / MAP_W))) {
      out.push(i);
    }
  }
  return out;
};

const tree = (world: World): WorldObject => {
  const found = world.objects.find((o) => o.type === "tree");
  assert.ok(found, "the co-op farm has trees");
  return found;
};

test("a tile packs into one primitive and back, for every crop and generation", () => {
  assert.ok(CROP_ORDER.length < CROP_SLOTS, "crop codes fit their slot range");
  const largest: TileState = {
    crop: "wheat",
    daysGrown: 255,
    gen: MAX_GEN,
    tilled: true,
    watered: true,
  };
  const states: TileState[] = [
    { crop: null, daysGrown: 0, gen: 0, tilled: false, watered: false },
    { crop: null, daysGrown: 0, gen: 0, tilled: true, watered: false },
    { crop: null, daysGrown: 0, gen: 3, tilled: true, watered: true },
    largest,
  ];
  for (const crop of CROP_ORDER) {
    states.push(
      { crop, daysGrown: CROPS[crop].growthDays, gen: 1, tilled: true, watered: true },
      { crop, daysGrown: 0, gen: 2, tilled: true, watered: false },
    );
  }
  const seen = new Set<number>();
  for (const s of states) {
    const packed = packTile(s);
    assert.ok(Number.isSafeInteger(packed) && packed >= 0);
    assert.deepEqual(unpackTile(packed), s);
    seen.add(packed);
  }
  assert.equal(seen.size, states.length, "distinct states pack distinctly");
  assert.ok(Number.isSafeInteger(packTile(largest)), "the largest tile packs safely");
  assert.equal(packTile({ crop: null, daysGrown: 0, gen: 0, tilled: false, watered: false }), 0);
  const pastLastGen = packTile({ ...BARE, gen: MAX_GEN }) + packTile({ ...BARE, gen: 1 });
  for (const bad of [
    -1,
    0.5,
    Number.NaN,
    "3",
    null,
    [1],
    { t: 1 },
    (CROP_SLOTS - 1) * 4,
    pastLastGen,
  ]) {
    assert.equal(unpackTile(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(tileIdxOfKey(tileKey(4127)), 4127);
  for (const key of ["t4128", "tiles", "ct", "o12", "t", "t-1", "x7"]) {
    assert.equal(tileIdxOfKey(key), null, key);
  }
});

test("the host publishes its farm once, then only the tiles that change", () => {
  const world = freshFarm();
  const [a, b, c] = tillable(world, 3);
  assert.ok(a !== undefined && b !== undefined && c !== undefined);
  world.tilled[a] = 1;
  world.tilled[b] = 1;
  world.watered[b] = 1;
  world.crops.set(b, { crop: "parsnip", daysGrown: 0 });
  world.tilled[c] = 1;
  const felled = tree(world);
  world.removeObject(felled);

  const { sync } = syncOver(world);
  const net = room();
  sync.publishWorld(net.writer, null, 7);
  const [first] = net.patches;
  assert.ok(first);
  assert.deepEqual(
    Object.keys(first).toSorted(),
    ["w", objectKey(felled.id), tileKey(a), tileKey(b), tileKey(c)].toSorted(),
    "a fresh room gets the farmed tiles and cleared objects, nothing else",
  );

  // A sunny night: the watered parsnip grows and its soil dries; the dry,
  // empty plots don't change, so they don't ride the wire.
  const changed = world.growOvernight("spring", false);
  assert.deepEqual([...changed], [b]);
  sync.publishTiles(net.writer, changed);
  assert.deepEqual(net.patches.at(-1), {
    [tileKey(b)]: packTile({ crop: "parsnip", daysGrown: 1, gen: 0, tilled: true, watered: false }),
  });

  // Republished over a room that still holds an older farm's keys, it
  // corrects them — under the farm's own epoch, which a farm keeps for life.
  const stale = { ...net.shared(), [tileKey(9)]: 1, [objectKey(tree(world).id)]: 1 };
  sync.publishWorld(net.writer, stale, 8);
  const fix = net.patches.at(-1);
  assert.equal(fix?.[tileKey(9)], 0);
  assert.equal(fix?.[objectKey(tree(world).id)], 0);
  assert.equal(fix?.["w"], 7, "the same farm keeps its epoch");
  sync.reset();
  sync.publishWorld(net.writer, net.shared(), 9);
  assert.equal(net.patches.at(-1)?.["w"], 7, "and keeps it through a scene start");
  sync.forget();
  sync.publishWorld(net.writer, net.shared(), 10);
  assert.equal(roomEpoch(net.shared()), 10, "a farm the room hasn't seen gets a new one");
});

test("a guest adopts the host's world whole, its own save's farm included", () => {
  const host = freshFarm();
  const [a, own] = tillable(host, 2);
  assert.ok(a !== undefined && own !== undefined);
  host.tilled[a] = 1;
  const hostFelled = tree(host);
  host.removeObject(hostFelled);
  const net = room();
  syncOver(host).sync.publishWorld(net.writer, null, 1);

  // The guest continues its own save: a plot the host never dug, and a tree
  // it felled that still stands on the host's farm.
  const guest = freshFarm();
  guest.tilled[own] = 1;
  const guestFelled = guest.objects.find((o) => o.type === "tree" && o.id !== hostFelled.id);
  assert.ok(guestFelled);
  guest.removeObject(guestFelled);
  const { back, gone, redrawn, sync } = syncOver(guest);
  sync.adopt(net.shared(), 0);
  assert.deepEqual(redrawn.toSorted(), [a, own].toSorted(), "only tiles that differ redraw");

  assert.equal(guest.tilled[a], 1, "the host's plot");
  assert.equal(guest.tilled[own], 0, "its own plot gives way");
  assert.equal(
    guest.objects.some((o) => o.id === hostFelled.id),
    false,
  );
  assert.ok(
    guest.objects.some((o) => o.id === guestFelled.id),
    "the tree stands again",
  );
  assert.ok(guest.isSolidTile(guestFelled.tx, guestFelled.ty), "and blocks the way again");
  assert.deepEqual(gone, [hostFelled.id]);
  assert.deepEqual(back, [guestFelled.id]);
  for (let i = 0; i < host.tilled.length; i += 1) {
    assert.equal(tileValue(guest, i), tileValue(host, i), `tile ${i}`);
  }
  assert.deepEqual(
    guest.objects
      .filter(isClearable)
      .map((o) => o.id)
      .toSorted(),
    host.objects
      .filter(isClearable)
      .map((o) => o.id)
      .toSorted(),
  );

  // From then on only the keys that changed are folded in.
  redrawn.length = 0;
  const next = tree(host);
  assert.equal(syncOver(host).sync.clear(net.writer, next.id)?.id, next.id);
  sync.adopt(net.shared(), 0);
  assert.deepEqual(gone, [hostFelled.id, next.id]);
  assert.deepEqual(redrawn, [], "no tile is touched");
  assert.equal(
    guest.objects.some((o) => o.id === next.id),
    false,
  );
});

test("a guest's own change outranks older host values until echoed or expired", () => {
  const world = freshFarm();
  const [idx] = tillable(world, 1);
  assert.ok(idx !== undefined);
  // The host's farm: a ripe parsnip on watered soil.
  const ripe = packTile({ crop: "parsnip", daysGrown: 4, gen: 1, tilled: true, watered: true });
  const net = room();
  net.writer.patchShared({ w: 1, [tileKey(idx)]: ripe });
  const { redrawn, sync } = syncOver(world);
  sync.adopt(net.shared(), 0);
  assert.equal(tileValue(world, idx), ripe);

  // The guest harvests it locally and tells the host...
  world.crops.delete(idx);
  world.watered[idx] = 0;
  const harvested = tileValue(world, idx);
  sync.protectTile(idx, 1000);
  // ...whose overnight update, sent before the harvest reached it, arrives:
  // the crop must not come back to be harvested twice.
  net.writer.patchShared({ [tileKey(idx)]: ripe + 128 });
  sync.adopt(net.shared(), 1100);
  sync.expire(net.shared(), 1100);
  assert.equal(tileValue(world, idx), harvested, "the older value is ignored");
  // The host applies the harvest: its echo matches and releases the tile.
  net.writer.patchShared({ [tileKey(idx)]: harvested });
  sync.adopt(net.shared(), 1200);
  assert.equal(tileValue(world, idx), harvested);
  // From here on host values apply at once.
  net.writer.patchShared({ [tileKey(idx)]: harvested + 2 });
  sync.adopt(net.shared(), 1300);
  assert.equal(world.watered[idx], 1);

  // A change the host never echoes (refused, or lost with a leaving host)
  // settles back to the host's value once the protection lapses.
  redrawn.length = 0;
  world.watered[idx] = 0;
  world.crops.set(idx, { crop: "carrot", daysGrown: 0 });
  sync.protectTile(idx, 2000);
  sync.expire(net.shared(), 2000 + PENDING_EDIT_MS - 1);
  assert.equal(world.crops.get(idx)?.crop, "carrot");
  sync.expire(net.shared(), 2000 + PENDING_EDIT_MS);
  assert.equal(tileValue(world, idx), harvested + 2);
  assert.deepEqual(redrawn, [idx]);
});

test("a guest's clear stands until the host confirms it, or lapses back", () => {
  const net = room();
  net.writer.patchShared({ w: 1 });
  const world = freshFarm();
  const { sync } = syncOver(world);
  sync.adopt(net.shared(), 0);
  const felled = tree(world);
  world.removeObject(felled);
  sync.protectClear(felled.id, 100);
  // A new host epoch arrives before the clear reaches anyone: no resurrection.
  net.writer.patchShared({ w: 2 });
  sync.adopt(net.shared(), 200);
  assert.equal(
    world.objects.some((o) => o.id === felled.id),
    false,
  );
  net.writer.patchShared({ [objectKey(felled.id)]: 1 });
  sync.adopt(net.shared(), 300);
  sync.expire(net.shared(), 100 + PENDING_EDIT_MS);
  assert.equal(
    world.objects.some((o) => o.id === felled.id),
    false,
    "confirmed",
  );

  const other = world.objects.find((o) => o.type === "rock");
  assert.ok(other);
  world.removeObject(other);
  sync.protectClear(other.id, 5000);
  sync.expire(net.shared(), 5000 + PENDING_EDIT_MS);
  assert.ok(
    world.objects.some((o) => o.id === other.id),
    "never confirmed: it stands again",
  );
});

test("the host applies a guest's intent only where its own world allows it", () => {
  const world = freshFarm();
  const [idx] = tillable(world, 1);
  assert.ok(idx !== undefined);
  const water = world.kind.findIndex((_, i) => world.isSolidTile(i % MAP_W, Math.trunc(i / MAP_W)));
  const kale = { action: "plant", crop: "kale", gen: 1, idx } as const;
  assert.equal(applyTileIntent(world, { action: "till", idx: water }), false);
  assert.equal(applyTileIntent(world, { action: "water", idx }), false, "untilled");
  assert.equal(applyTileIntent(world, kale), false, "untilled");
  assert.equal(applyTileIntent(world, { action: "till", idx }), true);
  assert.equal(applyTileIntent(world, { action: "till", idx }), false, "already tilled");
  assert.equal(applyTileIntent(world, { ...kale, gen: 2 }), false, "not the tile's next crop");
  assert.equal(applyTileIntent(world, kale), true);
  assert.equal(world.gens[idx], 1, "the first crop on the tile");
  assert.equal(applyTileIntent(world, { ...kale, crop: "carrot", gen: 2 }), false, "planted");
  assert.equal(applyTileIntent(world, { action: "water", idx }), true);

  // A harvest is a claim's grant, for the crop it names.
  assert.equal(harvestTile(world, idx, 1), false, "not ripe");
  world.crops.set(idx, { crop: "kale", daysGrown: CROPS.kale.growthDays });
  assert.equal(harvestTile(world, idx, 2), false, "another crop's claim");
  assert.equal(harvestTile(world, idx, 1), true);
  assert.equal(harvestTile(world, idx, 1), false, "already harvested");
  assert.deepEqual(unpackTile(tileValue(world, idx)), {
    crop: null,
    daysGrown: 0,
    gen: 1,
    tilled: true,
    watered: false,
  });
  assert.equal(applyTileIntent(world, { ...kale, gen: 2 }), true, "the next crop is gen 2");

  // Harvests and clears never ride as intents.
  assert.equal(parseTileIntent({ action: "harvest", idx }), null);
  assert.equal(parseTileIntent({ action: "plant", crop: "kale", idx }), null, "names its crop");
  assert.deepEqual(parseTileIntent(kale), kale);
  const standing = tree(world);
  assert.equal(
    applyTileIntent(world, { action: "till", idx: tileIdx(standing.tx, standing.ty) }),
    false,
  );
});

test("every client reads the same minute off the host's clock anchor", () => {
  const anchor = anchorClock(3, 600.04, "sunny", true, 10_000.4);
  assert.deepEqual(
    anchor,
    { at: 10_000, day: 3, running: true, time: 600, weather: "sunny" },
    "rounded as it rides the wire, so the host reads what its guests read",
  );
  assert.deepEqual(readClock(clockPatch(anchor)), anchor);
  assert.equal(readClock({ ...clockPatch(anchor), cw: "hail" }), null);
  assert.equal(readClock({ cd: 3, cr: true, ct: 600, cw: "sunny" }), null, "no anchor time");

  // Two real seconds on, 5.45 game-minutes on — for whoever reads it.
  assert.ok(Math.abs(clockTime(anchor, 12_000) - (600 + (2 * 60) / 22)) < 1e-9);
  let last = clockTime(anchor, 10_000);
  for (let now = 10_000; now < 20_000; now += 1000 / 60) {
    const time = clockTime(anchor, now);
    assert.ok(time >= last, "never runs backwards");
    last = time;
  }
  assert.equal(clockTime(anchor, 9990), 600, "a reader a hair behind waits at the anchor");
  assert.equal(clockTime({ ...anchor, running: false }, 60_000), 600, "stops with the host's");
  assert.equal(clockTime(anchor, 10_000 + 3_600_000), DAY_END_MIN, "only the host ends the day");

  // Host and guest share no local clock, only the room's: the same instant
  // reads the same minute on both, with nothing relayed in between.
  const host = new ServerClock();
  host.sample(0, 3000, 0);
  const guest = new ServerClock();
  guest.sample(0, -7000, 0);
  const instant = 14_321;
  assert.equal(
    clockTime(anchor, host.now(instant - 3000)),
    clockTime(anchor, guest.now(instant + 7000)),
  );
});

test("a guest recovers at each new day the host starts", () => {
  store.energy = 0;
  store.hp = 40;
  const night = turnDay({ day: 1, timeMin: 1320 }, anchorClock(2, 360, "rain", false, 0));
  assert.deepEqual(night, { exhausted: false, rested: true });
  store.rest(night?.exhausted ?? false, false);
  assert.equal(store.energy, 100, "an empty guest can run and swing again");
  assert.equal(store.hp, 70);
  assert.equal(turnDay({ day: 2, timeMin: 400 }, anchorClock(2, 410, "rain", true, 0)), null);

  // The host passed out at 2am: everyone stayed up.
  const late = turnDay({ day: 2, timeMin: DAY_END_MIN }, anchorClock(3, 360, "sunny", false, 0));
  assert.deepEqual(late, { exhausted: true, rested: true });
  store.rest(late?.exhausted ?? false, true);
  assert.equal(store.energy, 55);
  assert.equal(store.hp, Math.floor(store.maxHp() * 0.5), "a faint halves HP");

  // Joining a room behind this farmer's own save: adopt its day, no free night.
  const behind = turnDay({ day: 3, timeMin: 900 }, anchorClock(2, 400, "rain", true, 0));
  assert.deepEqual(behind, { exhausted: false, rested: false });
});
