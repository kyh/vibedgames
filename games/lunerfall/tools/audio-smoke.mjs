import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { digest, environment, records, settle } from "./audio-harness.mjs";

const baseline = JSON.parse(
  readFileSync(new URL("./fixtures/audio-recipes.json", import.meta.url)),
);

test("all 15 original cue graphs, noise bytes, jitter draws and 32 music steps remain exact", () => {
  for (const [cue, expected] of Object.entries(baseline.cues)) {
    for (const priority of [undefined, "routine", "local", "essential"]) {
      const f = environment();
      f.sfx[cue](priority);
      assert.deepEqual(
        { digest: digest(records(f.contexts[0])), randomDraws: f.randomDraws },
        expected,
        `${cue}:${priority}`,
      );
      f.sfx.dispose();
    }
  }
  const f = environment();
  f.sfx.unlock();
  for (let i = 0; i < 32; i++) {
    f.contexts[0].advance(0.2);
    f.tick();
  }
  assert.deepEqual(
    { digest: digest(records(f.contexts[0])), randomDraws: f.randomDraws },
    baseline.music,
  );
  assert.equal(f.sfx.diagnostics().musicStep, 32);
  assert.equal(f.sfx.diagnostics().dropped, 0);
  f.sfx.dispose();
});

test("local accepted phrases retire whole routine phrases and retain critical/music reserves", () => {
  const f = environment();
  f.sfx.unlock();
  for (let i = 0; i < 32; i++) f.tick();
  for (let i = 0; i < 10; i++) f.sfx.hit();
  const ctx = f.contexts[0];
  const firstHit = ctx.sources.slice(-20, -18);
  f.sfx.slash("local");
  f.sfx.pickup("local");
  assert.equal(f.sfx.diagnostics().localVoices, 3);
  assert.equal(f.sfx.diagnostics().ownedVoices, 29);
  f.sfx.revive();
  const critical = ctx.sources.slice(-3);
  assert.equal(f.sfx.diagnostics().ownedVoices, 32);
  f.sfx.pickup("local");
  assert.ok(
    firstHit.every((node) => node.disconnected === 1),
    "no orphaned half-hit",
  );
  assert.equal(
    f.sfx.diagnostics().ownedVoices,
    28,
    "whole two-note eviction may leave one reserved slot unused",
  );
  assert.ok(critical.every((node) => node.disconnected === 0));
  for (let i = 0; i < 60; i++) f.sfx.hit("local");
  assert.equal(f.sfx.diagnostics().musicVoices, 6);
  assert.equal(f.sfx.diagnostics().essentialVoices, 3);
  assert.ok(f.sfx.diagnostics().ownedVoices <= 29);
  assert.ok(critical.every((node) => node.disconnected === 0));
  for (let i = 0; i < 30; i++) f.sfx.bossRoar();
  const d = f.sfx.diagnostics();
  assert.equal(d.ownedVoices, 32);
  assert.equal(d.essentialVoices, 26);
  assert.equal(d.musicVoices, 6);
  assert.equal(d.peak, 32);
  const before = ctx.sources.length;
  f.sfx.slash("local");
  f.sfx.hit();
  assert.equal(
    ctx.sources.length,
    before,
    "blocked local/routine cannot evict critical notes or allocate",
  );
  assert.equal(f.sfx.diagnostics().ownedVoices, 32);
  f.sfx.dispose();
  assert.ok(ctx.nodes.every((node) => node.disconnected === 1));
});

test("remote defaults stay routine; local admission never steals a critical phrase even if impossible", () => {
  const f = environment();
  for (let i = 0; i < 10; i++) f.sfx.hit();
  const before = f.sfx.diagnostics().accepted;
  f.sfx.slash();
  f.sfx.pickup();
  f.sfx.hurt("routine");
  assert.equal(f.sfx.diagnostics().accepted, before);
  f.sfx.hurt();
  assert.equal(f.sfx.diagnostics().essentialVoices, 1);
  f.sfx.slash("local");
  assert.equal(f.sfx.diagnostics().localVoices, 1);
  f.sfx.dispose();
  const g = environment();
  for (let i = 0; i < 8; i++) g.sfx.revive();
  const ctx = g.contexts[0];
  const allocated = ctx.sources.length;
  g.sfx.pickup("local");
  assert.equal(ctx.sources.length, allocated);
  assert.equal(g.sfx.diagnostics().essentialVoices, 24);
  assert.equal(g.sfx.diagnostics().stopped, 0);
  g.sfx.dispose();
});

