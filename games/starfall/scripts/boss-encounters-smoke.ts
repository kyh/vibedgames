import assert from "node:assert/strict";
import { BossEncounters, type BossObservation } from "../src/render/boss-encounters";

const boss = (id: string, hp = 1000, maxHp = 1000): BossObservation => ({
  id,
  kind: "dreadnought",
  hp,
  maxHp,
});

// First valid observations adopt the actual encounter without retroactive cues.
for (const initial of [[], [boss("a")], [boss("a", 500)], [boss("a", 0)]]) {
  const encounters = new BossEncounters();
  assert.deepEqual(encounters.observe(100, initial), []);
  assert.deepEqual(encounters.observe(100, initial), []);
}

const encounters = new BossEncounters();
encounters.observe(100, []);
assert.deepEqual(encounters.observe(100, [boss("a")]), [{ kind: "arrival", id: "a", phase: 1 }]);
assert.deepEqual(encounters.observe(100, [boss("a", 661)]), []);
assert.deepEqual(encounters.observe(100, [boss("a", 660)]), [{ kind: "phase", id: "a", phase: 2 }]);
// Repeated observations, stale healthier snapshots and camera changes are quiet.
for (const hp of [660, 900, 500, 331])
  assert.deepEqual(encounters.observe(100, [boss("a", hp)]), []);
assert.deepEqual(encounters.observe(100, [boss("a", 330)]), [{ kind: "phase", id: "a", phase: 3 }]);
assert.deepEqual(encounters.observe(100, [boss("a", 0)]), []);
assert.deepEqual(encounters.observe(100, []), [{ kind: "defeat", id: "a" }]);
assert.deepEqual(encounters.observe(100, []), []);
assert.deepEqual(encounters.observe(100, [boss("a", 1000)]), []);
assert.deepEqual(encounters.observe(100, []), []);

// A new ID arriving in phase two gets one arrival, without historical phases.
assert.deepEqual(encounters.observe(100, [boss("b", 500)]), [
  { kind: "arrival", id: "b", phase: 2 },
]);
assert.deepEqual(encounters.observe(100, [boss("b", 500), boss("b", 100)]), [
  { kind: "phase", id: "b", phase: 3 },
]);

// First-dead/invalid entries cannot manufacture a kill or replay an old boss.
for (const initial of [boss("dead", 0), boss("dead", 100, 0), boss("dead", NaN)]) {
  const dead = new BossEncounters();
  dead.observe(100, [initial]);
  assert.deepEqual(dead.observe(100, []), []);
  assert.deepEqual(dead.observe(100, [boss("dead")]), []);
  assert.deepEqual(dead.observe(100, []), []);
}

// A first-live guest baseline can later observe a valid defeat. Same-epoch host
// migration does not reset identity; epoch replacement and trailer reset do.
const guest = new BossEncounters();
guest.observe(100, [boss("guest", 500)]);
assert.deepEqual(guest.observe(100, [boss("guest", 500)]), []);
assert.deepEqual(guest.observe(100, []), [{ kind: "defeat", id: "guest" }]);
assert.deepEqual(guest.observe(200, [boss("guest", 500)]), []);
assert.deepEqual(guest.observe(200, [boss("guest", 100)]), [
  { kind: "phase", id: "guest", phase: 3 },
]);
guest.reset();
assert.deepEqual(guest.observe(200, []), []);
assert.deepEqual(guest.observe(200, [boss("new")]), [{ kind: "arrival", id: "new", phase: 1 }]);

// Routine enemies and malformed epochs have no encounter consequences.
const ignored = new BossEncounters();
assert.deepEqual(ignored.observe(NaN, [boss("a")]), []);
assert.equal(ignored.diagnostics().epoch, null);
assert.deepEqual(ignored.observe(100, [{ ...boss("a"), kind: "lancer" }]), []);
assert.deepEqual(ignored.observe(100, []), []);

const bounded = new BossEncounters();
bounded.observe(100, []);
for (let i = 0; i < 100; i++) {
  assert.equal(bounded.observe(100, [boss(String(i))]).length, 1);
  assert.equal(bounded.observe(100, []).length, 1);
  assert.ok(bounded.diagnostics().retired <= bounded.diagnostics().retiredLimit);
}
assert.equal(bounded.diagnostics().live, 0);
assert.equal(bounded.diagnostics().retired, 32);
console.log("PASS boss encounter baselines, phases, retirement, resets and bounded history");
