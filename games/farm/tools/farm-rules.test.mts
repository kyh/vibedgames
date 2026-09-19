import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isSellable } from "../src/data/items";
import { Inventory } from "../src/systems/inventory";
import { modalIntent, nextFocus } from "../src/ui/modal-focus";
import { generateFarm } from "../src/world/mapgen";
import { CELL, parseWorldMap } from "../src/world/worldmap";

test("selling everything keeps the seed stock and the tools", () => {
  const inv = Inventory.fresh();
  assert.equal(inv.sellAll(), 0, "a new farmer's bag holds nothing to sell");
  assert.equal(
    inv.count((it) => it.kind === "seed"),
    15,
  );

  inv.add({ crop: "parsnip", kind: "produce" }, 3);
  inv.add({ kind: "resource", res: "wood" }, 2);
  inv.pack[0] = { item: { crop: "potato", kind: "seed" }, qty: 5 };
  const total = inv.sellAll();
  assert.ok(total > 0);
  assert.equal(
    inv.count((it) => it.kind === "seed"),
    20,
  );
  assert.equal(
    inv.count((it) => it.kind === "tool"),
    6,
  );
  assert.equal(inv.count(isSellable), 0);
  assert.equal(inv.sellAll(), 0);
});

test("the tile under a standing tree's crown tills only once the tree is felled", () => {
  const map = parseWorldMap(
    JSON.parse(readFileSync(new URL("../public/assets/map.json", import.meta.url), "utf-8")),
  );
  const { world } = generateFarm(1, map);
  const trees = world.objects.filter((o) => o.type === "tree");
  assert.ok(trees.length > 0);
  for (const t of trees) {
    assert.equal(world.canTill(t.tx, t.ty - 1), false, `crown of tree at ${t.tx},${t.ty}`);
  }
  const felled = trees.find(
    (t) => world.cellKind(t.tx, t.ty - 1) === CELL.grass && !world.objectAt(t.tx, t.ty - 1),
  );
  assert.ok(felled, "no tree on the map stands south of open grass");
  world.removeObject(felled);
  assert.equal(world.canTill(felled.tx, felled.ty - 1), true);
  assert.equal(world.canTill(felled.tx, felled.ty), true, "the cleared trunk tile tills too");
});

test("modal keys: the interact keys confirm, the movement keys steer", () => {
  for (const code of ["KeyE", "Space", "Enter"]) {
    assert.deepEqual(modalIntent(code), { kind: "confirm" });
  }
  assert.deepEqual(modalIntent("ArrowLeft"), { dir: "left", kind: "move" });
  assert.deepEqual(modalIntent("KeyS"), { dir: "down", kind: "move" });
  assert.equal(modalIntent("KeyI"), null);
});

test("modal focus steps to the nearest button that way and never gets lost", () => {
  // the sleep prompt: Sleep | Not yet
  const pair = [
    { x: -80, y: 0 },
    { x: 80, y: 0 },
  ];
  assert.equal(nextFocus(pair, 0, "right"), 1);
  assert.equal(nextFocus(pair, 1, "left"), 0);
  assert.equal(nextFocus(pair, 1, "right"), 1);
  assert.equal(nextFocus(pair, 0, "up"), 0);
  // the shop: rows of Buy | x5 over one centred sell-all
  const shop = [
    { x: 110, y: 0 },
    { x: 170, y: 0 },
    { x: 110, y: 33 },
    { x: 170, y: 33 },
    { x: 0, y: 120 },
  ];
  assert.equal(nextFocus(shop, 0, "down"), 2);
  assert.equal(nextFocus(shop, 0, "right"), 1);
  assert.equal(nextFocus(shop, 3, "down"), 4);
  assert.equal(nextFocus(shop, 4, "up"), 2);
  assert.equal(nextFocus([], -1, "down"), -1);
});
