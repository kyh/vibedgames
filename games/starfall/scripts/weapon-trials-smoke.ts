import assert from "node:assert/strict";
import { readTrialChoice, trialUrl, WeaponTrial } from "../src/trials/weapon-trial";

const rail = { kind: "railgun", weapon: "RAILGUN", seed: 7319 } satisfies NonNullable<
  ReturnType<typeof readTrialChoice>
>;
const glaive = { kind: "glaive", weapon: "GLAIVE", seed: 7319 } satisfies NonNullable<
  ReturnType<typeof readTrialChoice>
>;
for (const query of [
  "",
  "trial=railgun",
  "offline=0&trial=glaive",
  "offline=1&trial=arc",
  "offline=1&trial=glaive&trailer=1",
]) {
  assert.equal(readTrialChoice(new URLSearchParams(query)), null);
}
for (const choice of [rail, glaive]) {
  assert.deepEqual(readTrialChoice(new URLSearchParams(trialUrl(choice.kind))), choice);
  assert.equal(readTrialChoice(new URLSearchParams(trialUrl(choice.kind, 83)))?.seed, 83);
}
console.log("PASS trial selection is explicit solo, typed, seeded and excludes trailers/rooms");

const shot = new WeaponTrial(rail);
shot.contact(1, "a", false, 0);
assert.deepEqual(shot.state, { phase: "waiting" });
shot.begin(1000, 21000);
shot.begin(2000, 40000);
shot.contact(1, "a", false, 1200);
shot.contact(1, "a", false, 1300);
shot.contact(2, "b", false, 1400);
assert.equal(shot.state.phase === "active" && shot.state.completions, 0);
shot.contact(1, "b", false, 1600);
shot.contact(1, "c", false, 1800);
assert.equal(shot.state.phase === "active" && shot.state.completions, 1);
assert.equal(shot.state.phase === "active" && shot.state.contacts, 4);
shot.advance(2000, true, "RAILGUN", [2]);
assert.equal(shot.trackedShots, 1);
shot.advance(21000, true, "RAILGUN", []);
assert.deepEqual(shot.state, { phase: "result", reason: "window", contacts: 4, completions: 1 });
shot.contact(2, "a", false, 21001);
shot.begin(22000, 42000);
assert.equal(shot.state.phase, "result");
assert.equal(shot.trackedShots, 0);
console.log(
  "PASS Railgun counts distinct targets on one shot, once; actual window is not extended",
);

const back = new WeaponTrial(glaive);
back.begin(1000, 21000);
back.contact(1, "a", false, 900);
back.contact(1, "a", false, 1000);
back.contact(2, "a", true, 1300);
back.contact(1, "b", true, 1400);
assert.equal(back.state.phase === "active" && back.state.completions, 0);
back.contact(1, "a", true, 1600);
back.contact(1, "a", true, 1700);
assert.equal(back.state.phase === "active" && back.state.completions, 1);
back.advance(5000, true, "GLAIVE", [1]);
const paused = structuredClone(back.state);
back.advance(5000, true, "GLAIVE", [1]);
assert.deepEqual(back.state, paused);
back.contact(3, "c", false, 21000);
back.advance(21000, true, "GLAIVE", []);
assert.equal(back.state.phase === "result" && back.state.contacts, 4);
console.log(
  "PASS Glaive credit requires the same shot/target on both legs; paused time and deadline hold",
);

for (const loss of ["death", "loadout"]) {
  const trial = new WeaponTrial(rail);
  trial.begin(1000, 21000);
  trial.advance(1400, loss !== "death", loss === "loadout" ? "NORMAL BEAM" : "RAILGUN", []);
  assert.deepEqual(trial.state, { phase: "result", reason: loss, contacts: 0, completions: 0 });
  trial.advance(1500, true, "RAILGUN", []);
  assert.equal(trial.state.phase, "result");
}
const fresh = new WeaponTrial(rail);
assert.deepEqual(fresh.state, { phase: "waiting" });
assert.equal(fresh.trackedShots, 0);
console.log("PASS loss is terminal without reward, expiry frees attempts and retry starts fresh");
