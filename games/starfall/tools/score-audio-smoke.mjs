import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buffers,
  environment,
  plain,
  recipeReceipt,
  settle,
  sourceRecord,
} from "./audio-harness.mjs";

const baseline = JSON.parse(readFileSync(new URL("./audio-recipe-baseline.json", import.meta.url)));
const musicSources = (c) => c.sources.filter((s) => s.links[0].links[0] === c.gains[2]);

function start(beat = "crest", mode = "flight", options) {
  const e = environment(options);
  e.audio.setBattleBeat(beat);
  e.audio.setMusicMode(mode);
  e.unlock();
  return e;
}
function assertEmpty(e) {
  const d = e.audio.diagnostics();
  assert.equal(d.ownedSources, 0);
  assert.equal(d.scheduledSources, 0);
  assert.equal(d.schedulerCount, 0);
  assert.equal(e.timers.size, 0);
}

test("all 28 cached buffers / 52 original playbacks / original jitter and duck remain exact", () => {
  assert.deepEqual(recipeReceipt(), baseline);
  assert.equal(baseline.buffers.length, 28);
  assert.equal(baseline.sources.length, 52);
  assert.equal(baseline.masterGain, 0.5);
  assert.equal(baseline.musicGain, 0.075);
  // Original player death bypasses the routine duck bus in both playback passes.
  assert.equal(baseline.sources[16].bus, 0);
  assert.equal(baseline.sources[42].bus, 0);
});

test("musical contrast uses density/register/rests, unchanged gains and at most two voices", () => {
  const receipt = [];
  for (const mode of ["flight", "boss"]) {
    for (const beat of ["quiet", "build", "crest", "aftermath"]) {
      const e = start(beat, mode);
      const initialDraws = e.randomDraws();
      const c = e.contexts[0];
      let peak = 0;
      for (let i = 0; i < 240; i++) {
        e.run(200);
        peak = Math.max(peak, e.audio.diagnostics().musicVoices);
      }
      const notes = musicSources(c);
      assert.ok(peak <= 2);
      assert.ok(notes.every((n) => n.links[0].gain.value <= 1));
      assert.equal(e.randomDraws(), initialDraws);
      assert.equal(c.gains[0].gain.value, 0.5);
      assert.equal(c.gains[2].gain.value, 0.075);
      assert.equal(c.gains[2].links[0], c.gains[1]);
      assert.equal(e.audio.diagnostics().cachedBuffers, 28);
      if (beat === "quiet") {
        assert.equal(notes.length, 3);
        assert.equal(peak, 1);
        assert.equal(notes[0].links[0].gain.value, 0.5);
      }
      if (beat === "aftermath") {
        assert.equal(notes.length, 2);
        assert.equal(notes[0].playbackRate.value, 1.5);
        assert.equal(notes[1].playbackRate.value, 1);
        assert.equal(e.audio.diagnostics().musicVoices, 0);
      }
      receipt.push({ mode, beat, notes: notes.length, peak, firstAt: notes[0].starts[0] });
      e.audio.dispose();
    }
  }
  for (const mode of ["flight", "boss"]) {
    const rows = receipt.filter((r) => r.mode === mode);
    assert.ok(rows[2].notes > rows[1].notes && rows[1].notes > rows[0].notes);
  }
  console.log(JSON.stringify({ durationMs: 48000, score: receipt }));
});

test("beat/mode frame repetition is inert; transitions cancel music only and preserve live warning", () => {
  const e = start();
  e.run(600);
  const c = e.contexts[0];
  assert.equal(e.audio.diagnostics().musicVoices, 2);
  e.audio.play("telegraph_warn");
  const warning = c.sources.at(-1);
  const timer = [...e.timers.keys()][0];
  for (let i = 0; i < 100; i++) {
    e.audio.setBattleBeat("crest");
    e.audio.setMusicMode("flight");
  }
  assert.equal([...e.timers.keys()][0], timer);
  assert.equal(e.audio.diagnostics().musicVoices, 2);
  e.audio.setBattleBeat("quiet");
  assert.equal(e.audio.diagnostics().musicVoices, 0);
  assert.equal(e.audio.diagnostics().essentialSources, 1);
  assert.equal(warning.stops.length, 0);
  assert.equal(e.timers.size, 1);
  assert.equal(e.audio.diagnostics().battleBeat, "quiet");
  assert.equal(Object.isFrozen(e.audio.diagnostics()), true);
  e.audio.dispose();
});

