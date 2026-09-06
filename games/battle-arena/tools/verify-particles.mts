import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { ParticlePools } from "../src/render/fx-particles.ts";
import type { ParticleKind, ParticlePriority } from "../src/render/fx-particles.ts";

function meshFor(scene: THREE.Scene, kind: ParticleKind): THREE.InstancedMesh {
  const mesh = scene.children.find(
    (child): child is THREE.InstancedMesh =>
      child instanceof THREE.InstancedMesh && child.renderOrder === (kind === "add" ? 11 : 10),
  );
  if (!mesh) throw new Error("particle mesh missing");
  return mesh;
}

function visiblePositions(mesh: THREE.InstancedMesh): number[] {
  const matrix = new THREE.Matrix4();
  const xs: number[] = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    if (matrix.determinant() > 0) xs.push(matrix.elements[12] ?? 0);
  }
  return xs;
}

const budgets: { kind: ParticleKind; cap: number; reserve: number }[] = [
  { kind: "add", cap: 512, reserve: 96 },
  { kind: "normal", cap: 160, reserve: 32 },
];

for (const { kind, cap, reserve } of budgets) {
  test(`${kind}: reserve, replace in place, expire and refill without duplicate slots`, () => {
    const scene = new THREE.Scene();
    const pools = new ParticlePools(scene);
    const spawn = (n: number, priority: ParticlePriority, x: number) => {
      for (let i = 0; i < n; i++) pools.spawn(kind, { x, y: 1, z: 0, size: 1, life: 1, priority });
    };
    spawn(cap * 2, "ambient", 1);
    assert.equal(pools.counts()[kind].active, cap - reserve);
    spawn(reserve, "impact", 2);
    assert.equal(pools.counts()[kind].active, cap);
    spawn(23, "major", 3);
    assert.deepEqual(pools.counts()[kind], {
      active: cap,
      capacity: cap,
      ambient: cap - reserve - 23,
      impact: reserve,
      major: 23,
    });
    const mesh = meshFor(scene, kind);
    assert.equal(visiblePositions(mesh).filter((x) => x === 3).length, 23);
    // Same/lower priority cannot erase those important contacts.
    spawn(cap, "ambient", 4);
    assert.equal(pools.counts()[kind].major, 23);
    // Repeated saturation cycles catch double release / packed-list corruption.
    for (let cycle = 0; cycle < 4; cycle++) {
      pools.update(2);
      assert.equal(pools.counts()[kind].active, 0);
      assert.equal(visiblePositions(mesh).length, 0);
      for (let i = 0; i < cap; i++)
        pools.spawn(kind, { x: i + 100, y: 0, z: 0, life: 1, size: 1, priority: "impact" });
      assert.equal(pools.counts()[kind].active, cap);
      assert.equal(new Set(visiblePositions(mesh)).size, cap);
      spawn(31, "major", -1);
      assert.equal(pools.counts()[kind].active, cap);
      assert.equal(visiblePositions(mesh).filter((x) => x === -1).length, 31);
    }
    pools.dispose();
    assert.equal(scene.children.length, 0);
  });
}

test("equal priority saturation preserves active major particles", () => {
  const scene = new THREE.Scene();
  const pools = new ParticlePools(scene);
  for (let i = 0; i < 512; i++)
    pools.spawn("add", { x: i, y: 0, z: 0, size: 1, life: 2, priority: "major" });
  pools.spawn("add", { x: 9999, y: 0, z: 0, size: 1, life: 2, priority: "major" });
  assert.equal(pools.counts().add.major, 512);
  assert.equal(visiblePositions(meshFor(scene, "add")).includes(9999), false);
  pools.dispose();
});

test("burst scratch resets priority between major, ambient and default impacts", () => {
  const pools = new ParticlePools(new THREE.Scene());
  const burst = { x: 0, y: 0, z: 0, color: 0xffffff, speed: 1, life: 1 };
  pools.burst("add", 3, { ...burst, priority: "major" });
  pools.burst("add", 4, { ...burst, priority: "ambient" });
  pools.burst("add", 5, burst);
  assert.deepEqual(pools.counts().add, {
    active: 12,
    capacity: 512,
    ambient: 4,
    impact: 5,
    major: 3,
  });
  pools.dispose();
});
