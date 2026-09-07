import assert from "node:assert/strict";
import { test } from "node:test";
import { coreReceipt, environment, settle } from "./audio-harness.mjs";

const diagnostics = (env) => env.audio.audioDiagnostics();

test("local placement uses personal admission with the exact original tone", () => {
  const receipts = [];
  for (const local of [false, true]) {
    const env = environment();
    env.audio.unlockAudio();
    env.audio.sfx.place(local);
    receipts.push(coreReceipt(env.contexts[0]));
    assert.equal(diagnostics(env).events.place, 1);
    assert.equal(diagnostics(env).routineVoices, local ? 0 : 1);
    assert.equal(diagnostics(env).personalVoices, local ? 1 : 0);
    env.audio.disposeAudio();
  }
  assert.equal(receipts[0], "1d3323a7d348758ea250ff776d796a5d5152d3bab11a7f2038e87e9398d672e5");
  assert.equal(receipts[1], receipts[0]);
});

test("fourteen remote placements cannot silence accepted local placement", () => {
  const env = environment();
  env.audio.unlockAudio();
  for (let i = 0; i < 14; i++) env.audio.sfx.place();
  const ac = env.contexts[0];
  const allocated = ac.nodes.length;
  env.audio.sfx.place(false);
  assert.equal(ac.nodes.length, allocated, "remote overflow allocates no graph");
  assert.equal(diagnostics(env).accepted, 14);
  env.audio.sfx.place(true);
  assert.equal(diagnostics(env).accepted, 15);
  assert.equal(diagnostics(env).events.place, 16);
  assert.equal(diagnostics(env).routineVoices, 14);
  assert.equal(diagnostics(env).personalVoices, 1);
  assert.equal(diagnostics(env).voices, 15);
  env.audio.disposeAudio();
});

test("local pressure evicts whole expendable phrases and preserves all result notes", () => {
  const env = environment();
  env.audio.unlockAudio();
  for (let i = 0; i < 14; i++) env.audio.sfx.place();
  env.audio.sfx.pickup();
  env.audio.sfx.death();
  env.audio.sfx.win("won");
  const ac = env.contexts[0];
  const result = ac.sources.slice(-3);
  assert.equal(diagnostics(env).voices, 20);
  for (let i = 0; i < 80; i++) {
    env.audio.sfx.place(true);
    env.audio.sfx.place();
  }
  assert.equal(diagnostics(env).resultVoices, 3);
  assert.equal(diagnostics(env).voices, 17);
  assert.ok(result.every((source) => !source.finished));
  assert.ok(ac.peak <= 20);
  assert.equal(ac.sources[14].finished, ac.sources[15].finished, "pickup halves retire together");
  assert.deepEqual(
    [diagnostics(env).limit, diagnostics(env).routineLimit, diagnostics(env).personalLimit],
    [20, 14, 17],
  );
  env.audio.disposeAudio();
  assert.ok(ac.nodes.every((node) => node.disconnected === 1));
});

test("blocked local placements never allocate or replay; round reset reuses the context", () => {
  for (const blocked of ["locked", "muted", "paused", "disposed"]) {
    const env = environment({ stored: blocked === "muted" ? "0" : "1" });
    if (blocked !== "locked" && blocked !== "muted") env.audio.unlockAudio();
    if (blocked === "paused") env.audio.pauseAudio(true);
    if (blocked === "disposed") env.audio.disposeAudio();
    env.audio.sfx.place(true);
    assert.equal(diagnostics(env).voices, 0, blocked);
    assert.ok(env.contexts.every((context) => context.sources.length === 0));
    env.audio.pauseAudio(false);
    env.audio.setMuted(false);
    env.audio.unlockAudio();
    assert.equal(diagnostics(env).voices, 0, `${blocked}: no missed cue replay`);
    env.audio.sfx.place(true);
    const ac = env.contexts.at(-1);
    const voice = ac.sources.at(-1);
    assert.equal(diagnostics(env).personalVoices, 1);
    env.audio.resetRoundAudio();
    assert.equal(voice.finished, true);
    assert.equal(diagnostics(env).voices, 0);
    env.audio.sfx.place(true);
    assert.equal(env.contexts.at(-1), ac);
    assert.equal(diagnostics(env).personalVoices, 1);
    env.audio.disposeAudio();
  }
});

test("late context resume after final disposal cannot admit or replay local placement", async () => {
  const env = environment({ delayed: true });
  env.audio.unlockAudio();
  env.audio.sfx.place(true);
  const ac = env.contexts[0];
  env.audio.disposeAudio();
  ac.operations[0].finish();
  await settle();
  env.audio.sfx.place(true);
  assert.equal(ac.closed, 1);
  assert.equal(ac.sources.length, 0);
  assert.equal(diagnostics(env).voices, 0);
  assert.equal(env.contexts.length, 1);
});
