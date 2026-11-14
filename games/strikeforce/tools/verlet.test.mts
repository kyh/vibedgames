// The points a ragdoll is made of: they fall, hold their lengths, stay out of
// the level and come to rest.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Vector3 } from "three";

import { Verlet } from "../src/soldier/verlet.ts";
import type { Terrain } from "../src/soldier/verlet.ts";

const DT = 1 / 60;
const WALL = 2;

/** A flat floor at 0 and a wall across +X at `WALL`. */
const yard: Terrain = {
  groundHeight: () => 0,
  raycast: (from, dir, max) => {
    const dist = dir.x > 0 ? (WALL - from.x) / dir.x : Infinity;
    return dist >= 0 && dist <= max ? { dist } : null;
  },
};

const still = new Vector3();

test("a dropped chain lands on the floor, keeps its lengths and comes to rest", () => {
  const points = new Verlet(yard);
  const chain = [0, 1, 2, 3].map((i) => points.add(new Vector3(i * 0.3, 1.5 + i * 0.2, 0), 0.05));
  const lengths: number[] = [];
  for (const [i, point] of chain.entries()) {
    const next = chain[i + 1];
    if (next) {
      points.rod(point, next);
      lengths.push(point.at.distanceTo(next.at));
    }
  }
  for (let t = 0; t < 6 && !points.resting; t += DT) {
    points.advance(DT);
    for (const point of chain) {
      assert.ok(point.at.y >= 0.05 - 1e-9, `through the floor at ${t.toFixed(2)} s`);
    }
  }
  assert.ok(points.resting, "still moving after 6 s");
  for (const [i, length] of lengths.entries()) {
    const [a, b] = [chain[i], chain[i + 1]];
    assert.ok(a && b && Math.abs(a.at.distanceTo(b.at) - length) < 0.01, `rod ${i} changed length`);
  }
  for (const point of chain) {
    assert.ok(point.at.y < 0.06, "not lying on the floor");
  }
});

test("a point thrown at a wall stops at it", () => {
  const points = new Verlet(yard);
  const point = points.add(new Vector3(0, 1, 0), 0.1);
  points.place(point, point.at.clone(), new Vector3(30, 0, 0));
  for (let t = 0; t < 1; t += DT) {
    points.advance(DT);
    assert.ok(point.at.x < WALL, `through the wall at ${t.toFixed(2)} s`);
  }
  assert.ok(point.at.x > WALL - 0.11, "stopped well short of the wall");
});

test("limits hold a pair no closer and no further than they allow", () => {
  const points = new Verlet(yard);
  const a = points.add(new Vector3(0, 0.05, 0), 0.05);
  const b = points.add(new Vector3(0.5, 0.05, 0), 0.05);
  points.rod(a, b, 0.8, 1.2);
  points.place(b, b.at.clone(), new Vector3(-6, 0, 0));
  let least = Infinity;
  for (let t = 0; t < 1; t += DT) {
    points.advance(DT);
    least = Math.min(least, a.at.distanceTo(b.at));
  }
  assert.ok(least >= 0.4 - 1e-6, `closed to ${least}`);
  points.place(b, b.at.clone(), new Vector3(8, 0, 0));
  points.place(a, a.at.clone(), still);
  let most = 0;
  for (let t = 0; t < 1; t += DT) {
    points.advance(DT);
    most = Math.max(most, a.at.distanceTo(b.at));
  }
  assert.ok(most <= 0.6 + 1e-6, `opened to ${most}`);
});
