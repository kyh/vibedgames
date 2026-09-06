import assert from "node:assert/strict";
import { test } from "node:test";
import { coreReceipt, environment, settle } from "./audio-harness.mjs";

// Captured from the exact pre-arrangement module, SHA-256 ec1a593c49039759…
// Receipts include all original source envelopes, noise bytes, jitter, filtering,
// spatial pan and timing. Only persistent downstream mix buses are excluded.
const RECIPES = [
  ["place", [], "1d3323a7d348758ea250ff776d796a5d5152d3bab11a7f2038e87e9398d672e5"],
  ["blast", [], "bb26054c24f1651f4327426e8fbd1715c47383a780b028f65a547acd8cb3a1a0"],
  [
    "blast",
    [{ strength: 0.25, pan: 0.8 }],
    "de1c85a08fad5dce0469d0fcc69e0198b3fbab46a63443a8b6c6bd12147d8c38",
  ],
  ["pickup", [], "260febb7a07c75a91b83b9b1ba84e55c4d224e532c31704dfca69b4186c47948"],
  ["death", [], "f4f3f9b983a165d69591b2c3c10de84118fdc3cea47540a79ff348b2fdb25f9a"],
  ["win", ["won"], "ac836d406f87e12947aa19a842fc82293c613f21ee01b2acc39287b06d084aff"],
  ["win", ["lost"], "7e8ec0e57bc239d52567bae2df1815cb55d8c65fffeb390e31ef1e06b19df078"],
  ["win", ["draw"], "f139097c9c33286e4bdfaed6260ffac076f10de0423941caa211267058da1221"],
];
const diag = (env) => env.audio.audioDiagnostics();
function bed(env, mode = "playing", start = 0, duration = 3200) {
  for (let elapsed = 0; elapsed <= duration; elapsed += 40) {
    if (elapsed) env.advance(40);
    env.audio.updateRoundScore(mode, start + elapsed);
  }
}

test("eight original core recipes retain exact source/noise/spatial receipts", () => {
  for (const [name, args, expected] of RECIPES) {
    const env = environment();
    env.audio.unlockAudio();
    env.audio.sfx[name](...args);
    assert.equal(coreReceipt(env.contexts[0]), expected, `${name} ${JSON.stringify(args)}`);
  }
});

test("65ms logical blast aggregation and zero-strength boundary remain exact", () => {
  const env = environment();
  env.audio.unlockAudio();
  env.audio.sfx.blast({ strength: 0, pan: 0 });
  assert.equal(diag(env).voices, 0);
  env.audio.sfx.blast({ strength: 1, pan: 0 }, 4);
  env.wall(64);
  env.audio.sfx.blast({ strength: 1, pan: 0 }, 3);
  assert.equal(diag(env).voices, 2);
  env.wall(65);
  env.audio.sfx.blast({ strength: NaN, pan: Infinity });
  assert.equal(diag(env).voices, 4);
  assert.equal(diag(env).events.blast, 9);
  env.audio.resetRoundAudio();
  env.audio.sfx.blast();
  assert.equal(diag(env).voices, 2);
});

test("whole phrases reserve personal/result capacity and never allocate a partial blast", () => {
  const env = environment();
  env.audio.unlockAudio();
  for (let i = 0; i < 13; i++) env.audio.sfx.place();
  const ac = env.contexts[0];
  const allocated = ac.nodes.length;
  env.audio.sfx.blast();
  assert.equal(ac.nodes.length, allocated);
  assert.equal(diag(env).dropped, 2);
  env.audio.sfx.place();
  env.audio.sfx.pickup();
  env.audio.sfx.death();
  assert.equal(diag(env).voices, 17);
  env.audio.sfx.win("won");
  assert.equal(diag(env).voices, 20);
  const result = ac.sources.slice(-3);
  for (let i = 0; i < 40; i++) {
    env.audio.sfx.place();
    env.audio.sfx.pickup();
  }
  assert.ok(result.every((source) => !source.finished));
  assert.equal(diag(env).resultVoices, 3);
  assert.ok(ac.peak <= 20);
  // Pickup replacement must evict both halves, even the not-yet-started note.
  const pickups = ac.sources.slice(20);
  for (let i = 0; i < pickups.length; i += 2)
    assert.equal(pickups[i]?.finished, pickups[i + 1]?.finished);
});

