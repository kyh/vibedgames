import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptReturn,
  armCharge,
  cancelCharge,
  chargeHits,
  contactShot,
  freshPowerAction,
  readCharge,
  readPowerAction,
  POWER_SPEED_MAX,
} from "../src/shared/contact-shot.ts";
import type { ShotCharge } from "../src/shared/contact-shot.ts";

test("four returns fill charge; only an armed accepted return spends it", () => {
  let charge: ShotCharge = { kind: "charging", hits: 0 };
  for (let hits = 1; hits <= 4; hits++) {
    assert.deepEqual(armCharge(charge), charge);
    const result = acceptReturn(charge);
    assert.equal(result.powered, false);
    charge = result.charge;
    assert.equal(chargeHits(charge), hits);
  }
  assert.equal(charge.kind, "ready");
  assert.deepEqual(acceptReturn(charge), { charge, powered: false });
  const armed = armCharge(charge);
  assert.equal(armed.kind, "armed");
  assert.deepEqual(armCharge(armed), armed);
  assert.deepEqual(cancelCharge(armed), charge);
  assert.deepEqual(acceptReturn(armed), { charge: { kind: "charging", hits: 0 }, powered: true });
});

test("screen-left slice and screen-right topspin mirror both canonical seats", () => {
  for (const side of [1, -1] satisfies (1 | -1)[]) {
    assert.deepEqual(contactShot(-0.8 * side, side, 10, false), {
      kind: "slice",
      spin: -side * 0.8,
      lift: 1,
      speed: 10,
    });
    assert.deepEqual(contactShot(0, side, 10, false), {
      kind: "flat",
      spin: 0,
      lift: 1,
      speed: 10,
    });
    assert.deepEqual(contactShot(0.8 * side, side, 10, false), {
      kind: "topspin",
      spin: 0,
      lift: 0.55,
      speed: 11,
    });
    assert.equal(contactShot(side / 3, side, 10, false).kind, "flat");
    assert.equal(contactShot(-side / 3, side, 10, false).kind, "flat");
  }
});

test("power uses one multiplier, does not stack topspin, and never exceeds its cap", () => {
  for (const offset of [-1, 0, 1]) {
    assert.equal(contactShot(offset, 1, 10, true).speed, 14);
    assert.equal(contactShot(offset, 1, 13, true).speed, POWER_SPEED_MAX);
    assert.ok(contactShot(offset, 1, 13, false).speed <= POWER_SPEED_MAX);
  }
});

test("charge snapshots and power commands reject invalid and oversized states", () => {
  for (const hits of [-1, 0.5, 5, Infinity, NaN, "4", null])
    assert.equal(readCharge(hits, false), null);
  assert.equal(readCharge(2, true), null);
  assert.deepEqual(readCharge(4, true), { kind: "armed" });
  for (const value of [
    null,
    {},
    { seq: 0, rally: 1, seen: 1, armed: true },
    { seq: 2 ** 40, rally: 1, seen: 1, armed: true },
    { seq: 1, rally: -1, seen: 1, armed: true },
    { seq: 1, rally: 1, seen: Infinity, armed: true },
    { seq: 1, rally: 1, seen: 1, armed: 1 },
  ])
    assert.equal(readPowerAction(value), null);
  const action = readPowerAction({ seq: 4, rally: 8, seen: 70, armed: true });
  assert.ok(action);
  assert.equal(freshPowerAction(action, 3, 8, 100, 60), true);
  assert.equal(freshPowerAction(action, 4, 8, 100, 60), false, "replay");
  assert.equal(freshPowerAction(action, 3, 9, 100, 60), false, "old rally");
  assert.equal(freshPowerAction(action, 3, 8, 131, 60), false, "old snapshot");
  assert.equal(freshPowerAction(action, 3, 8, 69, 60), false, "future snapshot");
  assert.equal(freshPowerAction({ ...action, seq: 1000 }, 3, 8, 100, 60), false, "sequence jump");
});
