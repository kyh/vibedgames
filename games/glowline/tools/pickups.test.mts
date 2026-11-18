// Orbs, item boxes, blots, chassis and spin-outs, under Node.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BLOT_ARM,
  BOX_RESPAWN,
  CHASSIS,
  ITEM_KINDS,
  MAX_SPEED,
  ORB_LOSS,
  ORB_RESPAWN,
  SPIN_SECONDS,
} from "../src/shared/constants.ts";
import { kartSpeed, spawnKart, spinOut, stepKart } from "../src/sim/kart.ts";
import type { Kart, KartInput } from "../src/sim/kart.ts";
import { PaintGrid } from "../src/sim/paint.ts";
import { Field, rollItem } from "../src/sim/pickups.ts";
import { TRACKS, locate } from "../src/sim/track.ts";

const DT = 1 / 60;
const [track] = TRACKS;
assert.ok(track);
const FLAT_OUT: KartInput = { brake: 0, drift: false, steer: 0, throttle: 1 };

/** Top speed on a straight, re-pinning the kart so the corridor never interferes. */
const topSpeed = (make: () => Kart): number => {
  const kart = make();
  let top = 0;
  for (let i = 0; i < 700; i += 1) {
    const fresh = spawnKart(track, 0);
    Object.assign(kart, { a: fresh.a, idx: fresh.idx, s: fresh.s, x: fresh.x, z: fresh.z });
    stepKart(kart, FLAT_OUT, track, DT, 0, 1);
    top = Math.max(top, kartSpeed(kart));
  }
  return top;
};

test("every pickup sits on the road, on every circuit", () => {
  for (const circuit of TRACKS) {
    const field = new Field(circuit);
    assert.ok(field.orbs.length >= 40);
    assert.ok(field.boxes.length >= 12);
    for (const spot of [...field.orbs, ...field.boxes]) {
      const where = locate(circuit, spot.x, spot.z, -1);
      assert.ok(Math.abs(where.lat) < circuit.halfWidth, `${circuit.def.id}: pickup off the road`);
    }
  }
});

test("an orb or box is taken once, by whoever touches it, and comes back", () => {
  const field = new Field(track);
  const [orb] = field.orbs;
  const [box] = field.boxes;
  assert.ok(orb && box);
  const first = field.touch([{ key: "a", x: orb.x, z: orb.z }], 10);
  assert.equal(first.get("a")?.orbs, 1);
  // Two karts on one box in the same frame: one gets it.
  const pair = field.touch(
    [
      { key: "a", x: box.x, z: box.z },
      { key: "b", x: box.x, z: box.z },
    ],
    10,
  );
  assert.equal(pair.get("a")?.box, true);
  assert.equal(pair.get("b"), undefined);
  assert.equal(field.touch([{ key: "b", x: orb.x, z: orb.z }], 11).size, 0);
  assert.equal(
    field.touch([{ key: "b", x: orb.x, z: orb.z }], 10 + ORB_RESPAWN + 0.1).get("b")?.orbs,
    1,
  );
  assert.equal(
    field.touch([{ key: "b", x: box.x, z: box.z }], 10 + BOX_RESPAWN + 0.1).get("b")?.box,
    true,
  );
});

test("a blot spares its owner while it arms, then catches anyone, once", () => {
  const field = new Field(track);
  field.dropBlot(7, "a", 5, 5, 100);
  field.dropBlot(7, "a", 5, 5, 100);
  assert.equal(field.blots.length, 1);
  assert.equal(field.touch([{ key: "a", x: 5, z: 5 }], 100 + BLOT_ARM / 2).size, 0);
  assert.equal(field.touch([{ key: "b", x: 5, z: 5 }], 100 + BLOT_ARM / 2).get("b")?.blot, true);
  assert.equal(field.blots.length, 0);
});

/** How often each item comes up over a thousand evenly spread rolls at one place in the field. */
const tally = (share: number): Map<string, number> => {
  const counts = new Map<string, number>();
  for (let i = 0; i < 1000; i += 1) {
    const kind = rollItem(share, (i + 0.5) / 1000);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
};

test("item rolls: the back of the field gets turbos, the front gets blots", () => {
  const front = tally(0);
  const back = tally(1);
  for (const kind of ITEM_KINDS) {
    assert.ok((front.get(kind) ?? 0) > 0 && (back.get(kind) ?? 0) > 0, `${kind} never rolls`);
  }
  assert.ok((back.get("turbo") ?? 0) > (front.get("turbo") ?? 0) * 4);
  assert.ok((front.get("blot") ?? 0) > (back.get("blot") ?? 0) * 4);
});

test("chassis and orbs change top speed the way the cards say", () => {
  const dart = topSpeed(() => spawnKart(track, 0, 0));
  const anvil = topSpeed(() => spawnKart(track, 0, 1));
  const wisp = topSpeed(() => spawnKart(track, 0, 2));
  assert.ok(Math.abs(dart - MAX_SPEED) < 0.5);
  assert.ok(anvil > dart + 1 && wisp < dart - 0.8, `${wisp} < ${dart} < ${anvil}`);
  assert.equal(CHASSIS.length, 3);
  const loaded = topSpeed(() => Object.assign(spawnKart(track, 0, 0), { orbs: 10 }));
  assert.ok(loaded > dart + 3, `ten orbs: ${loaded} vs ${dart}`);
});

test("a spin-out takes the wheel away, sheds speed and orbs, then ends", () => {
  const kart = spawnKart(track, 0);
  kart.vx = Math.cos(kart.a) * 30;
  kart.vz = Math.sin(kart.a) * 30;
  kart.orbs = 5;
  const heading = kart.a;
  spinOut(kart);
  assert.equal(kart.orbs, 5 - ORB_LOSS);
  spinOut(kart);
  assert.equal(kart.orbs, 5 - ORB_LOSS, "a second hit mid-spin costs nothing more");
  for (let t = 0; t < SPIN_SECONDS - 0.05; t += DT) {
    stepKart(kart, { ...FLAT_OUT, steer: 1 }, track, DT, 0, 1);
  }
  assert.ok(Math.abs(kart.a - heading) < 0.05, "no steering while spinning");
  assert.ok(kartSpeed(kart) < 12, `still doing ${kartSpeed(kart)}`);
  for (let i = 0; i < 20; i += 1) {
    stepKart(kart, FLAT_OUT, track, DT, 0, 1);
  }
  assert.equal(kart.spin, 0);
});

test("solvent wipes rivals' paint and leaves your own", () => {
  const grid = new PaintGrid();
  grid.stamp(0, 0, 2, 1);
  grid.stamp(6, 0, 2, 2);
  grid.wipe(3, 0, 10, 1);
  assert.equal(grid.ownerAt(0, 0), 1);
  assert.equal(grid.ownerAt(6, 0), 0);
});