test("two background voices count inside20; priority evicts the bed before threat phrases", () => {
  const env = environment();
  env.audio.unlockAudio();
  bed(env);
  assert.equal(diag(env).backgroundVoices, 2);
  for (let i = 0; i < 12; i++) env.audio.sfx.place();
  env.audio.sfx.pickup();
  assert.equal(diag(env).voices, 16);
  env.audio.sfx.pickup();
  assert.equal(diag(env).backgroundVoices, 0);
  assert.equal(diag(env).routineVoices, 12);
  assert.equal(diag(env).personalVoices, 4);
  assert.equal(diag(env).voices, 16);
});

test("real result→finishing blast→death order uses protected result and ducked existing buses", () => {
  for (const outcome of ["won", "lost", "draw"]) {
    const env = environment();
    env.audio.unlockAudio();
    bed(env);
    env.audio.sfx.win(outcome);
    env.audio.sfx.blast();
    env.audio.sfx.death();
    const ac = env.contexts[0];
    const [master, _background, routine, personal, result] = ac.nodes;
    assert.equal(master.gain.value, 1);
    assert.equal(result.gain.value, 1);
    assert.deepEqual(routine.gain.events.slice(-3), [
      ["set", 0.22, ac.currentTime],
      ["set", 0.22, ac.currentTime + 0.45],
      ["linear", 1, ac.currentTime + 0.9],
    ]);
    assert.equal(personal.gain.events.at(-3)[1], 0.35);
    assert.equal(diag(env).backgroundVoices, 0);
    assert.equal(diag(env).resultVoices, 3);
    const accepted = diag(env).accepted;
    env.audio.sfx.win("draw");
    bed(env, "duel", 4000, 1200);
    assert.equal(diag(env).accepted, accepted);
    assert.equal(diag(env).events.win, 1);
    assert.equal(diag(env).outcome, outcome);
  }
});

test("sparse/dense40s score is bounded, rested and isolated from original random stream", () => {
  const accepted = [];
  for (const mode of ["playing", "duel"]) {
    const env = environment();
    env.audio.unlockAudio();
    bed(env, mode, 0, 40000);
    assert.equal(env.randomCalls(), 0);
    assert.ok(env.contexts[0].peak <= 2);
    assert.equal(diag(env).schedulerCount, 0);
    accepted.push(diag(env).accepted);
    env.audio.updateRoundScore("silent", 40001);
    assert.equal(diag(env).voices, 0);
    assert.equal(diag(env).outcome, null, "local elimination is silence, not a loss");
    env.audio.sfx.blast();
    assert.equal(env.randomCalls(), 1921);
  }
  assert.ok(accepted[0] > 30 && accepted[0] < 70, "opening has deliberate rests");
  assert.ok(accepted[1] > accepted[0] && accepted[1] < 130, "duel adds bounded responses");
});

test("rewind/same-step and long gaps discard background while preserving live SFX", () => {
  const env = environment();
  env.audio.unlockAudio();
  bed(env, "playing", 0, 3240);
  env.audio.sfx.pickup();
  env.audio.updateRoundScore("playing", 3230); // both observations were on step8
  assert.equal(diag(env).backgroundVoices, 0);
  assert.equal(diag(env).personalVoices, 2);
  const accepted = diag(env).accepted;
  env.audio.updateRoundScore("playing", 100000);
  env.audio.updateRoundScore("playing", 100010);
  assert.equal(diag(env).accepted, accepted);
  env.audio.updateRoundScore("playing", NaN);
  assert.equal(diag(env).personalVoices, 2);
});

test("deferred resume follows latest mute/pause and rejection never starts a retry loop", async () => {
  const env = environment({ delayed: true });
  env.audio.unlockAudio();
  env.audio.unlockAudio();
  const ac = env.contexts[0];
  assert.equal(ac.operations.length, 1);
  env.audio.pauseAudio(true);
  env.audio.sfx.pickup();
  ac.operations[0].finish();
  await settle();
  assert.equal(diag(env).voices, 0);
  assert.equal(ac.nodes[0].gain.value, 0);
  env.audio.setMuted(true);
  env.audio.pauseAudio(false);
  env.audio.updateRoundScore("duel", 100000);
  assert.equal(diag(env).voices, 0);
  env.audio.setMuted(false);
  env.audio.updateRoundScore("duel", 100010);
  assert.equal(diag(env).voices, 0);
  const rejected = environment({ delayed: true });
  rejected.audio.unlockAudio();
  const waiting = rejected.contexts[0];
  waiting.operations[0].reject(Error("gesture rejected"));
  await settle();
  assert.equal(waiting.operations.length, 1);
  assert.equal(diag(rejected).contextTransition, false);
  rejected.audio.unlockAudio();
  assert.equal(waiting.operations.length, 2);
});

