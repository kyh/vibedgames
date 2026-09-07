import assert from "node:assert/strict";
import { attackClipFrame, attackPose } from "../src/render/attack-pose";
import { createWorld, spawnHero, step } from "../src/sim/world";
import { tryAttack, resolvePendingAttacks } from "../src/sim/combat";

const world = createWorld(718);
world.gameTime = 300;
step(world);
const attacker = [...world.units.values()].find((u) => u.neutral && u.creep?.boss);
assert.ok(attacker, "real neutral boss must exist");
const victim = spawnHero(world, "ironvow", "radiant", "target", false, 0);
victim.x = attacker.x + 40;
victim.y = attacker.y;
world.now = 2000;
tryAttack(world, attacker, victim);
assert.ok(attacker.pendingAttack);
const cue = {
  startedAt: attacker.lastAttackAt,
  resolveAt: attacker.pendingAttack.resolveAt,
  facing: attacker.facing,
};
const hp = victim.hp;
const before = structuredClone(attacker);
const anticipation = attackPose(cue, cue.resolveAt - 1);
assert.ok(anticipation && anticipation.x < 0 && anticipation.angle < 0);
assert.deepEqual(attacker, before, "presentation must not mutate combat state");
world.now = cue.resolveAt - 1;
resolvePendingAttacks(world);
assert.equal(victim.hp, hp, "wind-up retains real damage deadline");
world.now = cue.resolveAt;
resolvePendingAttacks(world);
assert.ok(victim.hp < hp, "real strike resolves at its original deadline");
const strike = attackPose(cue, world.now);
assert.ok(strike && strike.x > 0 && strike.angle > 0);
assert.deepEqual(attackPose(cue, world.now), strike, "repeated snapshots keep the same pose");
const left = attackPose({ ...cue, facing: -1 }, world.now);
assert.ok(left && left.x === -strike.x && left.angle === -strike.angle);
assert.equal(attackPose(cue, cue.resolveAt + 170), null, "recovery ends at the authored boundary");
for (const [key, count, contact] of [
  ["u-warrior-blue-attack", 6, 3],
  ["u-pawn-red-attack", 6, 3],
  ["u-archer-blue-attack", 7, 6],
  ["u-torch-red-attack", 6, 3],
  ["u-tnt-red-attack", 6, 2],
  ["u-barrel-blue-attack", 3, 2],
] satisfies [string, number, number][]) {
  const beforeContact = attackClipFrame(cue, cue.resolveAt - 1, key, count);
  assert.ok(beforeContact !== null && beforeContact < contact);
  assert.equal(attackClipFrame(cue, cue.resolveAt, key, count), contact, key);
  assert.equal(attackClipFrame(cue, cue.resolveAt + 169, key, count), count - 1);
  assert.equal(attackClipFrame(cue, cue.resolveAt + 170, key, count), null);
  assert.equal(attackClipFrame(cue, cue.startedAt - 1, key, count), null);
}
console.log("✓ neutral attack pose follows real wind-up, strike, recovery and repeated snapshots");
