import assert from "node:assert/strict";
import { test } from "node:test";
import { PaddleStroke } from "../src/shared/spin.ts";
import { advanceLesson } from "../src/shared/curve-lesson.ts";

test("invalid contact strength never advances the passive lesson", () => {
  for (const strength of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(advanceLesson("return", strength), "return");
    assert.equal(advanceLesson("curve", strength), "curve");
  }
});

test("normal teaching retires after either accepted curve and stays retired", () => {
  assert.equal(advanceLesson("return", 0), "curve");
  for (const strength of [-0.149, 0, 0.149])
    assert.equal(advanceLesson("curve", strength), "curve");
  assert.equal(advanceLesson("return", -0.15), "complete");
  assert.equal(advanceLesson("curve", 0.15), "complete");
  assert.equal(advanceLesson("complete", 0), "complete");
});

test("actual stroke samples teach only with fresh, accepted curve strength", () => {
  const stroke = new PaddleStroke();
  for (let i = 0; i < 5; i++) stroke.sample(-i * 0.3, i / 60, "pointer");
  assert.equal(advanceLesson("curve", stroke.read(0.08)), "complete");
  assert.equal(advanceLesson("curve", stroke.read(0.3)), "curve");
  stroke.reset();
  assert.equal(advanceLesson("curve", stroke.read(0.08)), "curve");
  // A guest's accepted canonical stroke is negated into its screen frame.
  assert.equal(advanceLesson("curve", 0.5 * -1), "complete");
});
