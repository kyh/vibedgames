import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { Audio } from "../src/render/audio.ts";
import { Fx } from "../src/render/fx.ts";
import { isLocalCast } from "../src/net/cast-actor.ts";
import { castAbility } from "../src/sim/abilities.ts";
import { createWorld, spawnHero } from "../src/sim/world.ts";
import { environment, records, settle } from "./audio-priority-harness.mjs";

const source = readFileSync(new URL("../src/render/audio.ts", import.meta.url), "utf8");
const original = JSON.parse(
  readFileSync(new URL("./fixtures/audio-action-oracle.json", import.meta.url), "utf8"),
);
const method = (name) => {
  const match = new RegExp(`^  (?:private )?${name}\\(`, "m").exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf("\n  }", match.index) + 4);
};
for (const [name, hash] of Object.entries(original.dependencies))
  assert.equal(
    createHash("sha256").update(method(name)).digest("hex"),
    hash,
    `${name} original recipe dependency`,
  );
const constantStart = source.indexOf("const CAST_MOD:");
assert.equal(
  source.slice(constantStart, source.indexOf("\n};", constantStart) + 3),
  original.castMod,
);
const oracleSource = `${original.castMod}\nclass OriginalActions extends Audio {\n${original.attack}\n${original.cast}\n}`;
const OriginalActions = new Function(
  "Audio",
  `${stripTypeScriptTypes(oracleSource)}\nreturn OriginalActions;`,
)(Audio);
const champions = ["knight", "rogue", "ranger", "mage", "blackknight", "witch"];
const cases = [
  ...champions.map((champ) => ["attack", [champ, 8, -3]]),
  ["attack", ["unknown", 8, -3]],
  ...champions.flatMap((champ) =>
    ["Q", "W", "E", "R", "DASH", "JUMP"].map((key) => ["cast", [champ, key, 8, -3]]),
  ),
  ["cast", ["", "Q", 8, -3]],
];
let groups = 0;
for (const [name, args] of cases) {
  const before = await environment({ AudioClass: OriginalActions });
  before.gesture();
  before.audio.setListener(3, 2, 0.6, 0.8);
  const c0 = before.contexts[0];
  const expectedAt = c0.sources.length;
  before.audio[name](...args);
  const expected = records(c0, expectedAt);
  before.audio.dispose();
  for (const local of [false, true]) {
    const e = await environment();
    e.gesture();
    e.audio.setListener(3, 2, 0.6, 0.8);
    const c = e.contexts[0],
      at = c.sources.length;
    e.audio[name](...args, local);
    assert.deepEqual(
      records(c, at),
      expected,
      `${name} ${args} local=${local}: original graph, timing, jitter, routes`,
    );
    assert.equal(e.audio.diagnostics().sfx.groups, 1, "one admitted action phrase");
    e.audio.dispose();
  }
}
groups++;

// Far requests cannot swallow an audible request, including the nested R/DASH gates.
for (const name of ["attack", "cast"])
  for (const key of ["Q", "R", "DASH"]) {
    const e = await environment();
    e.gesture();
    const c = e.contexts[0],
      at = c.sources.length;
    if (name === "attack") e.audio.attack("witch", 100, 100);
    else e.audio.cast("witch", key, 100, 100);
    assert.equal(c.sources.length, at);
    assert.deepEqual(e.audio.last, {});
    if (name === "attack") e.audio.attack("witch", 0, 0);
    else e.audio.cast("witch", key, 0, 0);
    assert.ok(c.sources.length > at, "audible same-clock request admitted");
    e.audio.dispose();
  }
groups++;