test("32/24/2 bounds count scheduled music; important pressure evicts complete pair first", () => {
  const e = start();
  e.run(600);
  for (let i = 0; i < 22; i++) e.audio.play("fire_heavy");
  for (let i = 0; i < 8; i++) e.audio.play("shield_hit");
  assert.equal(e.audio.diagnostics().ownedSources, 32);
  assert.equal(e.audio.diagnostics().routineSources, 24);
  e.audio.play("boss_phase");
  const d = e.audio.diagnostics();
  assert.equal(d.musicVoices, 0);
  assert.equal(d.ownedSources, 31);
  assert.equal(d.stopped, 2);
  for (let i = 0; i < 100; i++) e.audio.play("shield_hit");
  assert.equal(e.audio.diagnostics().peak, 32);
  assert.equal(e.audio.diagnostics().ownedSources, 32);
  e.audio.dispose();
  for (const node of e.contexts[0].nodes) assert.equal(node.disconnected, 1);
});

test("full phrase admission is atomic; rejected bars and long gaps do not catch up", () => {
  const e = start();
  for (let i = 0; i < 23; i++) e.audio.play("fire_heavy", { rate: 0.05 });
  const c = e.contexts[0];
  e.run(600);
  assert.equal(e.audio.diagnostics().musicVoices, 0);
  assert.equal(e.audio.diagnostics().dropped, 2);
  assert.equal(c.sources.length, 23, "rejected pair allocates no graph");
  assert.equal(e.audio.diagnostics().musicStep, 1);
  const callback = [...e.timers.values()][0].fn;
  e.jump(60000);
  callback();
  assert.equal(musicSources(c).length, 2);
  assert.equal(musicSources(c)[0].playbackRate.value, 1.25, "failed first bar was consumed");
  const count = c.sources.length;
  for (let i = 0; i < 100; i++) callback();
  assert.equal(c.sources.length, count);
  e.audio.clearTransient();
  callback();
  assertEmpty(e);
});

test("aftermath resolves once through pause and mode changes; a new beat/cut owns reset", async () => {
  const e = start("aftermath", "boss");
  e.run(1000);
  const c = e.contexts[0];
  assert.equal(musicSources(c).length, 2);
  e.audio.setSuspended(true);
  assertEmpty(e);
  await settle();
  e.audio.setMusicMode("silent");
  e.audio.setMusicMode("flight");
  e.audio.setBattleBeat("aftermath");
  e.audio.setSuspended(false);
  await settle();
  e.run(24000);
  assert.equal(musicSources(c).length, 2);
  e.audio.setBattleBeat("build");
  e.audio.setBattleBeat("aftermath");
  e.run(1200);
  assert.equal(musicSources(c).length, 4);
  e.audio.clearTransient();
  assertEmpty(e);
  assert.equal(e.audio.diagnostics().battleBeat, "quiet");
  assert.equal(e.audio.diagnostics().musicStep, 0);
  assert.equal(e.audio.diagnostics().musicMode, "silent");
  assert.equal(buffers(e.audio).length, 28);
});

test("sample-clock voices end or cancel once; stale ended callbacks cannot remove later SFX", () => {
  const e = start();
  e.run(600);
  const c = e.contexts[0];
  const old = c.sources.flatMap((n) => [...n.listeners]);
  e.audio.setBattleBeat("quiet");
  e.audio.play("player_death");
  const death = c.sources.at(-1);
  const duck = plain(c.gains[1].gain.events);
  for (const fn of old) fn();
  assert.equal(e.audio.diagnostics().ownedSources, 1);
  assert.equal(death.stops.length, 0);
  assert.equal(sourceRecord(c, death).bus, 0);
  assert.deepEqual(plain(c.gains[1].gain.events), duck);
  e.audio.setMusicMode("silent");
  e.run(5000);
  assert.equal(e.audio.diagnostics().ownedSources, 0);
  e.audio.dispose();
  e.audio.dispose();
  for (const node of c.nodes) assert.equal(node.disconnected, 1);
  assert.equal(c.closed, 1);
});

