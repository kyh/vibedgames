import assert from "node:assert/strict";
import {
  CHALLENGE_SEED,
  CHALLENGE_GOAL,
  CHALLENGE_BEST_KEY,
  freshRouteProgress,
  passRouteGate,
  routeBestFromStorage,
} from "../src/shared/challenge-route";
import { BEST_KEY, topHeightFor, coinPresentFor, coinYFor } from "../src/shared/constants";

const layout = () =>
  Array.from({ length: 32 }, (_, index) => {
    const top = topHeightFor(CHALLENGE_SEED, index);
    return {
      top,
      coin: coinPresentFor(CHALLENGE_SEED, index),
      y: coinYFor(CHALLENGE_SEED, index, top),
    };
  });
const original = layout();
for (let retry = 0; retry < 3; retry++) {
  for (let titleDraw = 0; titleDraw < retry * 97; titleDraw++) Math.random();
  assert.deepEqual(layout(), original);
}
console.log("✓ Route geometry and coins survive retries and unrelated title randomness");

let progress = freshRouteProgress();
for (let index = 0; index < CHALLENGE_GOAL; index++) {
  progress = passRouteGate(progress, index);
  assert.equal(progress.gates, index + 1);
  assert.equal(passRouteGate(progress, index), progress);
  assert.equal(passRouteGate(progress, index - 1), progress);
}
assert.equal(progress.gates, CHALLENGE_GOAL);
progress = passRouteGate(progress, 10);
assert.equal(progress.gates, 11, "challenge completion does not end flight");
for (const invalid of [Number.NaN, Infinity, -1, 1.5])
  assert.equal(passRouteGate(progress, invalid), progress);
assert.deepEqual(freshRouteProgress(), { gates: 0, lastIndex: -1 });
console.log("✓ Real gate progress deduplicates, reaches ten once, then allows continued flight");

assert.notEqual(CHALLENGE_BEST_KEY, BEST_KEY);
assert.equal(routeBestFromStorage("17"), 17);
for (const raw of [null, "", "17junk", "-1", "2.5", "Infinity", "9007199254740992"]) {
  assert.equal(routeBestFromStorage(raw), 0);
}
console.log("✓ Route best is separate and rejects malformed persistence");
