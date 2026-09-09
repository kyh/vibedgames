import assert from "node:assert/strict";
import { test } from "node:test";
import { Collections } from "../src/systems/collections";
import { Inventory } from "../src/systems/inventory";
import { store } from "../src/systems/store";
import { SEASONS, seasonOfDay } from "../src/data/calendar";
import { CROPS } from "../src/data/crops";
import { FISH } from "../src/data/fish";
import { loadSave, writeSave, type SaveData } from "../src/systems/save";

test("season pages list every eligible crop and fish; winter is fish-only", () => {
  const journal = Collections.empty();
  for (const season of SEASONS) {
    const page = journal.page(season);
    const crops = Object.values(CROPS).filter((c) => c.seasons.includes(season));
    const fish = Object.values(FISH).filter(
      (f) => f.seasons === "all" || f.seasons.includes(season),
    );
    assert.equal(page.total, crops.length + fish.length);
    assert.equal(page.discovered, 0);
    assert.equal(page.complete, false);
    assert.deepEqual(
      new Set(page.entries.map((e) => e.name)),
      new Set([...crops, ...fish].map((d) => d.name)),
    );
  }
  const winter = journal.page("winter");
  assert.equal(winter.total, 5);
  assert.ok(winter.entries.every((e) => e.item.kind === "fish"));
});

test("only an accepted, in-season quantity records a discovery", () => {
  const journal = Collections.empty();
  const inv = Inventory.fresh();
  inv.add({ kind: "produce", crop: "carrot" }, 2);
  assert.equal(journal.page("spring").discovered, 0);
  const full = { item: { kind: "resource", res: "stone" } as const, qty: 99 };
  inv.slots = inv.slots.map(() => ({ ...full }));
  inv.pack = inv.pack.map(() => ({ ...full }));
  assert.equal(inv.add({ kind: "produce", crop: "potato" }, 5), 5);
  assert.equal(journal.recordHarvest("potato", "spring", 0), null);
  inv.pack[0] = { item: { kind: "produce", crop: "potato" }, qty: 97 };
  const leftover = inv.add({ kind: "produce", crop: "potato" }, 5);
  assert.equal(leftover, 3);
  assert.equal(journal.recordHarvest("potato", "spring", 5 - leftover)?.name, "Potato");
  for (const qty of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(journal.recordCatch("carp", "spring", qty), null);
  assert.equal(journal.recordHarvest("potato", "winter", 1), null);
  assert.equal(journal.recordCatch("trout", "winter", 1), null);
  assert.equal(journal.page("spring").discovered, 1);
});

test("each entry and each season completion fires once, across years", () => {
  const journal = Collections.empty();
  let completions = 0;
  for (const entry of journal.page("winter").entries) {
    assert.equal(entry.item.kind, "fish");
    const discovery = journal.recordCatch(entry.item.fish, "winter", 1);
    assert.ok(discovery);
    completions += Number(discovery.completedSeason);
    assert.equal(journal.recordCatch(entry.item.fish, "winter", 3), null);
  }
  assert.equal(completions, 1);
  assert.equal(journal.page("winter").complete, true);
  assert.equal(seasonOfDay(113), "spring");
  journal.recordHarvest("carrot", seasonOfDay(1), 1);
  assert.equal(journal.recordHarvest("carrot", seasonOfDay(113), 1), null);
  assert.ok(journal.recordHarvest("carrot", "fall", 1));
});

test("fromJSON drops malformed, duplicate and out-of-season entries", () => {
  for (const raw of [undefined, null, [], "bad", { v: 2, discoveries: [] }, { v: 1 }])
    assert.equal(Collections.fromJSON(raw).toJSON().discoveries.length, 0);
  const good = { season: "summer", item: { kind: "fish", fish: "trout" } };
  const journal = Collections.fromJSON({
    v: 1,
    discoveries: [
      good,
      good,
      null,
      1,
      { season: "winter", item: { kind: "produce", crop: "carrot" } },
      { season: "other", item: { kind: "fish", fish: "carp" } },
      { season: "spring", item: { kind: "seed", crop: "carrot" } },
      { season: "spring", item: { kind: "fish", fish: "__proto__" } },
    ],
  });
  assert.deepEqual(journal.toJSON().discoveries, [good]);
  assert.equal(journal.recordCatch("trout", "summer", 1), null);
  store.collections = journal;
  store.initNew();
  assert.equal(store.collections.toJSON().discoveries.length, 0);
});

test("save outcome reports storage failures; a v3 save without a journal still loads", () => {
  const values = new Map<string, string>();
  let failWrites = false;
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (failWrites) throw new Error("full");
        values.set(k, v);
      },
      removeItem: (k: string) => values.delete(k),
    },
  });
  const save: SaveData = {
    v: 3,
    seed: 123,
    day: 28,
    timeMin: 830,
    gold: 81,
    energy: 17,
    hp: 7,
    canCharge: 4,
    player: { x: 128, y: 144 },
    world: { tilled: [1, 2], objects: [] },
    inv: Inventory.fresh().toJSON(),
    skills: store.skills.toJSON(),
  };
  assert.deepEqual(writeSave(save), { kind: "success" });
  const loaded = loadSave();
  assert.equal(loaded?.gold, 81);
  assert.equal(Collections.fromJSON(loaded?.collections).page("spring").discovered, 0);
  failWrites = true;
  assert.deepEqual(writeSave({ ...save, gold: 900 }), { kind: "failure" });
  assert.equal(loadSave()?.gold, 81);
  values.set("farm-rpg-save-v1", JSON.stringify({ ...save, day: "invalid" }));
  assert.equal(loadSave(), null);
});
