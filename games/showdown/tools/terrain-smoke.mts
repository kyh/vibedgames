import assert from "node:assert/strict";
import { test } from "node:test";
import { RingGeometry } from "three";
import { buildGroundGeometry } from "../src/world/ground.ts";
import { TILE_COUNT } from "../src/world/grid.ts";
import { conformGroundGeometry, terrainAimDistance, terrainHeight } from "../src/world/terrain.ts";

test("rendered floor rises to both highlands without gaps at ramp boundaries", () => {
  const geometry = buildGroundGeometry(new Uint8Array(TILE_COUNT));
  const position = geometry.getAttribute("position");
  let highlandVertices = 0;
  for (let i = 0; i < position.count; i += 1) {
    const height = terrainHeight(position.getX(i), position.getZ(i));
    assert.ok(Math.abs(position.getY(i) - height) < 1e-6);
    if (height > 2) {
      highlandVertices += 1;
    }
  }
  assert.ok(highlandVertices > 0);
  assert.ok(terrainHeight(0, 0) < terrainHeight(0, 10));
  assert.ok(terrainHeight(0, 10) < terrainHeight(0, 20));
  geometry.dispose();
});

test("cursor rays find the intended target across both slopes and terraces", () => {
  for (const z of [-18, -15.5, -10, -6.5, 0, 6.5, 10, 15.5, 18]) {
    const target = { x: 2, y: terrainHeight(2, z) + 0.5, z };
    const origin = { x: -2, y: target.y + 18, z: z + 15 };
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const dz = target.z - origin.z;
    const length = Math.hypot(dx, dy, dz);
    const direction = { x: dx / length, y: dy / length, z: dz / length };
    const distance = terrainAimDistance(origin, direction);
    assert.ok(distance !== null);
    assert.ok(Math.abs(distance - length) < 1e-4);
  }
  assert.equal(terrainAimDistance({ x: 0, y: 10, z: 0 }, { x: 0, y: 1, z: 0 }), null);
});

test("expanding shockwaves sit on the ground while crossing ramp creases", () => {
  const geometry = new RingGeometry(0.82, 1, 64).rotateX(-Math.PI / 2);
  for (const scale of [0.2, 1, 3]) {
    conformGroundGeometry(geometry, 0, 5, scale);
    const position = geometry.getAttribute("position");
    for (let i = 0; i < position.count; i += 1) {
      const expected = terrainHeight(position.getX(i) * scale, 5 + position.getZ(i) * scale);
      assert.ok(Math.abs(position.getY(i) - expected) < 1e-6);
    }
  }
  geometry.dispose();
});
