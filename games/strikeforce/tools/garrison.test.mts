// The crew's tuning: the core's machine numbers, read as ratios.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ROLES, baseTune, field, roleOf } from "../src/garrison/roles.ts";

test("Standard fields the roles as written", () => {
  const tune = baseTune();
  assert.equal(field("gull", tune).hp, ROLES.gull.hp);
  assert.equal(field("hound", tune).hp, ROLES.hound.hp);
  assert.equal(field("gull", tune).profile.aim.damage, ROLES.gull.profile.aim.damage);
  assert.equal(field("gull", tune).label, "Rifleman");
  assert.equal(field("hound", tune).label, "Heavy");
});

test("a preset or a Holdout wave scales a soldier as it scaled the machine", () => {
  const tune = baseTune();
  tune.gull.hp = 55;
  tune.gull.boltDamage = 10;
  tune.gull.cooldown = [1.4, 2.5];
  tune.gull.spreadFar = 0.052;
  const hard = field("gull", tune);
  assert.equal(hard.hp, Math.round(ROLES.gull.hp * (55 / 45)));
  assert.ok(Math.abs(hard.profile.aim.damage - ROLES.gull.profile.aim.damage * (10 / 7)) < 1e-9);
  assert.ok(hard.profile.aim.pause[0] < ROLES.gull.profile.aim.pause[0], "shorter pauses");
  assert.ok(hard.profile.aim.hit > ROLES.gull.profile.aim.hit, "tighter spread, better shot");
});

test("accuracy is capped: no difficulty makes a laser", () => {
  const tune = baseTune();
  tune.hound.spreadFar = 0.001;
  assert.ok(field("hound", tune).profile.aim.hit <= 0.85);
});

test("the director's kinds map to roles; anything else is a rifleman", () => {
  assert.equal(roleOf("hound"), "hound");
  assert.equal(roleOf("gull"), "gull");
  assert.equal(roleOf("drone"), "gull");
});
