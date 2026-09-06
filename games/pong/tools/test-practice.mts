import assert from "node:assert/strict";
import { test } from "node:test";
import { PaddleStroke } from "../src/shared/spin.ts";
import { advanceLesson, advancePractice } from "../src/shared/practice.ts";
import type { CurveProgress } from "../src/shared/practice.ts";

test("practice needs separate return, left and right accepted contacts in order", () => {
  let progress: CurveProgress = "return";
  progress = advancePractice(progress, -1);
  assert.equal(progress, "left", "one curve cannot skip the first return objective");
  for (const strength of [0, 0.14, 1, -0.149]) {
    progress = advancePractice(progress, strength);
    assert.equal(progress, "left");
  }
  progress = advancePractice(progress, -0.15);
  assert.equal(progress, "right");
  for (const strength of [-1, -0.15, 0, 0.149]) {
    progress = advancePractice(progress, strength);
    assert.equal(progress, "right");
  }
  progress = advancePractice(progress, 0.15);
  assert.equal(progress, "complete");
  for (const strength of [-1, 0, 1]) assert.equal(advancePractice(progress, strength), "complete");
});

test("invalid contact strength never advances either sequence", () => {
  for (const strength of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(advancePractice("return", strength), "return");
    assert.equal(advancePractice("left", strength), "left");
    assert.equal(advanceLesson("return", strength), "return");
  }
});

test("normal teaching retires after an accepted curve and stays retired across later returns", () => {
  assert.equal(advanceLesson("return", 0), "curve");
  assert.equal(advanceLesson("curve", 0), "curve");
  assert.equal(advanceLesson("return", -0.15), "complete");
  assert.equal(advanceLesson("curve", 0.15), "complete");
  assert.equal(advanceLesson("complete", 0), "complete");
});

test("actual stroke samples advance only with fresh, accepted curve strength", () => {
  const stroke = new PaddleStroke();
  for (let i = 0; i < 5; i++) stroke.sample(-i * 0.3, i / 60, "pointer");
  assert.equal(advancePractice("left", stroke.read(0.08)), "right");
  assert.equal(advancePractice("left", stroke.read(0.3)), "left");
  stroke.reset();
  assert.equal(advancePractice("left", stroke.read(0.08)), "left");
  // A guest's accepted canonical stroke is negated into its screen frame.
  assert.equal(advancePractice("left", 0.5 * -1), "right");
});
