import assert from "node:assert/strict";
import { test } from "node:test";
import { inMeleeArc, meleeReaches } from "../src/combat/melee.ts";
import { BRAWLERS } from "../src/config.ts";
import { parseFxBatch } from "../src/net/presentation.ts";
import { toTile } from "../src/world/grid.ts";

const origin = { x: 0, z: 0 };
const north = { x: 0, z: 1 };
const sweep = { arc: Math.PI / 2, range: 2 };

const atAngle = (distance: number, radians: number) => ({
  x: Math.sin(radians) * distance,
  z: Math.cos(radians) * distance,
});

test("a weapon sweep hits ahead, never behind or beyond the blade", () => {
  assert.ok(inMeleeArc(origin, north, sweep, { x: 0, z: 1.7 }, 0.4));
  assert.ok(!inMeleeArc(origin, north, sweep, { x: 0, z: -1.7 }, 0.4));
  assert.ok(!inMeleeArc(origin, north, sweep, { x: 1.7, z: 0 }, 0.4));
  assert.ok(!inMeleeArc(origin, north, sweep, { x: 0, z: 2.41 }, 0.4));
});

test("melee uses the target's body radius and the finite blade endpoint", () => {
  assert.ok(inMeleeArc(origin, north, sweep, { x: 0, z: 2.35 }, 0.4));
  assert.ok(inMeleeArc(origin, north, sweep, atAngle(1.8, Math.PI / 4 + 0.12), 0.4));
  // Outside both the end and side: expanding radius and angle independently is wrong here.
  assert.ok(!inMeleeArc(origin, north, sweep, atAngle(2.35, Math.PI / 4 + 0.15), 0.4));
  assert.ok(inMeleeArc({ x: 4, z: 2 }, { x: 1, z: 0 }, sweep, { x: 5.8, z: 2 }, 0.4));
});

test("cover blocks melee; the crate being struck may occupy the endpoint tile", () => {
  const target = { x: 0.5, z: 2.5 };
  const covered = {
    raycast: () => ({ dist: 1, tx: toTile(0.5), ty: toTile(1.5), x: 0.5, z: 1.5 }),
    toTile,
  };
  const targetCrate = {
    raycast: () => ({ dist: 2, tx: toTile(target.x), ty: toTile(target.z), x: target.x, z: 2 }),
    toTile,
  };
  const clear = { raycast: () => null, toTile };
  assert.equal(meleeReaches(covered, origin, target, false), false);
  assert.equal(meleeReaches(covered, origin, target, true), false);
  assert.equal(meleeReaches(targetCrate, origin, target, true), true);
  assert.equal(meleeReaches(targetCrate, origin, target, false), false);
  assert.equal(meleeReaches(clear, origin, target, false), true);
});

test("nine selectable champions include three melee and six ranged kits", () => {
  const kits = Object.values(BRAWLERS);
  assert.equal(kits.length, 9);
  assert.equal(kits.filter((kit) => kit.attack.kind === "melee").length, 3);
  assert.equal(kits.filter((kit) => kit.attack.kind !== "melee").length, 6);
  assert.equal(BRAWLERS.rowan.attack.kind, "burst");
  assert.equal(BRAWLERS.rowan.attack.style, "spear");
  assert.equal(BRAWLERS.nyx.attack.kind, "melee");
  assert.equal(BRAWLERS.moss.attack.kind, "spread");
  assert.equal(BRAWLERS.flint.attack.kind, "burst");
  assert.equal(BRAWLERS.pip.attack.kind, "lob");
  assert.equal(BRAWLERS.dusty.attack.kind, "melee");
  assert.equal(BRAWLERS.titan.attack.kind, "melee");
  assert.equal(BRAWLERS.ace.attack.kind, "burst");
  assert.equal(BRAWLERS.fuse.attack.kind, "lob");
  assert.equal(BRAWLERS.titan.super.kind, "leap");
});

test("weapon crescents survive the online FX boundary", () => {
  const row = { a: [1, 2.4, 3, 0, 2.2, 1.92, 0xc8_ef_c5, 0, 0.13], k: "fx", m: "slash" };
  assert.deepEqual(parseFxBatch([row]), [row]);
  assert.deepEqual(parseFxBatch([{ ...row, a: [1, "bad"] }]), []);
});
