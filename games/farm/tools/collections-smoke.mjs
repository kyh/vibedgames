import assert from "node:assert/strict";
import { Collections } from "../src/systems/collections.ts";
import { Inventory } from "../src/systems/inventory.ts";
import { store } from "../src/systems/store.ts";
import { SEASONS, seasonOfDay } from "../src/data/calendar.ts";
import { CROPS } from "../src/data/crops.ts";
import { FISH } from "../src/data/fish.ts";
import { loadSave, writeSave, patchSave, clearSave, disableSaves } from "../src/systems/save.ts";

let groups = 0;
function check(label, run) {
  run();
  console.log(`PASS ${label}`);
  groups++;
}
check(
  "season pages derive all eligible crops/fish; winter remains a reachable five-fish page",
  () => {
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
  },
);
check(
  "accepted inventory quantity gates discoveries; purchase/loaded inventory cannot infer progress",
  () => {
    const journal = Collections.empty(),
      inv = Inventory.fresh();
    inv.add({ kind: "produce", crop: "carrot" }, 2);
    assert.equal(journal.page("spring").discovered, 0);
    inv.slots = Array.from({ length: inv.slots.length }, () => ({
      item: { kind: "resource", res: "stone" },
      qty: 99,
    }));
    inv.pack = Array.from({ length: inv.pack.length }, () => ({
      item: { kind: "resource", res: "stone" },
      qty: 99,
    }));
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
  },
);
check(
  "each seasonal entry and completion emits once across years; accessors do not expose ownership",
  () => {
    const journal = Collections.empty();
    const winter = journal.page("winter");
    let completions = 0;
    for (const entry of winter.entries) {
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
    const saved = journal.toJSON();
    saved.discoveries[0].item = { kind: "produce", crop: "pumpkin" };
    saved.discoveries.length = 0;
    const page = journal.page("winter");
    page.entries[0].item.fish = "trout";
    assert.equal(journal.page("winter").discovered, 5);
  },
);
check(
  "optional fragment safely filters malformed/duplicate/ineligible entries and loads silently",
  () => {
    for (const raw of [undefined, null, [], "bad", { v: 2, discoveries: [] }, { v: 1 }])
      assert.equal(Collections.fromJSON(raw).toJSON().discoveries.length, 0);
    const good = { season: "summer", item: { kind: "fish", fish: "trout" } };
    const input = {
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
    };
    const journal = Collections.fromJSON(input);
    assert.deepEqual(journal.toJSON().discoveries, [good]);
    input.discoveries.length = 0;
    assert.equal(journal.page("summer").discovered, 1);
    assert.equal(journal.recordCatch("trout", "summer", 1), null);
    store.collections = journal;
    store.initNew();
    assert.equal(store.collections.toJSON().discoveries.length, 0);
  },
);

const key = "farm-rpg-save-v1";
const values = new Map();
let failure = null,
  calls = 0;
globalThis.localStorage = {
  getItem(k) {
    calls++;
    if (failure === "read") throw Error("blocked");
    return values.get(k) ?? null;
  },
  setItem(k, v) {
    calls++;
    if (failure === "write") throw Error("full");
    values.set(k, v);
  },
  removeItem(k) {
    calls++;
    if (failure === "remove") throw Error("blocked");
    values.delete(k);
  },
};
const legacy = {
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
  animals: [],
  animalSeq: 17,
  npcFriendship: { eli: 4 },
  foreign: { preserved: true },
};
check("old v3 saves gain an empty journal; malformed optional data cannot discard the farm", () => {
  values.set(key, JSON.stringify(legacy));
  assert.deepEqual(loadSave(), { ...legacy, collections: { v: 1, discoveries: [] } });
  values.set(
    key,
    JSON.stringify({ ...legacy, collections: { v: 1, discoveries: [{ broken: true }] } }),
  );
  assert.equal(loadSave().gold, 81);
  assert.deepEqual(loadSave().collections, { v: 1, discoveries: [] });
  values.set(key, JSON.stringify({ ...legacy, day: "invalid" }));
  assert.equal(loadSave(), null, "original mandatory scalar validation stays in force");
});
check(
  "mine patch retains journal/world/unknown fragments; failures stay explicit and do not overwrite",
  () => {
    const journal = Collections.empty();
    journal.recordCatch("pike", "winter", 1);
    const save = { ...legacy, collections: journal.toJSON() };
    assert.deepEqual(writeSave(save), { kind: "success" });
    assert.deepEqual(patchSave({ gold: 112, hp: 4 }), { kind: "success" });
    assert.deepEqual(loadSave(), { ...save, gold: 112, hp: 4 });
    const saved = values.get(key);
    failure = "write";
    assert.deepEqual(writeSave({ ...save, gold: 900 }), { kind: "failure", reason: "storage" });
    assert.deepEqual(patchSave({ hp: 1 }), { kind: "failure", reason: "storage" });
    assert.equal(values.get(key), saved);
    failure = "read";
    assert.deepEqual(patchSave({ hp: 1 }), { kind: "failure", reason: "storage" });
    failure = "remove";
    assert.deepEqual(clearSave(), { kind: "failure", reason: "storage" });
    assert.equal(values.get(key), saved);
    failure = null;
    assert.deepEqual(
      patchSave({ hp: 2 }),
      { kind: "success" },
      "retry uses the current supplied state",
    );
    assert.deepEqual(loadSave().collections, journal.toJSON());
    assert.deepEqual(clearSave(), { kind: "success" });
    assert.deepEqual(patchSave({ gold: 1 }), { kind: "failure", reason: "missing" });
    values.set(key, "broken json");
    assert.deepEqual(patchSave({ gold: 1 }), { kind: "failure", reason: "invalid" });
  },
);
check("trailer-disabled writes and patches report disabled without touching storage", () => {
  const before = calls;
  disableSaves();
  assert.deepEqual(writeSave(legacy), { kind: "disabled" });
  assert.deepEqual(patchSave({ gold: 5 }), { kind: "disabled" });
  assert.deepEqual(clearSave(), { kind: "disabled" });
  assert.equal(loadSave(), null);
  assert.equal(calls, before);
});
console.log(`PASS ${groups} collection/save groups`);
