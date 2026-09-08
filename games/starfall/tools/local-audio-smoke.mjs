import assert from "node:assert/strict";
import { test } from "node:test";
import { buffers, environment, plain, settle, sourceRecord } from "./audio-harness.mjs";

const diagnostic = (e) => e.audio.diagnostics();
const local = { priority: "local" };

test("all 26 SFX keep identical buffers, pitch, gain, start and routing under local priority", () => {
  const routine = environment();
  const owned = environment();
  routine.unlock();
  owned.unlock();
  assert.deepEqual(buffers(owned.audio), buffers(routine.audio));
  const names = [...routine.audio.buffers.keys()];
  assert.equal(names.length, 26);
  for (const name of names) {
    routine.audio.play(name, { gain: 0.63, rate: 1.17 });
    owned.audio.play(name, { gain: 0.63, rate: 1.17, ...local });
    const a = routine.contexts[0];
    const b = owned.contexts[0];
    assert.deepEqual(
      plain(sourceRecord(b, b.sources.at(-1))),
      plain(sourceRecord(a, a.sources.at(-1))),
      name,
    );
    routine.run(2000);
    owned.run(2000);
  }
  assert.equal(owned.randomDraws(), routine.randomDraws());
  assert.deepEqual(
    plain(owned.contexts[0].gains[1].gain.events),
    plain(routine.contexts[0].gains[1].gain.events),
  );
  routine.audio.dispose();
  owned.audio.dispose();
});

test("routine pressure cannot erase local fire, pickup or progression; 28 leaves four essential slots", () => {
  const e = environment();
  e.unlock();
  for (let i = 0; i < 24; i++) e.audio.play("hit_spark");
  const allocated = e.contexts[0].nodes.length;
  e.audio.play("fire_heavy");
  assert.equal(e.contexts[0].nodes.length, allocated);
  for (const name of ["fire_heavy", "pickup", "pickup_shield", "pickup_booster", "combo_up"]) {
    const accepted = diagnostic(e).accepted;
    e.audio.play(name, local);
    assert.equal(diagnostic(e).accepted, accepted + 1, name);
  }
  assert.equal(diagnostic(e).ownedSources, 28);
  assert.equal(diagnostic(e).localSources, 5);
  assert.equal(diagnostic(e).routineSources, 23);
  for (const name of ["telegraph_warn", "shield_hit", "boss_phase", "player_death"])
    e.audio.play(name, local);
  assert.equal(diagnostic(e).essentialSources, 4, "local option cannot demote an essential name");
  assert.equal(diagnostic(e).ownedSources, 32);
  const essential = e.contexts[0].sources.slice(-4);
  for (let i = 0; i < 80; i++) e.audio.play("fire_heavy", local);
  assert.ok(essential.every((source) => source.stops.length === 0));
  assert.equal(diagnostic(e).ownedSources, 28);
  assert.equal(diagnostic(e).peak, 32);
  assert.deepEqual(
    [
      diagnostic(e).limit,
      diagnostic(e).routineLimit,
      diagnostic(e).localLimit,
      diagnostic(e).musicLimit,
    ],
    [32, 24, 28, 2],
  );
  e.audio.dispose();
});

test("local admission clears the entire music phrase first; impossible admission evicts nothing", () => {
  const e = environment();
  e.audio.setBattleBeat("crest");
  e.audio.setMusicMode("flight");
  e.unlock();
  e.run(600);
  assert.equal(diagnostic(e).musicVoices, 2);
  const phrase = e.contexts[0].sources.slice();
  for (let i = 0; i < 22; i++) e.audio.play("hit_spark");
  for (let i = 0; i < 4; i++) e.audio.play("pickup", local);
  e.audio.play("fire_heavy", local);
  assert.equal(diagnostic(e).musicVoices, 0);
  assert.ok(phrase.every((source) => source.stops.length === 1));
  assert.equal(diagnostic(e).ownedSources, 27);
  e.audio.clearTransient();
  for (let i = 0; i < 29; i++) e.audio.play("telegraph_warn");
  const before = diagnostic(e);
  const nodes = e.contexts[0].nodes.length;
  e.audio.play("pickup", local);
  assert.equal(diagnostic(e).dropped, before.dropped + 1);
  assert.equal(diagnostic(e).stopped, before.stopped);
  assert.equal(e.contexts[0].nodes.length, nodes);
  e.audio.dispose();
});

test("zero-gain and invalid local requests consume neither voices nor pitch draws", () => {
  const e = environment();
  e.unlock();
  for (let i = 0; i < 28; i++) e.audio.play("fire_heavy", local);
  const before = diagnostic(e);
  const draws = e.randomDraws();
  const nodes = e.contexts[0].nodes.length;
  for (const gain of [0, -1, NaN, Infinity]) e.audio.play("pickup", { ...local, gain });
  for (const rate of [0, -1, NaN, Infinity]) e.audio.play("pickup", { ...local, rate });
  assert.deepEqual(diagnostic(e), before);
  assert.equal(e.contexts[0].nodes.length, nodes);
  assert.equal(e.randomDraws(), draws);
  e.audio.dispose();
});

test("pause, mute and cuts cancel local graphs without replaying; fresh cue retains same context", async () => {
  for (const mode of ["pause", "mute", "cut"]) {
    const e = environment();
    e.unlock();
    e.audio.play("pickup", local);
    const source = e.contexts[0].sources[0];
    const late = [...source.listeners];
    if (mode === "pause") e.audio.setSuspended(true);
    else if (mode === "mute") e.audio.setMuted(true);
    else e.audio.clearTransient();
    assert.equal(diagnostic(e).ownedSources, 0);
    assert.equal(source.disconnected, 1);
    assert.equal(source.links[0].disconnected, 1);
    if (mode !== "cut") e.audio.play("pickup", local);
    e.audio.setSuspended(false);
    e.audio.setMuted(false);
    await settle();
    assert.equal(diagnostic(e).ownedSources, 0);
    e.audio.play("pickup", local);
    for (const fn of late) fn();
    assert.equal(diagnostic(e).localSources, 1);
    assert.equal(e.contexts.length, 1);
    e.audio.dispose();
    assert.ok(e.contexts[0].nodes.every((node) => node.disconnected === 1));
  }
});

test("delayed unlock and final disposal cannot resurrect a local cue or scheduler", async () => {
  const e = environment({ initial: "suspended", delayed: true });
  e.unlock();
  e.audio.play("pickup", local);
  assert.equal(diagnostic(e).ownedSources, 0);
  const ac = e.contexts[0];
  e.audio.dispose();
  ac.operations[0].finish();
  await settle();
  e.audio.play("fire_heavy", local);
  e.audio.setSuspended(false);
  e.audio.setMuted(false);
  e.audio.unlock();
  assert.equal(diagnostic(e).disposed, true);
  assert.equal(diagnostic(e).ownedSources, 0);
  assert.equal(diagnostic(e).schedulerCount, 0);
  assert.equal(ac.sources.length, 0);
  assert.equal(e.contexts.length, 1);
  assert.equal(ac.closed, 1);
});
