import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptReturn,
  armCharge,
  cancelCharge,
  chargeHits,
  contactShot,
  readCharge,
  POWER_SPEED_MAX,
} from "../src/shared/contact-shot.ts";
import type { ShotCharge } from "../src/shared/contact-shot.ts";

test("four returns fill charge; only an armed accepted return spends it", () => {
  let charge: ShotCharge = { hits: 0, kind: "charging" };
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
  assert.deepEqual(acceptReturn(armed), { charge: { hits: 0, kind: "charging" }, powered: true });
});

test("screen-left slice and screen-right topspin mirror both canonical seats", () => {
  for (const side of [1, -1] satisfies (1 | -1)[]) {
    assert.deepEqual(contactShot(-0.8 * side, side, 10, false), {
      kind: "slice",
      lift: 1,
      speed: 10,
      spin: -side * 0.8,
    });
    assert.deepEqual(contactShot(0, side, 10, false), {
      kind: "flat",
      lift: 1,
      speed: 10,
      spin: 0,
    });
    assert.deepEqual(contactShot(0.8 * side, side, 10, false), {
      kind: "topspin",
      lift: 0.55,
      speed: 11,
      spin: 0,
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

test("charge snapshots reject invalid and oversized states", () => {
  for (const hits of [-1, 0.5, 5, Infinity, Number.NaN, "4", null]) {
    assert.equal(readCharge(hits, false), null);
  }
  assert.equal(readCharge(2, true), null);
  assert.deepEqual(readCharge(2, false), { hits: 2, kind: "charging" });
  assert.deepEqual(readCharge(4, false), { kind: "ready" });
  assert.deepEqual(readCharge(4, true), { kind: "armed" });
});
