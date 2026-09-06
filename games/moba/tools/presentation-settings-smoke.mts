import assert from "node:assert/strict";
import {
  parsePresentationSettings,
  presentationSettings,
  setPresentationSettings,
  watchPresentationSettings,
} from "../src/render/presentation-settings";

const defaults = { effects: "full", motion: "system", view: "standard" };
for (const raw of [null, "bad json", "null", "true", "12", "[]", '"focused"', "{}"])
  assert.deepEqual(parsePresentationSettings(raw), defaults, `unsafe stored value: ${raw}`);
assert.deepEqual(
  parsePresentationSettings('{"effects":"focused","motion":"reduced","view":"close"}'),
  { effects: "focused", motion: "reduced", view: "close" },
);
assert.deepEqual(
  parsePresentationSettings(
    '{"effects":"focused","motion":true,"view":"future-version","extra":1}',
  ),
  { effects: "focused", motion: "system", view: "standard" },
  "invalid fields fall back independently",
);
let changes = 0;
const unwatch = watchPresentationSettings(() => changes++);
// No window/storage in this Node process: memory and subscriptions still work.
setPresentationSettings({ effects: "focused", motion: "system", view: "close" });
assert.equal(presentationSettings().effects, "focused");
assert.equal(changes, 1);
unwatch();
unwatch();
setPresentationSettings({ effects: "full", motion: "reduced", view: "standard" });
assert.equal(changes, 1, "a destroyed scene must not receive setting changes");
console.log(
  "✓ presentation settings: strict storage boundary, denied storage, subscription cleanup",
);
