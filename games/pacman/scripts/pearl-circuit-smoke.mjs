import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { MAP, FLOOR_Y, BEST_KEY } from "../src/shared/constants.ts";
import {
  CIRCUIT_CELLS,
  CIRCUIT_PATH,
  CIRCUIT_GOAL,
  CIRCUIT_BEST_KEY,
  startCircuit,
  tickCircuit,
  collectCircuitPearl,
  catchCircuit,
  circuitCollected,
  circuitPearlRemaining,
  parseCircuitBest,
  improveCircuitBest,
  formatCircuitTime,
} from "../src/shared/pearl-circuit.ts";
import { CircuitMarkers } from "../src/render/circuit-markers.ts";

const key = (cell) => `${cell.col},${cell.row}`;

test("the circuit marks 28 original pearls on a closed 44-step loop reached straight from spawn", () => {
  const targets = new Set(CIRCUIT_CELLS.map(key));
  const path = new Set(CIRCUIT_PATH.map(key));
  assert.equal(CIRCUIT_GOAL, 28);
  assert.equal(targets.size, 28);
  assert.equal(CIRCUIT_PATH.length, 44);
  assert.equal(path.size, 44);
  for (const cell of CIRCUIT_CELLS) {
    assert.equal(MAP[cell.row]?.[cell.col], 2);
    assert.ok(path.has(key(cell)));
  }
  let stepsSinceTarget = 0;
  for (let index = 0; index < CIRCUIT_PATH.length; index++) {
    const cell = CIRCUIT_PATH[index];
    const previous = CIRCUIT_PATH[(index + CIRCUIT_PATH.length - 1) % CIRCUIT_PATH.length];
    const next = CIRCUIT_PATH[(index + 1) % CIRCUIT_PATH.length];
    assert.ok([0, 2, 3].includes(MAP[cell.row]?.[cell.col]), "original walkable cell");
    assert.equal(Math.abs(cell.col - next.col) + Math.abs(cell.row - next.row), 1);
    const turns =
      cell.col - previous.col !== next.col - cell.col ||
      cell.row - previous.row !== next.row - cell.row;
    if (turns && MAP[cell.row]?.[cell.col] === 2)
      assert.ok(targets.has(key(cell)), "every pearl-bearing corner has a gold ring");
    stepsSinceTarget++;
    assert.ok(stepsSinceTarget <= 3, "at most three steps between marked pearls");
    if (targets.has(key(cell))) stepsSinceTarget = 0;
  }
  assert.deepEqual(CIRCUIT_PATH[0], { col: 9, row: 1 });
  assert.deepEqual(CIRCUIT_CELLS.at(-1), { col: 9, row: 2 });
  for (let col = 1; col <= 9; col++) assert.equal(MAP[1]?.[col], 2);
  assert.equal(8 + CIRCUIT_PATH.length - 1, 51, "native steps to collect the last target");
  assert.notEqual(CIRCUIT_BEST_KEY, BEST_KEY);
  assert.notEqual(CIRCUIT_BEST_KEY, "pacman:pearl-circuit:v1:best");
});

test("only distinct target pickups progress; last pickup freezes the actual active-time receipt", () => {
  let run = startCircuit();
  const original = structuredClone(run);
  for (const [col, row] of [
    [1, 1],
    [1, 2],
    [4, 2],
    [3.1, 1],
    [NaN, 1],
  ])
    assert.equal(collectCircuitPearl(run, col, row), run);
  run = tickCircuit(run, 1.25);
  run = catchCircuit(run);
  for (const dt of [0, -1, Infinity, NaN]) assert.equal(tickCircuit(run, dt), run);
  for (const [index, cell] of CIRCUIT_CELLS.entries()) {
    run = tickCircuit(run, 0.2);
    const before = run;
    run = collectCircuitPearl(run, cell.col, cell.row);
    assert.notEqual(run, before);
    assert.equal(circuitCollected(run), index + 1);
    assert.equal(collectCircuitPearl(run, cell.col, cell.row), run);
    assert.equal(circuitPearlRemaining(run, index), false);
  }
  assert.deepEqual(run, { kind: "complete", receipt: { elapsedMs: 6850, catches: 1 } });
  assert.equal(tickCircuit(run, 60), run);
  assert.equal(catchCircuit(run), run);
  assert.deepEqual(startCircuit(), original);
});

