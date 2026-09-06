import assert from "node:assert/strict";
import {
  BattleBeatDirector,
  waveBattleBeat,
  type BattleBeatInput,
} from "../src/render/battle-beat";

const epoch = 10_000;
const frame = (t: number, overrides: Partial<BattleBeatInput> = {}): BattleBeatInput => ({
  now: epoch + t,
  epoch,
  presenting: true,
  bossAlive: false,
  lockedWarning: false,
  ...overrides,
});
const arrival = { kind: "arrival", id: "boss", phase: 1 } satisfies Parameters<
  BattleBeatDirector["observe"]
>[0];
const phase = { kind: "phase", id: "boss", phase: 2 } satisfies Parameters<
  BattleBeatDirector["observe"]
>[0];
const defeat = { kind: "defeat", id: "boss" } satisfies Parameters<
  BattleBeatDirector["observe"]
>[0];

assert.equal(waveBattleBeat(0), "quiet");
assert.equal(waveBattleBeat(22.5), "crest");
assert.equal(waveBattleBeat(45), "crest");
assert.equal(waveBattleBeat(90), "quiet");
assert.equal(waveBattleBeat(540), "quiet");
assert.equal(waveBattleBeat(-2), "quiet");
for (const lateTrough of [1080, 2160, 3600]) {
  assert.equal(waveBattleBeat(lateTrough), "quiet");
  assert.equal(waveBattleBeat(lateTrough + 22.5), "crest");
  assert.equal(waveBattleBeat(lateTrough + 45), "crest");
}
assert.equal(waveBattleBeat(NaN), "quiet");
console.log("PASS existing director trough/crest and later-sector contrast");

// Baselines adopt the actual mood, never manufacture an encounter entrance.
for (const initial of [
  frame(22_500),
  frame(0, { bossAlive: true }),
  frame(0, { presenting: false }),
]) {
  const beats = new BattleBeatDirector();
  beats.observe(arrival, initial.now, epoch);
  const result = beats.update(initial);
  assert.equal(result.accent, null);
  assert.equal(result.reset, true);
  assert.equal(result.beat, initial.presenting ? "crest" : "quiet");
  assert.equal(beats.update(initial).accent, null);
  assert.equal(beats.update(initial).reset, false);
}
console.log("PASS first live boss/title/crest baselines and same-step idempotence");

// Track the real threshold crossing without a large-gap adoption. Changes
// require700ms of the new desired mood, and repeated same-time reads don't age it.
const smooth = new BattleBeatDirector();
let prior = smooth.update(frame(0));
let candidateStarted = -1;
for (let t = 100; t <= 25_000; t += 100) {
  const target = waveBattleBeat(t / 1000);
  if (target !== prior.beat && candidateStarted < 0) candidateStarted = t;
  const result = smooth.update(frame(t));
  if (result.beat !== prior.beat) {
    assert.ok(t - candidateStarted >= 700);
    candidateStarted = -1;
  }
  for (let i = 0; i < 4; i++) assert.equal(smooth.update(frame(t)).beat, result.beat);
  prior = result;
}
assert.equal(prior.beat, "crest");
console.log("PASS wave transition hysteresis uses authoritative elapsed time");

const encounter = new BattleBeatDirector();
encounter.update(frame(0));
encounter.observe(arrival, epoch + 10, epoch);
assert.equal(encounter.update(frame(10, { bossAlive: true })).accent, "arrival");
assert.equal(encounter.update(frame(10, { bossAlive: true })).accent, null);
encounter.observe(phase, epoch + 20, epoch);
const locked = encounter.update(frame(20, { bossAlive: true, lockedWarning: true }));
assert.equal(locked.beat, "crest");
assert.equal(locked.accent, null);
assert.equal(locked.lockedWarning, true);
assert.equal(encounter.update(frame(30, { bossAlive: true })).accent, null);
encounter.observe(defeat, epoch + 40, epoch);
assert.equal(encounter.update(frame(40)).beat, "aftermath");
// Keep observing; a long gap is intentionally a silent adoption, not a timer test.
for (let t = 1040; t < 6040; t += 1000) assert.equal(encounter.update(frame(t)).beat, "aftermath");
assert.equal(encounter.update(frame(6039)).beat, "aftermath");
assert.equal(encounter.update(frame(6040)).beat, waveBattleBeat(6.04));
console.log("PASS once-only encounter accents, warning suppression, exact6s aftermath");

const stale = new BattleBeatDirector();
stale.update(frame(0));
stale.observe(arrival, epoch, epoch);
assert.equal(stale.update(frame(501, { bossAlive: true })).accent, null);
stale.observe(defeat, epoch + 501, epoch);
const jumped = stale.update(frame(20_000));
assert.equal(jumped.beat, waveBattleBeat(20));
assert.equal(jumped.reset, true);
assert.equal(jumped.accent, null);
stale.observe(phase, epoch + 20_000, epoch);
const rewound = stale.update(frame(0));
assert.equal(rewound.beat, "quiet");
assert.equal(rewound.reset, true);
assert.equal(rewound.accent, null);
stale.observe(arrival, epoch, epoch);
const newEpoch = stale.update(frame(100, { epoch: epoch + 100 }));
assert.equal(newEpoch.beat, "quiet");
assert.equal(newEpoch.accent, null);
assert.equal(newEpoch.reset, true);
console.log("PASS stale edges, skipped frames, rewind and epoch replacement stay quiet");

const paused = new BattleBeatDirector();
paused.update(frame(0));
paused.observe(defeat, epoch + 10, epoch);
assert.equal(paused.update(frame(10)).beat, "aftermath");
assert.equal(paused.update(frame(20, { presenting: false })).beat, "quiet");
paused.observe(arrival, epoch + 20, epoch);
assert.equal(paused.update(frame(30, { presenting: false, bossAlive: true })).accent, null);
const resume = paused.update(frame(40, { bossAlive: true }));
assert.equal(resume.beat, "crest");
assert.equal(resume.accent, null);
assert.equal(resume.reset, true);
paused.reset();
assert.equal(paused.update(frame(50, { bossAlive: true })).accent, null);
assert.equal(paused.update(frame(60, { epoch: NaN })).active, false);
assert.equal(paused.update(frame(70, { now: Infinity })).active, false);
assert.equal(paused.update(frame(80)).reset, true);
console.log("PASS spectator/death/pause resume, explicit reset and invalid clocks cannot replay");

const simultaneous = new BattleBeatDirector();
simultaneous.update(frame(0));
simultaneous.observe(defeat, epoch + 1, epoch);
simultaneous.observe(arrival, epoch + 1, epoch);
assert.equal(simultaneous.update(frame(1)).beat, "aftermath");
simultaneous.observe(defeat, epoch + 2, epoch);
assert.equal(simultaneous.update(frame(2, { bossAlive: true })).beat, "crest");
console.log("PASS bounded same-frame edge priority and another live boss retain combat mood");