// Remote same-champion voices and nested ult/dodge cannot suppress local acceptance.
for (const champ of champions)
  for (const key of ["Q", "R", "DASH"]) {
    const e = await environment();
    e.gesture();
    e.audio.attack(champ, 0, 0);
    let accepted = e.audio.diagnostics().sfx.acceptedSources;
    e.audio.attack(champ, 0, 0, true);
    assert.equal(e.audio.diagnostics().sfx.acceptedSources, accepted * 2);
    e.audio.cast(champ, key, 0, 0);
    const before = e.audio.diagnostics().sfx.acceptedSources;
    e.audio.cast(champ, key, 0, 0, true);
    assert.equal(e.audio.diagnostics().sfx.acceptedSources - before, before - accepted * 2);
    accepted = e.audio.diagnostics().sfx.acceptedSources;
    e.audio.attack(champ, 0, 0, true);
    e.audio.cast(champ, key, 0, 0, true);
    assert.equal(e.audio.diagnostics().sfx.acceptedSources, accepted, "duplicates remain gated");
    e.audio.dispose();
  }
{
  const e = await environment();
  e.gesture();
  e.audio.cast("knight", "Q", 0, 0, true);
  const accepted = e.audio.diagnostics().sfx.acceptedSources;
  e.audio.cast("knight", "W", 0, 0, true);
  assert.ok(
    e.audio.diagnostics().sfx.acceptedSources > accepted,
    "distinct local keys remain audible",
  );
  e.audio.dispose();
}
groups++;

// Routine requests admit whole phrases or nothing; rejection consumes no gate.
for (const key of ["R", "DASH"]) {
  const e = await environment();
  e.gesture();
  for (let i = 0; i < 31; i++) e.audio.tone({ freq: 440, dur: 5, gain: 0.1 });
  const c = e.contexts[0],
    before = c.sources.length;
  e.audio.cast("witch", key, 0, 0);
  assert.equal(c.sources.length, before, "no partial routine voice");
  assert.deepEqual(e.audio.last, {}, "nested gates uncommitted after rejected phrase");
  for (const source of c.sources) source.finish();
  e.audio.cast("witch", key, 0, 0);
  assert.ok(c.sources.length > before);
  assert.equal(e.audio.diagnostics().sfx.groups, 1);
  e.audio.dispose();
}
{
  const e = await environment();
  e.gesture();
  for (let i = 0; i < 28; i++) e.audio.tone({ freq: 440, dur: 5, gain: 0.1 });
  const before = e.contexts[0].sources.length;
  e.audio.attack("mage", 20, 0);
  assert.equal(e.contexts[0].sources.length, before, "original early distant shedding retained");
  assert.deepEqual(e.audio.last, {});
  e.audio.attack("mage", 0, 0);
  assert.equal(e.contexts[0].sources.length, before + 3);
  e.audio.dispose();
}
groups++;

// Local phrases preserve cap/reserve under saturation; routine spam cannot evict them.
{
  const e = await environment();
  e.gesture();
  for (let i = 0; i < 32; i++) e.audio.tone({ freq: 440, dur: 5, gain: 0.1 });
  e.audio.cast("witch", "R", 0, 0, true);
  const protectedSources = e.audio.diagnostics().sfx.essentialSources;
  assert.ok(protectedSources > 0);
  for (let i = 0; i < 100; i++) e.audio.uiOpen();
  assert.equal(e.audio.diagnostics().sfx.essentialSources, protectedSources);
  for (const key of ["Q", "W", "E", "DASH", "JUMP"]) e.audio.cast("witch", key, 0, 0, true);
  const d = e.audio.diagnostics();
  assert.ok(d.sfx.ownedSources <= 48 && d.sfx.routineSources <= 32);
  assert.equal(d.sfx.limit, 48);
  assert.equal(d.sfx.routineLimit, 32);
  assert.ok(d.sfx.stoppedSources > 0, "complete older routine groups evicted for local voice");
  assert.ok(d.sfx.scheduledSources > 0);
  e.audio.suspend();
  await settle();
  assert.equal(e.audio.diagnostics().ownedSources, 0);
  e.audio.cast("knight", "Q", 0, 0, true);
  assert.equal(e.audio.diagnostics().ownedSources, 0);
  e.audio.setMuted(true);
  e.audio.setMuted(false);
  e.audio.resume();
  await settle();
  e.audio.resolveMatch("won");
  e.audio.beginMatch();
  assert.deepEqual(e.audio.last, {});
  e.audio.attack("mage", 0, 0, true);
  assert.equal(e.audio.diagnostics().sfx.essentialSources, 3);
  e.audio.dispose();
  e.audio.dispose();
  e.audio.cast("witch", "R", 0, 0, true);
  e.audio.resume();
  assert.equal(e.audio.diagnostics().ownedSources, 0);
  assert.equal(e.audio.diagnostics().schedulerCount, 0);
  assert.equal(e.contexts[0].closed, 1);
  for (const node of e.contexts[0].nodes) assert.equal(node.disconnected, 1);
}
groups++;

