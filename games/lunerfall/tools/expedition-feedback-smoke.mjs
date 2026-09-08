import assert from "node:assert/strict";
import { fixture, wire, neutral, heroes, enemies } from "./checkpoint-harness.mjs";
import { PlayerBody } from "../src/entities/player-body.ts";
import { Grid } from "../src/sys/grid.ts";
import { RELICS } from "../src/data/relics.ts";
import { specialReadiness } from "../src/data/special-readiness.ts";

for (const hero of Object.values(heroes.HEROES)) {
  const body = new PlayerBody(Grid.test(), 40, 240, hero.kit);
  body.step(1 / 60);
  assert.equal(body.specialReadiness.kind, "ready");
  const before = body.checkpoint();
  for (let i = 0; i < 20; i++) void body.specialReadiness;
  assert.deepEqual(body.checkpoint(), before, "reading readiness cannot mutate combat");
  body.buffer({ ...neutral, specialPressed: true });
  body.step(1 / 60);
  assert.equal(body.specialId, 1);
  assert.equal(body.specialReadiness.kind, "cooldown");
  assert.deepEqual(body.specialReadiness, specialReadiness(body.checkpoint()));
  for (const blocked of [
    { dead: true },
    { downed: true },
    { specialActive: true },
    { attackStep: 1 },
    { dashTime: 0.1 },
    { hurtStun: 0.1 },
  ]) {
    body.restore({ ...before, ...blocked });
    assert.equal(body.specialReadiness.kind, "busy");
    body.buffer({ ...neutral, specialPressed: true });
    body.step(1 / 60);
    assert.equal(body.specialId, 0, "a blocked cue cannot claim an accepted special");
  }
}
console.log(
  "PASS five real hero bodies: exact readiness/cooldown gates, rejected casts and read-only access",
);

const host = fixture(),
  guest = fixture("right");
const h = host.scene,
  g = guest.scene;
h.roomDirty = true;
guest.session.isHost = false;
guest.session.hostId = "left";
g.role = "guest";
g.authority = { kind: "waiting" };
const deliver = () => {
  h.hostNet(0, true);
  guest.session.sharedState = wire(host.session.sharedState);
  g.prepareSession();
  g.stepGuest(0);
};
const relic = RELICS[0];
assert.ok(relic);
h.applyRelic(relic);
h.score = 123;
deliver();
assert.equal(g.score, 123);
assert.deepEqual([...g.ownedRelics], [relic.id]);
const guestMods = { ...g.mods },
  guestBody = g.player.body.checkpoint();
g.syncGuestProgress(guest.session.sharedState.checkpoint);
assert.deepEqual(g.mods, guestMods);
assert.deepEqual(g.player.body.checkpoint(), guestBody);
assert.deepEqual(guest.bank, []);
const oldCheckpoint = wire(guest.session.sharedState.checkpoint);
h.score = 150;
deliver();
g.syncGuestProgress(oldCheckpoint);
assert.equal(g.score, 150, "stale accepted progress cannot roll back the HUD");
g.syncGuestProgress({ ...oldCheckpoint, tick: 99999, term: 99, score: 999 });
assert.equal(g.score, 150);
console.log(
  "PASS accepted shared progress: admission/fresh checkpoint, stale/foreign rejection, no modifiers or banking",
);

guest.cues.length = 0;
h.player.buffer({ ...neutral, attackPressed: true });
h.player.step(1 / 60);
deliver();
assert.equal(guest.cues.filter((c) => c === "sound:slash").length, 1);
for (let i = 0; i < 5; i++) {
  g.stepGuest(0);
  g.renderGuestViews(1 / 60);
}
assert.equal(guest.cues.filter((c) => c === "sound:slash").length, 1);
for (let i = 0; i < 60; i++) h.player.step(1 / 60);
h.player.buffer({ ...neutral, attackPressed: true });
h.player.step(1 / 60);
deliver();
assert.equal(guest.cues.filter((c) => c === "sound:slash").length, 2);
g.guestCueBaseline = true;
guest.cues.length = 0;
deliver();
assert.equal(guest.cues.length, 0, "admission baseline cannot replay combat");
console.log(
  "PASS real accepted remote swings: one cue per fresh action, silent repeated renders/admission",
);

const enemy = new host.context.Enemy(h, h.grid, enemies.ENEMIES.warrior, 180, 240);
h.enemies.push(enemy);
deliver();
guest.cues.length = 0;
enemy.body.takeHit(1, 0, 1);
deliver();
assert.equal(guest.cues.filter((c) => c === "sound:hit").length, 1);
deliver();
assert.equal(guest.cues.filter((c) => c === "sound:hit").length, 1);
for (let i = 0; i < 6; i++) enemy.body.step(1 / 60, h.player.x, h.player.y);
enemy.body.takeHit(10, 0, 1);
deliver();
assert.equal(guest.cues.filter((c) => c === "sound:kill").length, 1);
deliver();
h.enemies = [];
deliver();
assert.equal(guest.cues.filter((c) => c === "sound:kill").length, 1);
assert.deepEqual(guest.bank, []);
console.log(
  "PASS accepted contact/death edges; repeated packets and disappearance do not invent kills",
);

const reduced = fixture();
// The scene owns the MediaQueryList captured at module load; swap only this
// fixture's matches getter, then compile the actual class against it.
const media = { matches: true };
reduced.context.window.matchMedia = () => media;
const { loadClass } = await import("./checkpoint-harness.mjs");
const ReducedScene = loadClass("../src/scenes/game-scene.ts", "GameScene", reduced.context);
let shakes = 0;
const shake = ReducedScene.prototype.shake;
const receiver = { cameras: { main: { shake: () => shakes++ } } };
shake.call(receiver, 420, 0.02);
assert.equal(shakes, 0);
media.matches = false;
shake.call(receiver, 60, 0.003);
assert.equal(shakes, 1);
console.log("PASS actual camera seam reads live reduced motion and does not queue trauma");

for (const role of ["host", "guest"]) {
  const f = fixture();
  const s = f.scene;
  s.mode = "versus";
  s.role = role;
  s.guestSpecial = { kind: "ready" };
  s.updateVersusHud = () => {};
  let readout;
  s.expeditionHud = {
    updateSpecial: (value) => {
      readout = value;
    },
  };
  for (const phase of ["waiting", "countdown", "fighting", "roundEnd", "matchEnd"]) {
    s.vs = s.netVs = { phase };
    f.Scene.prototype.updateHud.call(s);
    assert.equal(readout.kind, phase === "countdown" || phase === "matchEnd" ? "busy" : "ready");
  }
}
console.log("PASS host and guest versus readiness follows existing frozen phase gates");