test("native sealed sound setter honors pause-before-unlock and latest beat without queued cues", async () => {
  const e = environment({ initial: "suspended", delayed: true, stored: "0", activation: false });
  e.audio.setBattleBeat("build");
  e.audio.setMusicMode("boss");
  e.audio.setMuted(false);
  assert.equal(e.contexts.length, 0);
  e.audio.setSuspended(true);
  e.window.navigator.userActivation.isActive = true;
  e.audio.setMuted(false);
  const c = e.contexts[0];
  assert.equal(c.operations.length, 1);
  assert.equal(c.operations[0].kind, "resume");
  e.audio.setBattleBeat("crest");
  e.audio.play("boss_arrival");
  c.operations.shift().finish();
  await settle();
  assert.equal(c.operations[0].kind, "suspend");
  c.operations.shift().finish();
  await settle();
  assertEmpty(e);
  e.window.navigator.userActivation.isActive = false;
  e.audio.setSuspended(false);
  c.operations.shift().finish();
  await settle();
  assert.equal(e.audio.diagnostics().battleBeat, "crest");
  assert.equal(c.sources.length, 0);
  e.run(600);
  assert.equal(musicSources(c).length, 2);
  assert.equal(c.sources.length, 2, "missed boss cue never replayed");
  e.audio.dispose();
});

test("mute/pause cancel current and future graphs; stale scheduler cannot resurrect them", async () => {
  for (const control of ["mute", "pause"]) {
    const e = start();
    e.run(600);
    assert.ok(e.audio.diagnostics().scheduledSources > 0);
    const old = [...e.timers.values()][0].fn;
    if (control === "mute") e.audio.setMuted(true);
    else e.audio.setSuspended(true);
    assertEmpty(e);
    e.audio.setBattleBeat("aftermath");
    e.audio.play("player_death");
    old();
    await settle();
    assertEmpty(e);
    if (control === "mute") e.audio.setMuted(false);
    else e.audio.setSuspended(false);
    await settle();
    assert.equal(e.timers.size, 1);
    assert.equal(e.audio.diagnostics().ownedSources, 0);
    e.audio.dispose();
  }
});

test("pending async intent, rejection and terminal disposal preserve single-owner cleanup", async () => {
  const e = start("build", "flight", { initial: "suspended", delayed: true, closeReject: true });
  const c = e.contexts[0];
  e.audio.setSuspended(true);
  e.audio.setMuted(true);
  e.audio.setBattleBeat("crest");
  c.operations.shift().finish();
  await settle();
  assert.equal(c.operations[0].kind, "suspend");
  c.operations.shift().reject(new Error("Suspension interrupted"));
  await settle();
  assert.equal(c.operations.length, 0, "no rejection retry loop");
  assertEmpty(e);
  e.audio.setMuted(false);
  e.audio.setSuspended(false);
  await settle();
  e.run(600);
  e.audio.setSuspended(true);
  const pending = c.operations.shift();
  e.audio.dispose();
  e.audio.dispose();
  pending.finish();
  await settle();
  e.audio.setBattleBeat("aftermath");
  e.audio.setMusicMode("boss");
  e.audio.setSuspended(false);
  e.audio.setMuted(false);
  e.unlock();
  assertEmpty(e);
  assert.equal(e.audio.diagnostics().cachedBuffers, 0);
  assert.equal(c.closed, 1);
  for (const node of c.nodes) assert.equal(node.disconnected, 1);
});

test("silent trailer preference/cut cancel score and duck without changing persisted sound", async () => {
  const e = environment({ stored: "0", activation: false });
  e.audio.muted = false;
  e.audio.setBattleBeat("crest");
  e.audio.setMusicMode("boss");
  assert.equal(e.contexts.length, 0);
  e.window.navigator.userActivation.isActive = true;
  e.unlock();
  e.run(600);
  e.audio.play("player_death");
  e.audio.clearTransient();
  assertEmpty(e);
  assert.equal(e.audio.diagnostics().duckGain, 1);
  assert.equal(e.storageWrites.length, 0);
  e.audio.setSuspended(true);
  await settle();
  e.audio.setSuspended(false);
  await settle();
  assertEmpty(e);
  e.audio.dispose();
});
