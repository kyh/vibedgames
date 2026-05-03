import assert from "node:assert/strict";
import { test } from "node:test";

import { collectRepeatedStringFlag } from "../src/lib/repeated-flags";

test("collects repeated flag values from raw args", () => {
  assert.deepEqual(
    collectRepeatedStringFlag("last.png", ["--image", "one.png", "--image", "two.png"], "--image"),
    ["one.png", "two.png"],
  );
});

test("collects inline flag values from raw args", () => {
  assert.deepEqual(
    collectRepeatedStringFlag(undefined, ["--image=one.png", "--image=two.png"], "--image"),
    ["one.png", "two.png"],
  );
});

test("falls back to parsed value when raw args do not contain the flag", () => {
  assert.deepEqual(collectRepeatedStringFlag(["one.png", "two.png"], [], "--image"), [
    "one.png",
    "two.png",
  ]);
});

test("stops parsing after argument terminator", () => {
  assert.deepEqual(
    collectRepeatedStringFlag(undefined, ["--", "--image", "one.png"], "--image"),
    [],
  );
});
