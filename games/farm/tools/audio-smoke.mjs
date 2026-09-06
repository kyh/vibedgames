import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { audioHarness, recipeTrace, settle } from "./audio-harness.mjs";

let groups = 0;
async function check(label, run) {
  await run();
  console.log(`PASS ${label}`);
  groups++;
}
await check("locked/paused intent and transient mute remain unchanged", async () => {
  const { Sound, contexts, timers, writes } = audioHarness();
  Sound.startMusic("farm");
  Sound.footstep();
  Sound.setPaused(true);
  Sound.muted = false;
  Sound.resume();
  assert.equal(contexts.length, 0);
  assert.equal(timers.size, 0);
  assert.equal(writes.length, 0);
  Sound.setPaused(false);
  Sound.resume();
  await settle();
  assert.equal(contexts.length, 1);
  assert.equal(Sound.diagnostics().musicVoices, 2);
  assert.equal(timers.size, 1);
  Sound.dispose();
});
await check(
  "scene handoff tokens stop only owned music, never newer owners or live SFX",
  async () => {
    const { Sound, timers } = audioHarness();
    Sound.muted = false;
    await settle();
    const old = Sound.startMusic("farm"),
      same = Sound.startMusic("farm");
    old();
    old();
    assert.equal(Sound.diagnostics().musicMode, "farm");
    const mine = Sound.startMusic("mine");
    same();
    assert.equal(Sound.diagnostics().musicMode, "mine");
    assert.equal(timers.size, 1);
    Sound.harvest();
    mine();
    mine();
    assert.equal(timers.size, 0);
    assert.equal(Sound.diagnostics().ownedVoices, 2);
    Sound.dispose();
    old();
    same();
    mine();
    assert.equal(Sound.diagnostics().musicMode, null);
  },
);
await check("32-source cap and delayed tails cancel exactly once on final disposal", async () => {
  const { Sound, contexts, timers } = audioHarness();
  Sound.muted = false;
  await settle();
  const c = contexts[0];
  for (let i = 0; i < 80; i++) Sound.footstep();
  assert.equal(Sound.diagnostics().ownedVoices, 24);
  for (let i = 0; i < 10; i++) Sound.wake();
  assert.equal(Sound.diagnostics().ownedVoices, 32);
  assert.ok(Sound.diagnostics().scheduledVoices > 0);
  assert.ok(Sound.diagnostics().stopped > 0);
  Sound.startMusic("mine");
  Sound.dispose();
  Sound.dispose();
  const ended = Sound.diagnostics().ended;
  for (const source of c.sources) source.finish();
  assert.equal(Sound.diagnostics().ended, ended);
  assert.equal(Sound.diagnostics().ownedVoices, 0);
  assert.equal(Sound.diagnostics().scheduledVoices, 0);
  assert.equal(Sound.diagnostics().schedulerCount, 0);
  assert.equal(Sound.diagnostics().disposed, true);
  assert.equal(c.closeCalls, 1);
  assert.equal(c.state, "closed");
  assert.equal(timers.size, 0);
  assert.ok(c.sources.every((s) => s.disconnected === 1));
  assert.ok(
    c.nodes.every((n) => n.disconnected === 1),
    "sources, gain/filter nodes and shared buses all detach",
  );
});
await check(
  "late resume/suspend promises and stale timer callbacks cannot revive disposed audio",
  async () => {
    for (const pending of ["resume", "suspend"]) {
      const { Sound, contexts, timers, writes } = audioHarness();
      Sound.muted = false;
      await settle();
      const c = contexts[0];
      const release = Sound.startMusic("farm");
      const callbacks = [...timers.values()];
      if (pending === "resume") {
        Sound.setPaused(true);
        await settle();
      }
      c.deferred = true;
      Sound.setPaused(pending === "suspend");
      assert.ok(c.operations.length > 0);
      Sound.dispose();
      const accepted = Sound.diagnostics().accepted,
        stored = writes.length;
      for (const resolve of c.operations.splice(0)) resolve();
      await settle();
      for (const callback of callbacks) callback();
      Sound.resume();
      Sound.setPaused(false);
      Sound.setMuted(false);
      Sound.muted = false;
      Sound.startMusic("mine")();
      Sound.wake();
      Sound.dig();
      release();
      await settle();
      assert.equal(contexts.length, 1);
      assert.equal(c.closeCalls, 1);
      assert.equal(c.operations.length, 0);
      assert.equal(Sound.diagnostics().accepted, accepted);
      assert.equal(Sound.diagnostics().ownedVoices, 0);
      assert.equal(timers.size, 0);
      assert.equal(writes.length, stored);
    }
  },
);
await check("dispose before unlock never creates a context or owns a scheduler", async () => {
  const { Sound, contexts, timers } = audioHarness();
  Sound.startMusic("farm");
  Sound.dispose();
  Sound.setMuted(false);
  Sound.resume();
  Sound.startMusic("mine");
  Sound.wake();
  await settle();
  assert.equal(contexts.length, 0);
  assert.equal(timers.size, 0);
  assert.equal(Sound.diagnostics().disposed, true);
});
await check(
  "all 11 authored SFX and 16 farm/mine steps retain their original connected recipes",
  async () => {
    // Captured from the pre-disposal source with this deterministic WebAudio harness.
    // Includes waveforms/noise bytes, sample-clock envelopes, gains and filter routing.
    const digest = createHash("sha256")
      .update(JSON.stringify(await recipeTrace()))
      .digest("hex");
    assert.equal(digest, "e9f3237a353affacfe8661c8921a29115996bc84ed7d2914adefc8e63137b30d");
  },
);
console.log(`PASS ${groups} actual audio lifecycle groups`);