test("pause/mute/reset cancel voices and duck automation, resume never catches up", () => {
  for (const operation of ["pause", "mute", "reset"]) {
    const env = environment();
    env.audio.unlockAudio();
    bed(env);
    env.audio.sfx.win("won");
    env.audio.sfx.pickup();
    assert.equal(diag(env).scheduledVoices, 3);
    const ac = env.contexts[0];
    const nodes = ac.nodes.slice(5);
    const late = ac.sources.flatMap((source) => [...source.listeners]);
    if (operation === "pause") env.audio.pauseAudio(true);
    else if (operation === "mute") env.audio.setMuted(true);
    else env.audio.resetRoundAudio();
    assert.equal(diag(env).voices + diag(env).scheduledVoices + diag(env).graphNodes, 0);
    assert.equal(diag(env).duckRemaining, 0);
    assert.ok(nodes.every((node) => node.disconnected === 1));
    for (const bus of ac.nodes.slice(0, 5))
      assert.ok(bus.gain.events.every((event) => event[2] <= ac.currentTime));
    env.audio.pauseAudio(false);
    env.audio.setMuted(false);
    env.audio.updateRoundScore("duel", 500000);
    assert.equal(diag(env).voices, 0);
    env.audio.sfx.place();
    for (const fn of late) fn();
    assert.equal(diag(env).voices, 1);
    assert.equal(env.contexts.length, 1);
  }
});

test("locked/paused/muted outcome is consumed silently with no delayed result or bed", () => {
  for (const blocked of ["locked", "paused", "muted"]) {
    const env = environment({ stored: blocked === "muted" ? "0" : "1" });
    if (blocked === "paused") {
      env.audio.unlockAudio();
      env.audio.pauseAudio(true);
    }
    env.audio.sfx.win("draw");
    env.audio.setMuted(false);
    env.audio.pauseAudio(false);
    env.audio.unlockAudio();
    bed(env);
    assert.equal(diag(env).voices, 0);
    assert.equal(diag(env).outcome, "draw");
    env.audio.resetRoundAudio();
    env.audio.sfx.win("lost");
    assert.equal(diag(env).resultVoices, 3);
  }
});

test("native sealed sound setter unlocks paused empty context; inactive intent cannot", async () => {
  const env = environment({ stored: "0", activation: false, delayed: true });
  env.audio.setMuted(false);
  assert.equal(env.contexts.length, 0);
  env.audio.pauseAudio(true);
  env.userActivation.isActive = true;
  env.audio.setMuted(false);
  const ac = env.contexts[0];
  assert.equal(ac.operations.length, 1);
  env.audio.sfx.pickup();
  env.userActivation.isActive = false;
  ac.operations[0].finish();
  await settle();
  assert.equal(diag(env).voices, 0);
  assert.equal(diag(env).paused, true);
  env.audio.pauseAudio(false);
  env.audio.updateRoundScore("duel", 100000);
  assert.equal(diag(env).voices, 0);
  env.audio.sfx.place();
  assert.equal(diag(env).voices, 1);
});

test("three rounds retain one graph owner; terminal async callbacks never touch a new owner", async () => {
  const env = environment();
  env.audio.unlockAudio();
  const ac = env.contexts[0];
  for (let round = 0; round < 3; round++) {
    bed(env);
    env.audio.sfx.win("won");
    env.audio.resetRoundAudio();
    assert.equal(diag(env).voices + diag(env).phrases, 0);
    assert.equal(diag(env).mixNodes, 5);
    assert.equal(env.contexts.length, 1);
  }
  env.audio.disposeAudio();
  env.audio.disposeAudio();
  assert.ok(ac.nodes.every((node) => node.disconnected === 1));
  assert.equal(ac.closed, 1);
  assert.equal(diag(env).mixNodes, 0);
  const pending = environment({ delayed: true });
  pending.audio.unlockAudio();
  const old = pending.contexts[0];
  pending.audio.disposeAudio();
  pending.audio.unlockAudio();
  const fresh = pending.contexts[1];
  fresh.operations[0].finish();
  await settle();
  pending.audio.sfx.place();
  old.operations[0].finish();
  await settle();
  assert.equal(diag(pending).voices, 1);
  assert.equal(old.closed, 1);
  assert.equal(fresh.closed, 0);
});
