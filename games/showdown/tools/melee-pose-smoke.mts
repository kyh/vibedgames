import assert from "node:assert/strict";
import { test } from "node:test";
import { Euler, Quaternion, Vector3 } from "three";
import { BRAWLERS } from "../src/config.ts";
import { buildBrawlerModel } from "../src/entities/brawler-model.ts";
import { sampleMeleePose } from "../src/entities/melee-pose.ts";

for (const def of Object.values(BRAWLERS).filter((kit) => kit.attack.kind === "melee")) {
  const { attack } = def;
  if (attack.kind !== "melee") {
    throw new Error("Expected a melee champion");
  }
  const { style } = attack;
  const cue = { angle: 0, elapsed: 0, recovery: attack.recovery, windup: attack.windup };

  test(`${def.name}: blade reaches the committed direction exactly at the combat deadline`, () => {
    const contact = sampleMeleePose({ ...cue, elapsed: attack.windup }, style);
    const blade = new Vector3(0, 1, 0).applyEuler(
      new Euler(contact.weaponPitch, contact.weaponYaw, contact.weaponRoll, "YXZ"),
    );
    assert.ok(blade.distanceTo(new Vector3(0, 0, 1)) < 1e-8);
    assert.equal(contact.commitment, 1);
    const before = sampleMeleePose({ ...cue, elapsed: attack.windup - 1e-6 }, style);
    assert.ok(Math.abs(before.weaponPitch - contact.weaponPitch) < 0.0001);
    assert.ok(Math.abs(before.weaponYaw - contact.weaponYaw) < 0.0001);
  });

  test(`${def.name}: a late snapshot samples follow-through then returns smoothly to aim`, () => {
    const early = sampleMeleePose({ ...cue, elapsed: attack.windup + 0.02 }, style);
    assert.equal(early.commitment, 1);
    const late = sampleMeleePose(
      { ...cue, elapsed: attack.windup + attack.recovery * 0.85 },
      style,
    );
    assert.ok(late.commitment > 0 && late.commitment < 0.15);
    const rest = sampleMeleePose(null, style);
    const end = sampleMeleePose({ ...cue, elapsed: attack.windup + attack.recovery }, style);
    assert.deepEqual(end, rest);
    const last = sampleMeleePose(
      { ...cue, elapsed: attack.windup + attack.recovery - 1e-6 },
      style,
    );
    assert.ok(Math.abs(last.weaponPitch - rest.weaponPitch) < 1e-8);
    assert.ok(last.commitment < 1e-8);
  });

  test(`${def.name}: the weapon grip stays in its hand through shoulder and body rotation`, () => {
    const model = buildBrawlerModel(def, 0);
    const [, arm] = model.arms;
    assert.equal(model.weapon.parent, arm);
    for (const elapsed of [0, attack.windup * 0.6, attack.windup, attack.windup + 0.1]) {
      const pose = sampleMeleePose({ ...cue, elapsed }, style);
      const [, base] = model.pose.armBase;
      arm.rotation.set(base[0] + pose.armPitch, pose.armYaw, base[1] + pose.armRoll);
      model.body.rotation.set(pose.bodyPitch, pose.bodyYaw, 0);
      const desired = new Quaternion().setFromEuler(
        new Euler(pose.weaponPitch, pose.weaponYaw, pose.weaponRoll, "YXZ"),
      );
      model.weapon.quaternion
        .copy(arm.quaternion)
        .invert()
        .multiply(model.body.quaternion.clone().invert())
        .multiply(desired);
      model.root.updateMatrixWorld(true);
      const hand = arm.localToWorld(new Vector3(0, -0.28, 0));
      const grip = model.weapon.getWorldPosition(new Vector3());
      assert.ok(hand.distanceTo(grip) < 1e-8);
    }
    for (const material of model.allMats) {
      material.dispose();
    }
  });
}
