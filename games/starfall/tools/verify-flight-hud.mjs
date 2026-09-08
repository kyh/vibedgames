import assert from "node:assert/strict";
import { test } from "node:test";
import { FlightHud } from "../src/render/flight-hud.ts";
import { LEVEL_CAP, xpToNext } from "../src/shared/constants.ts";

function fixture() {
  const nodes = new Map(
    [
      "flight-progress",
      "flight-level",
      "flight-xp",
      "flight-xp-fill",
      "weapon-time",
      "weapon-mastery",
    ].map((id) => {
      const attrs = new Map();
      return [
        id,
        {
          hidden: true,
          textContent: "",
          style: {},
          getAttribute: (name) => attrs.get(name) ?? null,
          setAttribute: (name, value) => attrs.set(name, value),
        },
      ];
    }),
  );
  globalThis.document = { getElementById: (id) => nodes.get(id) ?? null };
  return { nodes, hud: new FlightHud() };
}

const flight = {
  level: 1,
  xp: 35,
  weaponUntil: 0,
  now: 1000,
  active: true,
  mastery: { phase: "idle" },
};

test("HUD displays actual into-level XP, new-level rollover, death loss and maximum level", () => {
  const { nodes, hud } = fixture();
  const before = structuredClone(flight);
  hud.update(flight);
  assert.equal(nodes.get("flight-progress").hidden, false);
  assert.equal(nodes.get("flight-level").textContent, "LV 1");
  assert.equal(nodes.get("flight-xp").textContent, `35/${xpToNext(1)} XP`);
  assert.equal(nodes.get("flight-xp-fill").style.width, "50%");
  hud.update({ ...flight, level: 2, xp: 0 });
  assert.equal(nodes.get("flight-xp").textContent, `0/${xpToNext(2)} XP`);
  assert.equal(nodes.get("flight-xp-fill").style.width, "0%");
  hud.update({ ...flight, xp: 14 });
  assert.equal(nodes.get("flight-xp-fill").style.width, "20%");
  hud.update({ ...flight, level: LEVEL_CAP, xp: 0 });
  assert.equal(nodes.get("flight-xp").textContent, "MAX");
  assert.match(nodes.get("flight-progress").getAttribute("aria-label"), /maximum level/);
  assert.deepEqual(flight, before, "presentation never writes into the supplied state");
});

test("special timer preserves stacked duration and expires exactly on the supplied clock", () => {
  const { nodes, hud } = fixture();
  const special = { ...flight, weaponUntil: 46000 };
  hud.update(special);
  assert.equal(nodes.get("weapon-time").textContent, "45s");
  for (let i = 0; i < 100; i++) hud.update(special);
  assert.equal(nodes.get("weapon-time").textContent, "45s", "no private or wall-time drain");
  hud.update({ ...special, now: 45001 });
  assert.equal(nodes.get("weapon-time").textContent, "1s");
  hud.update({ ...special, now: 46000 });
  assert.equal(nodes.get("weapon-time").hidden, true);
  assert.equal(nodes.get("weapon-time").textContent, "");
  hud.update(flight);
  assert.equal(nodes.get("weapon-time").hidden, true, "base weapon has no fake deadline");
});

test("pause/death/title hide immediately; resume reads live state; reset/dispose are idempotent", () => {
  const { nodes, hud } = fixture();
  hud.update({ ...flight, weaponUntil: 21000 });
  hud.update({ ...flight, active: false });
  assert.equal(nodes.get("flight-progress").hidden, true);
  assert.equal(nodes.get("weapon-time").hidden, true);
  hud.update({ ...flight, now: 9000, weaponUntil: 21000 });
  assert.equal(nodes.get("weapon-time").textContent, "12s");
  hud.reset();
  hud.reset();
  assert.equal(nodes.get("flight-progress").hidden, true);
  hud.dispose();
  hud.dispose();
  hud.update({ ...flight, weaponUntil: 21000 });
  assert.equal(nodes.get("flight-progress").hidden, true);
  assert.equal(nodes.get("weapon-time").hidden, true);
  globalThis.document = { getElementById: () => null };
  const absent = new FlightHud();
  absent.update(flight);
  absent.dispose();
});

test("mastery is passive acquired-weapon text; completion, expiry and final disposal leave no card", () => {
  const { nodes, hud } = fixture();
  const mastery = { phase: "active", weapon: "RAILGUN", contacts: 0, completions: 0 };
  const state = { ...flight, weaponUntil: 21000, mastery };
  const before = structuredClone(state);
  hud.update(state);
  const text = nodes.get("weapon-mastery");
  assert.equal(text.hidden, false);
  assert.equal(text.textContent, "Pierce two enemies with one shot.");
  hud.update({ ...state, mastery: { ...mastery, completions: 2 } });
  assert.equal(text.textContent, "Aligned shots: 2");
  hud.update({ ...state, mastery: { ...mastery, weapon: "GLAIVE" } });
  assert.equal(text.textContent, "Hit the same enemy out and back.");
  hud.update({ ...state, mastery: { ...mastery, weapon: "GLAIVE", completions: 1 } });
  assert.equal(text.textContent, "Return hits: 1");
  for (const hidden of [
    { ...state, active: false },
    { ...state, now: 21000 },
    { ...state, mastery: { phase: "idle" } },
  ]) {
    hud.update(hidden);
    assert.equal(text.hidden, true);
    assert.equal(text.textContent, "");
    hud.update(state);
  }
  hud.dispose();
  hud.dispose();
  hud.update(state);
  assert.equal(text.hidden, true);
  assert.equal(text.textContent, "");
  assert.deepEqual(state, before);
});
