import assert from "node:assert/strict";
import { test } from "node:test";
import { BRAWLERS } from "../src/config.ts";
import { buildBrawlerModel } from "../src/entities/brawler-model.ts";
import { rangedPoseDuration, sampleRangedPose } from "../src/entities/ranged-pose.ts";

const ranged = Object.values(BRAWLERS).filter((def) => def.attack.kind !== "melee");

for (const def of ranged) {
  test(`${def.name}: attack and super pose at release, then settle without replaying`, () => {
    const rest = sampleRangedPose(null, def.id);
    for (const isSuper of [false, true]) {
      const duration = rangedPoseDuration(def.id, isSuper);
      const cue = { elapsed: 0, isSuper };
      const release = sampleRangedPose(cue, def.id);
      assert.notDeepEqual(release, rest, "the shot must have an immediate visible pose");
      const recovery = sampleRangedPose({ ...cue, elapsed: duration * 0.55 }, def.id);
      assert.notDeepEqual(recovery, release);
      assert.notDeepEqual(recovery, rest);
      assert.deepEqual(cue, { elapsed: 0, isSuper }, "sampling must not advance the cue");
      const beforeEnd = sampleRangedPose({ ...cue, elapsed: duration - 1e-6 }, def.id);
      const residual = Object.values({ ...beforeEnd, loaded: 0, weaponVisible: 0 });
      assert.ok(
        residual.every((value) => Math.abs(value) < 1e-8),
        "pose must settle smoothly",
      );
      assert.equal(beforeEnd.loaded, true);
      assert.equal(beforeEnd.weaponVisible, true);
      assert.deepEqual(sampleRangedPose({ ...cue, elapsed: duration }, def.id), rest);
      assert.deepEqual(sampleRangedPose({ ...cue, elapsed: duration + 5 }, def.id), rest);
      assert.deepEqual(sampleRangedPose({ ...cue, elapsed: 0 }, def.id), release);
    }
    assert.notDeepEqual(
      sampleRangedPose({ elapsed: 0, isSuper: false }, def.id),
      sampleRangedPose({ elapsed: 0, isSuper: true }, def.id),
      "the existing super needs a distinct pose",
    );
  });
}

test("the six ranged champions have distinct release silhouettes", () => {
  for (const isSuper of [false, true]) {
    const poses = ranged.map((def) =>
      JSON.stringify(sampleRangedPose({ elapsed: 0, isSuper }, def.id)),
    );
    assert.equal(new Set(poses).size, 6);
  }
});

test("released arrows, bolts, javelins and flasks return only during recovery", () => {
  for (const id of ["ace", "flint", "rowan", "pip"] satisfies (keyof typeof BRAWLERS)[]) {
    for (const isSuper of [false, true]) {
      const release = sampleRangedPose({ elapsed: 0, isSuper }, id);
      const recovered = sampleRangedPose(
        { elapsed: rangedPoseDuration(id, isSuper) * 0.8, isSuper },
        id,
      );
      if (id === "ace" || id === "flint") {
        assert.equal(release.loaded, false);
        assert.equal(release.weaponVisible, true);
        assert.equal(recovered.loaded, true);
      } else {
        assert.equal(release.weaponVisible, false);
        assert.equal(recovered.weaponVisible, true);
      }
    }
  }
});

test("bow and crossbow ammunition retain independent groups after rigid mesh batching", () => {
  for (const def of [BRAWLERS.ace, BRAWLERS.flint]) {
    const model = buildBrawlerModel(def, 0);
    assert.ok(model.loadedProjectile);
    assert.equal(model.loadedProjectile.parent, model.weapon);
    assert.ok(model.loadedProjectile.children.length > 0);
    model.loadedProjectile.visible = false;
    assert.equal(model.weapon.visible, true);
    for (const material of model.allMats) {
      material.dispose();
    }
  }
});

test("Briar, Rook and Nyx retain their existing melee and leap animation paths", () => {
  for (const id of ["dusty", "titan", "nyx"] satisfies (keyof typeof BRAWLERS)[]) {
    for (const isSuper of [false, true]) {
      assert.equal(rangedPoseDuration(id, isSuper), 0);
      assert.deepEqual(sampleRangedPose({ elapsed: 0, isSuper }, id), sampleRangedPose(null, id));
    }
  }
});