// Unready requests allocate nothing and never queue a phrase for later unlock.
{
  const e = await environment({ stored: "1", activation: false });
  e.audio.attack("mage", 0, 0, true);
  e.audio.cast("witch", "R", 0, 0, true);
  e.audio.setMuted(false);
  assert.equal(e.contexts.length, 0);
  window.navigator.userActivation.isActive = true;
  e.gesture();
  assert.equal(e.audio.diagnostics().sfx.acceptedSources, 0);
  e.audio.setMuted(true);
  e.audio.cast("witch", "R", 0, 0, true);
  e.audio.setMuted(false);
  await settle();
  assert.equal(e.audio.diagnostics().sfx.acceptedSources, 0);
  e.audio.cast("witch", "R", 0, 0, true);
  assert.ok(e.audio.diagnostics().sfx.acceptedSources > 0);
  e.audio.dispose();
}
{
  const e = await environment({ initial: "suspended", delayed: true });
  e.gesture();
  const c = e.contexts[0];
  e.audio.cast("witch", "R", 0, 0, true);
  assert.deepEqual(e.audio.last, {});
  e.audio.suspend();
  c.operations.shift().finish();
  await settle();
  assert.equal(e.audio.diagnostics().ownedSources, 0);
  assert.equal(e.audio.diagnostics().schedulerCount, 0);
  e.audio.dispose();
  c.operations.shift().finish();
  await settle();
  e.audio.cast("witch", "R", 0, 0, true);
  e.audio.resume();
  assert.equal(e.audio.diagnostics().ownedSources, 0);
  assert.equal(e.audio.diagnostics().schedulerCount, 0);
  assert.equal(c.closed, 1);
}
groups++;

// Optional network metadata: malformed/old/ownerId/nearby same-kit never imply local.
for (const value of [undefined, null, false, 0, [], {}, "", "owner", "other-unit"])
  assert.equal(isLocalCast(value, "my-unit"), false);
assert.equal(isLocalCast("my-unit", "my-unit"), true);
assert.equal(isLocalCast("", ""), false);
{
  const calls = [];
  const fx = Object.assign(Object.create(Fx.prototype), {
    localId: "my-unit",
    signatureCast: () => {},
    within: () => false,
    audio: { cast: (...args) => calls.push(args), attack: (...args) => calls.push(args) },
  });
  for (const unitId of [undefined, null, 1, {}, "other-unit", "owner", "my-unit"])
    fx.handle({ t: "cast", x: 0, y: 0, dx: 1, dy: 0, champId: "knight", key: "Q", unitId }, {});
  assert.deepEqual(
    calls.map((args) => args[4]),
    [false, false, false, false, false, false, true],
  );
  fx.attackSound("knight", 0, 0);
  fx.attackSound("knight", 0, 0, true);
  assert.deepEqual(
    calls.slice(-2).map((args) => args[3]),
    [false, true],
  );
}
groups++;

// Real accepted caster provenance; rejected casts produce no metadata/event.
for (const champId of champions) {
  const w = createWorld(42);
  const caster = spawnHero(w, {
    id: "my-unit",
    ownerId: "owner",
    team: "A",
    champId,
    name: "A",
    isBot: false,
    slot: 0,
  });
  const accepted = castAbility(w, caster, "Q", { dir: { x: 1, y: 0 } });
  assert.equal(accepted, true);
  const cast = w.fx.filter((event) => event.t === "cast");
  assert.equal(cast.length, 1);
  assert.equal(cast[0].unitId, caster.id);
  assert.equal(isLocalCast(JSON.parse(JSON.stringify(cast[0])).unitId, caster.id), true);
  assert.equal(castAbility(w, caster, "Q", { dir: { x: 1, y: 0 } }), false);
  caster.alive = false;
  assert.equal(castAbility(w, caster, "W", { dir: { x: 1, y: 0 } }), false);
  assert.equal(w.fx.filter((event) => event.t === "cast").length, 1);
}
groups++;
console.log(
  JSON.stringify({
    result: "PASS",
    groups,
    originalRecipes: cases.length,
    graphComparisons: cases.length * 2,
    sourceCaps: { total: 48, routine: 32, music: 24, ambience: 8 },
    limits: "Actual WebAudio graph mock; no speaker/listening or browser claim.",
  }),
);
