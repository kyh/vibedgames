import assert from "node:assert/strict";
import { WeaponMastery } from "../src/shared/weapon-mastery";

function shot(mastery: WeaponMastery, weapon: string, now: number) {
  const value = mastery.shot(weapon, now);
  assert.ok(value);
  return value;
}

function active(mastery: WeaponMastery) {
  const state = mastery.state;
  assert.equal(state.phase, "active");
  if (state.phase !== "active") throw new Error("Missing acquired weapon");
  return state;
}

const rail = new WeaponMastery();
assert.equal(rail.shot("RAILGUN", 1000), null);
rail.pickup("RAILGUN", 1000, 21000);
const a = shot(rail, "RAILGUN", 1000);
const twin = shot(rail, "RAILGUN", 1000);
rail.contact(a, "a", false, 1200);
rail.contact(a, "a", false, 1300);
rail.contact(twin, "b", false, 1400);
assert.equal(active(rail).completions, 0, "different beams never pool their contacts");
rail.contact(a, "b", false, 1500);
rail.contact(a, "c", false, 1600);
assert.equal(active(rail).completions, 1);
assert.equal(active(rail).contacts, 4);
rail.advance(2000, true, "RAILGUN", [twin]);
assert.equal(rail.trackedShots, 1);
console.log("PASS Railgun counts two distinct enemies on one beam, once; dead shots prune");

const beforeStack = active(rail);
rail.pickup("RAILGUN", 5000, 41000);
assert.deepEqual(rail.state, { ...beforeStack, endsAt: 41000 });
rail.contact(twin, "c", false, 21000);
assert.equal(active(rail).completions, 2, "stack keeps earlier live shots past original deadline");
rail.contact(twin, "d", false, 41000);
assert.equal(active(rail).contacts, 5, "exact deadline rejects before later frame cleanup");
assert.equal(rail.shot("RAILGUN", 41000), null);
rail.pickup("RAILGUN", 41000, 61000);
assert.notEqual(active(rail).generation, beforeStack.generation);
rail.contact(twin, "e", false, 41001);
assert.equal(active(rail).contacts, 0, "expired same-name pickup cannot admit old shots");
console.log(
  "PASS stacked deadline preserves progress; exact expiry and reacquisition fence old beams",
);

const glaive = new WeaponMastery();
glaive.pickup("GLAIVE", 1000, 21000);
const blade = shot(glaive, "GLAIVE", 1000);
const other = shot(glaive, "GLAIVE", 1000);
glaive.contact(blade, "a", false, 900);
glaive.contact(blade, "a", false, 1100);
glaive.contact(other, "a", true, 1200);
glaive.contact(blade, "b", true, 1300);
assert.equal(active(glaive).completions, 0);
glaive.contact(blade, "a", true, 1400);
glaive.contact(blade, "a", true, 1401);
assert.equal(active(glaive).completions, 1);
assert.equal(active(glaive).contacts, 4);
const paused = active(glaive);
glaive.advance(1500, true, "GLAIVE", [blade, other]);
for (let i = 0; i < 60; i++) glaive.advance(1500, true, "GLAIVE", [blade, other]);
assert.deepEqual(glaive.state, paused, "supplied sim clock is the only clock");
glaive.pickup("BLASTER", 1600, 21600);
assert.deepEqual(glaive.state, { phase: "idle" });
glaive.pickup("GLAIVE", 1700, 21700);
glaive.contact(blade, "c", false, 1800);
glaive.contact(blade, "c", true, 1900);
assert.equal(active(glaive).contacts, 0);
assert.equal(glaive.trackedShots, 0);
console.log("PASS Glaive requires same beam/target both legs; switch-back excludes old generation");

for (const state of [
  { now: 21000, alive: true, weapon: "RAILGUN" },
  { now: 1100, alive: false, weapon: "RAILGUN" },
  { now: 1100, alive: true, weapon: "GLAIVE" },
  { now: 900, alive: true, weapon: "RAILGUN" },
]) {
  const mastery = new WeaponMastery();
  mastery.pickup("RAILGUN", 1000, 21000);
  const beam = shot(mastery, "RAILGUN", 1000);
  mastery.contact(beam, "a", false, 1100);
  mastery.advance(state.now, state.alive, state.weapon, []);
  assert.deepEqual(mastery.state, { phase: "idle" });
  assert.equal(mastery.trackedShots, 0);
  mastery.clear();
  mastery.clear();
  mastery.pickup("GLAIVE", 22000, 42000);
  assert.equal(active(mastery).weapon, "GLAIVE", "ordinary next pickup always works");
}
console.log(
  "PASS expiry/death/loadout/rewind cancel quietly; clear and next acquisition remain reusable",
);