test("best receipt has a strict persistence boundary and deterministic comparison", () => {
  for (const value of [
    null,
    "",
    "{}",
    "[]",
    "42",
    "null",
    '{"elapsedMs":-1,"catches":0}',
    '{"elapsedMs":1.5,"catches":0}',
    '{"elapsedMs":1000,"catches":"0"}',
    '{"elapsedMs":1000,"catches":-1}',
    '{"elapsedMs":1e100,"catches":0}',
  ])
    assert.equal(parseCircuitBest(value), null, value);
  const first = { elapsedMs: 12000, catches: 2 };
  assert.deepEqual(parseCircuitBest(JSON.stringify({ ...first, score: 9999 })), first);
  assert.equal(improveCircuitBest(null, first), first);
  assert.equal(improveCircuitBest(first, { elapsedMs: 13000, catches: 0 }), first);
  assert.equal(improveCircuitBest(first, { elapsedMs: 12000, catches: 3 }), first);
  assert.deepEqual(improveCircuitBest(first, { elapsedMs: 12000, catches: 1 }), {
    elapsedMs: 12000,
    catches: 1,
  });
  assert.deepEqual(improveCircuitBest(first, { elapsedMs: 11000, catches: 3 }), {
    elapsedMs: 11000,
    catches: 3,
  });
  assert.equal(formatCircuitTime(59999), "0:59.9");
  assert.equal(formatCircuitTime(60000), "1:00.0");
  assert.equal(formatCircuitTime(365012), "6:05.0");
});

test("actual Three rings match uncollected cells and only rewrite on membership changes", () => {
  const scene = new THREE.Scene();
  const markers = new CircuitMarkers(scene);
  const mesh = scene.children[0];
  assert.ok(mesh instanceof THREE.InstancedMesh);
  assert.equal(scene.children.length, 1);
  assert.equal(markers.count, 0);
  let run = startCircuit();
  markers.sync(run);
  assert.equal(markers.count, CIRCUIT_GOAL);
  const version = mesh.instanceMatrix.version;
  markers.sync(tickCircuit(run, 10));
  assert.equal(mesh.instanceMatrix.version, version);
  for (let index = 0; index < mesh.count; index++) {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(index, matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    const cell = CIRCUIT_CELLS[index];
    assert.equal(position.x, cell.col);
    assert.equal(position.z, cell.row);
    assert.ok(Math.abs(position.y - (FLOOR_Y + 0.018)) < 1e-6);
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(matrix);
    assert.ok(normal.y > 0.999, "rings face up from the original floor");
  }
  run = collectCircuitPearl(run, 9, 1);
  markers.sync(run);
  assert.equal(markers.count, CIRCUIT_GOAL - 1);
  const first = new THREE.Matrix4();
  mesh.getMatrixAt(0, first);
  assert.equal(first.elements[12], 10, "collected ring is removed, remaining matrices compact");
  markers.sync(null);
  assert.equal(markers.count, 0);
  assert.equal(mesh.visible, false);
  markers.dispose();
});

test("rings reuse one owner through repeated rounds and dispose each unique resource once", () => {
  const scene = new THREE.Scene();
  const markers = new CircuitMarkers(scene);
  const mesh = scene.children[0];
  assert.ok(mesh instanceof THREE.InstancedMesh);
  const disposed = { mesh: 0, geometry: 0, material: 0 };
  mesh.addEventListener("dispose", () => disposed.mesh++);
  mesh.geometry.addEventListener("dispose", () => disposed.geometry++);
  assert.ok(mesh.material instanceof THREE.MeshBasicMaterial);
  mesh.material.addEventListener("dispose", () => disposed.material++);
  for (let round = 0; round < 100; round++) {
    let run = startCircuit();
    markers.sync(run);
    assert.equal(markers.count, CIRCUIT_GOAL);
    for (const cell of CIRCUIT_CELLS) run = collectCircuitPearl(run, cell.col, cell.row);
    markers.sync(run);
    assert.equal(markers.count, 0);
    assert.equal(scene.children.length, 1);
  }
  markers.dispose();
  markers.dispose();
  markers.sync(startCircuit());
  assert.equal(scene.children.length, 0);
  assert.equal(markers.count, 0);
  assert.deepEqual(disposed, { mesh: 1, geometry: 1, material: 1 });
});
