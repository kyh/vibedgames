import assert from "node:assert/strict";
import { test } from "node:test";
import { BRAWLER_RADIUS } from "../src/config.ts";
import {
  advanceEvasion,
  createEvasion,
  EVADE,
  evasionInvulnerable,
} from "../src/entities/evasion.ts";
import { pushOutOfTile } from "../src/world/collision.ts";
import type { Position } from "../src/world/collision.ts";
import { GRID_HALF } from "../src/world/grid.ts";
import { terrainHeight } from "../src/world/terrain.ts";

const open = { heightAt: terrainHeight, resolveCircle: () => null };

test("an evade travels the same distance and duration across frame rates and direction lengths", () => {
  for (const dt of [1 / 240, 1 / 60, 1 / 20, 1]) {
    const state = createEvasion(30, 40, 0);
    const position = { x: 0, y: terrainHeight(0, 6), z: 6 };
    let complete = false;
    for (let time = 0; time < EVADE.duration + dt && !complete; time += dt) {
      complete = advanceEvasion(state, position, open, dt);
    }
    assert.equal(complete, true);
    assert.equal(state.elapsed, EVADE.duration);
    assert.ok(Math.abs(position.x - 1.8) < 1e-10);
    assert.ok(Math.abs(position.z - 8.4) < 1e-10);
    assert.equal(position.y, terrainHeight(position.x, position.z));
    const end = { ...position };
    advanceEvasion(state, position, open, 1);
    assert.deepEqual(position, end);
  }
});

test("the initial invulnerability ends before the evade's recovery completes", () => {
  const state = createEvasion(0, 0, Math.PI / 2);
  assert.equal(state.angle, Math.PI / 2);
  assert.ok(Math.abs(createEvasion(0, 0, Math.PI * 4.5).angle - Math.PI / 2) < 1e-10);
  assert.equal(evasionInvulnerable(state), true);
  state.elapsed = EVADE.invulnerable - 1e-6;
  assert.equal(evasionInvulnerable(state), true);
  state.elapsed = EVADE.invulnerable;
  assert.equal(evasionInvulnerable(state), false);
  assert.ok(state.elapsed < EVADE.duration);
  assert.equal(evasionInvulnerable(null), false);
});

test("evade substeps stop at a one-tile obstacle even when a whole evade fits in one frame", () => {
  const world = {
    heightAt: terrainHeight,
    resolveCircle: (position: Position, radius: number) => {
      pushOutOfTile(position, radius, GRID_HALF + 1, GRID_HALF);
    },
  };
  for (const dt of [1 / 60, 1]) {
    const state = createEvasion(1, 0, 0);
    const position = { x: 0.5, y: 0, z: 0.5 };
    for (let time = 0; time < EVADE.duration + dt; time += dt) {
      advanceEvasion(state, position, world, dt);
    }
    assert.ok(Math.abs(position.x - (1 - BRAWLER_RADIUS)) < 1e-10);
    assert.equal(position.z, 0.5);
  }
});

test("diagonal evades slide along cover without crossing the blocked face", () => {
  const world = {
    heightAt: terrainHeight,
    resolveCircle: (position: Position, radius: number) => {
      for (let z = -5; z < 5; z += 1) {
        pushOutOfTile(position, radius, GRID_HALF + 1, GRID_HALF + z);
      }
    },
  };
  const state = createEvasion(1, 1, 0);
  const position = { x: 0.5, y: 0, z: 0.5 };
  advanceEvasion(state, position, world, 1);
  assert.ok(position.x <= 1 - BRAWLER_RADIUS + 1e-10);
  assert.ok(position.z > 2.4);
});