test("pause/mute cancel every owned node, fence stale ends/ticks, resume music without catch-up", async () => {
  const f = environment();
  f.sfx.unlock();
  for (let i = 0; i < 20; i++) f.sfx.unlock();
  f.tick();
  f.sfx.hit("local");
  f.sfx.die();
  const staleTick = [...f.timers.values()][0];
  const ctx = f.contexts[0];
  const staleEnds = ctx.sources.flatMap((node) => [...node.listeners]);
  const step = f.sfx.diagnostics().musicStep;
  f.sfx.setPaused(true);
  assert.equal(f.sfx.diagnostics().ownedVoices, 0);
  assert.equal(f.timers.size, 0);
  await settle();
  f.sfx.muted = true;
  f.sfx.muted = false;
  f.sfx.unlock();
  f.sfx.slash("local");
  assert.equal(f.sfx.diagnostics().ownedVoices, 0);
  assert.equal(f.timers.size, 0);
  staleTick();
  for (const fn of staleEnds) fn();
  assert.equal(f.sfx.diagnostics().musicStep, step);
  assert.equal(f.sfx.diagnostics().ended, 0);
  f.sfx.setPaused(false);
  await settle();
  assert.equal(f.timers.size, 1);
  assert.equal(f.sfx.diagnostics().ownedVoices, 0);
  f.tick();
  assert.equal(f.sfx.diagnostics().musicStep, step + 1);
  f.sfx.muted = true;
  await settle();
  assert.equal(f.sfx.diagnostics().ownedVoices, 0);
  assert.equal(f.timers.size, 0);
  f.sfx.dispose();
  f.sfx.dispose();
  assert.ok(ctx.nodes.every((node) => node.disconnected === 1));
  assert.equal(ctx.closed, 1);
  assert.ok(Object.isFrozen(f.sfx.diagnostics()));
});

test("pre-unlock pause/mute and async resume/reject/dispose preserve latest intent without replay", async () => {
  const locked = environment();
  locked.sfx.setPaused(true);
  locked.sfx.unlock();
  locked.sfx.hurt();
  locked.sfx.muted = true;
  locked.sfx.muted = false;
  assert.equal(locked.contexts.length, 0);
  locked.sfx.setPaused(false);
  assert.equal(locked.contexts.length, 1);
  assert.equal(locked.sfx.diagnostics().ownedVoices, 0);
  locked.sfx.dispose();
  const f = environment({ initial: "suspended", delayed: true, activation: false });
  f.sfx.unlock();
  const ctx = f.contexts[0];
  assert.equal(ctx.operations.length, 0, "no pre-gesture resume promise blocks actual activation");
  f.window.navigator.userActivation.isActive = true;
  f.sfx.unlock();
  ctx.operations.shift().reject(new Error("device denied"));
  await settle();
  assert.equal(ctx.operations.length, 0);
  f.sfx.unlock();
  f.sfx.die();
  f.sfx.setPaused(true);
  ctx.operations.shift().finish();
  await settle();
  assert.equal(ctx.operations[0].kind, "suspend");
  assert.equal(f.timers.size, 0);
  f.sfx.setPaused(false);
  ctx.operations.shift().finish();
  await settle();
  assert.equal(ctx.operations[0].kind, "resume");
  f.sfx.dispose();
  ctx.operations.shift().finish();
  await settle();
  f.sfx.unlock();
  f.sfx.slash("local");
  f.sfx.muted = false;
  assert.equal(f.contexts.length, 1);
  assert.equal(ctx.closed, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.sfx.diagnostics().ownedVoices, 0);
  const absent = environment({ unsupported: true });
  absent.sfx.unlock();
  absent.sfx.bossRoar();
  absent.sfx.dispose();
  assert.equal(absent.contexts.length, 0);
});

test("sample-clock expiry releases complete graphs once and noise buffers reuse until final dispose", () => {
  const f = environment();
  f.sfx.boom("local");
  const ctx = f.contexts[0];
  assert.equal(f.timers.size, 0, "SFX does not implicitly request the bed");
  const callbacks = ctx.sources.flatMap((node) => [...node.listeners]);
  ctx.advance(1);
  assert.equal(f.sfx.diagnostics().ownedVoices, 0);
  assert.equal(f.sfx.diagnostics().phrases, 0);
  assert.equal(f.sfx.diagnostics().ended, 2);
  for (const fn of callbacks) fn();
  assert.equal(f.sfx.diagnostics().ended, 2);
  f.sfx.boom("local");
  assert.equal(ctx.buffers.length, 1);
  f.sfx.dispose();
  assert.ok(ctx.nodes.every((node) => node.disconnected === 1));
});
