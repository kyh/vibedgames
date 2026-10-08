import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DIRECTIONS,
  directionVector,
  InputGate,
  lookAngle,
  parseInputState,
  quantizeDirection,
  quantizeLook,
  STILL,
} from "../src/net/input-intent.ts";
import { parseIntent } from "../src/net/intents.ts";

test("keyboard directions survive quantization exactly; a thumb stick snaps to 32 headings", () => {
  const diagonal = Math.SQRT1_2;
  for (const [x, z] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [diagonal, diagonal],
    [-diagonal, diagonal],
  ]) {
    const move = directionVector(quantizeDirection(x ?? 0, z ?? 0));
    assert.ok(Math.abs(move.x - (x ?? 0)) < 1e-12 && Math.abs(move.z - (z ?? 0)) < 1e-12);
  }
  assert.equal(quantizeDirection(0, 0), STILL);
  assert.deepEqual(directionVector(STILL), { x: 0, z: 0 });
  const seen = new Set<number>();
  for (let i = 0; i < 720; i += 1) {
    const angle = (i / 720) * Math.PI * 2;
    const dir = quantizeDirection(Math.sin(angle), Math.cos(angle));
    seen.add(dir);
    const move = directionVector(dir);
    // Never more than half a heading off what the stick says.
    const off = Math.acos(Math.min(1, move.x * Math.sin(angle) + move.z * Math.cos(angle)));
    assert.ok(off <= Math.PI / DIRECTIONS + 1e-9, `${off} at ${angle}`);
  }
  assert.equal(seen.size, DIRECTIONS);
});

test("wire input is bounded: unknown headings stand still and passive facing accepts only whole hundredths", () => {
  assert.deepEqual(parseInputState({ dir: 5, look: 70 }), { dir: 5, look: 70 });
  for (const dir of [-2, 32, 4.5, "north", null, Number.NaN]) {
    assert.equal(parseInputState({ dir, look: null }).dir, STILL);
  }
  for (const look of [null, "north", 0.5, Number.POSITIVE_INFINITY]) {
    assert.equal(parseInputState({ dir: 0, look }).look, null);
  }
  // A full turn past the boundary wraps back onto it.
  assert.equal(parseInputState({ dir: 0, look: 700 }).look, quantizeLook(7));
  assert.ok(Math.abs((lookAngle(quantizeLook(2.5)) ?? 0) - 2.5) < 0.005);
  assert.equal(lookAngle(null), null);
});

test("intents need a sequence number; joins do not", () => {
  assert.deepEqual(parseIntent({ dir: 3, kind: "input", look: null, seq: 9 }), {
    dir: 3,
    kind: "input",
    look: null,
    seq: 9,
  });
  for (const seq of [0, -1, 1.5, "1", null]) {
    assert.equal(parseIntent({ dir: 3, kind: "input", look: null, seq }), null);
  }
  assert.deepEqual(parseIntent({ dx: 4, dz: -4, kind: "evade", seq: 2 }), {
    dx: 1,
    dz: -1,
    kind: "evade",
    seq: 2,
  });
  assert.equal(parseIntent({ dx: "left", dz: 0, kind: "evade", seq: 2 }), null);
  assert.deepEqual(parseIntent({ kind: "join", kit: "ace", name: "a very long name indeed" }), {
    kind: "join",
    kit: "ace",
    name: "a very long ",
  });
  assert.equal(parseIntent({ kind: "join", kit: "constructor", name: "x" }), null);
  assert.equal(parseIntent({ kind: "again", seq: 1 }), null);
});

test("input leaves at most 30 times a second, at once after a quiet spell, and refreshes while held", () => {
  const gate = new InputGate();
  const still = { dir: STILL, look: null };
  const east = { dir: 8, look: null };
  // A fresh gate always sends, so a new host or a new body learns the input at once.
  assert.equal(gate.due(still, 0), true);
  gate.mark(still, 0);
  assert.equal(gate.due(still, 10_000), false, "idle stays quiet");
  assert.equal(gate.due(east, 10_000), true, "a change after a quiet spell goes at once");
  gate.mark(east, 10_000);
  assert.equal(gate.due({ dir: 9, look: null }, 10_020), false, "inside the 33 ms gap");
  assert.equal(gate.due({ dir: 9, look: null }, 10_034), true);
  assert.equal(gate.due(east, 10_400), false);
  assert.equal(gate.due(east, 10_500), true, "held input refreshes every half second");
  gate.mark(east, 10_500);
  gate.force();
  assert.equal(gate.due(east, 10_501), true, "forced resend ignores the gap");
});
