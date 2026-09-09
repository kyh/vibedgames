import * as THREE from "three";

import { WORLD_H, WORLD_W } from "../src/shared/constants.ts";
import { surfaceSampler } from "../src/world/conform.ts";
import type { DrapeField } from "../src/world/conform.ts";
import { makeGroundOffset, makeTerracedDrapeField } from "../src/world/ground.ts";
import { RoadNetwork } from "../src/world/network.ts";
import { ASPHALT_LIFT, buildRoadParts } from "../src/world/roads.ts";
import type { RoadPartBuffers } from "../src/world/roads.ts";
import { makeTerrain } from "../src/world/sf-map.ts";

type Check = (name: string, passed: boolean, detail?: string) => void;

const geometry = (part: RoadPartBuffers): THREE.BufferGeometry => {
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(part.position, 3));
  if (part.index) {
    out.setIndex(new THREE.BufferAttribute(part.index, 1));
  }
  return out;
};

type Sampler = ReturnType<typeof surfaceSampler>;

const surfaceOverlaps = (asphalt: Sampler, curb: Sampler, walk: Sampler) => {
  let overlapping = 0;
  let curbSamples = 0;
  let walkSamples = 0;
  for (let x = -54.83; x < 55; x += 0.63) {
    for (let z = -54.71; z < 55; z += 0.63) {
      const onAsphalt = asphalt(x, z) !== null;
      const onCurb = curb(x, z) !== null;
      const onWalk = walk(x, z) !== null;
      if (onCurb) {
        curbSamples += 1;
      }
      if (onWalk) {
        walkSamples += 1;
      }
      if (Number(onAsphalt) + Number(onCurb) + Number(onWalk) > 1) {
        overlapping += 1;
      }
    }
  }
  return { curbSamples, overlapping, walkSamples };
};

const triangleCentroid = (p: Float32Array, index: RoadPartBuffers["index"], t: number) => {
  const a = (index?.[t] ?? t) * 3;
  const b = (index?.[t + 1] ?? t + 1) * 3;
  const c = (index?.[t + 2] ?? t + 2) * 3;
  return {
    x: ((p[a] ?? 0) + (p[b] ?? 0) + (p[c] ?? 0)) / 3,
    y: ((p[a + 1] ?? 0) + (p[b + 1] ?? 0) + (p[c + 1] ?? 0)) / 3,
    z: ((p[a + 2] ?? 0) + (p[b + 2] ?? 0) + (p[c + 2] ?? 0)) / 3,
  };
};

const paintClearance = (parts: readonly RoadPartBuffers[], asphalt: Sampler) => {
  let buried = 0;
  let paintSamples = 0;
  let minClearance = Infinity;
  for (const part of parts) {
    if (["asphalt", "curb", "walk", "kerbred", "kerbyellow", "kerbgreen"].includes(part.matKey)) {
      continue;
    }
    const p = part.position;
    const { index } = part;
    const count = index ? index.length : p.length / 3;
    for (let t = 0; t < count; t += 3) {
      const { x, y, z } = triangleCentroid(p, index, t);
      const floor = asphalt(x, z);
      if (floor === null) {
        continue;
      }
      const clearance = y - floor;
      paintSamples += 1;
      minClearance = Math.min(minClearance, clearance);
      if (clearance < 0) {
        buried += 1;
      }
    }
  }
  return { buried, minClearance, paintSamples };
};

const lanePenetrations = (network: RoadNetwork) => {
  const terrain = makeTerrain();
  const ground = makeGroundOffset(network, terrain);
  const drape = makeTerracedDrapeField(network, terrain);
  let penetrations = 0;
  let samples = 0;
  let worst = 0;
  for (const edge of network.edges) {
    for (let s = 1; s < edge.len; s += 3) {
      const p = network.sample(edge, s);
      for (const lateral of [-0.75, 0, 0.75]) {
        const x = p.x - p.tz * edge.half * lateral;
        const z = p.z + p.tx * edge.half * lateral;
        // Outer network extensions have no drawn ground beneath them.
        if (Math.abs(x) >= WORLD_W * 0.54 || Math.abs(z) >= WORLD_H * 0.54) {
          continue;
        }
        const delta = terrain.renderedHeightAt(x, z, ground) - drape.heightAt(x, z) - ASPHALT_LIFT;
        samples += 1;
        worst = Math.max(worst, delta);
        if (delta > 0.001) {
          penetrations += 1;
        }
      }
    }
  }
  return { penetrations, samples, worst };
};

const crossingFixture = () => {
  const crossing = new RoadNetwork(
    [
      [0, 0],
      [-55, 0],
      [55, 0],
      [0, -55],
      [0, 55],
    ],
    [
      { a: 0, b: 1, p: [0, 0, -55, 0], w: 6 },
      { a: 0, b: 2, p: [0, 0, 55, 0], w: 6 },
      { a: 0, b: 3, p: [0, 0, 0, -55], w: 6 },
      { a: 0, b: 4, p: [0, 0, 0, 55], w: 6 },
    ],
  );
  const field: DrapeField = {
    heightAt: (x, z) => Math.sin(x * 0.18) * 0.7 + Math.sin(z * 0.13) * 0.45,
    normalInto: (out, x, z) =>
      out.set(-Math.cos(x * 0.18) * 0.126, 1, -Math.cos(z * 0.13) * 0.0585).normalize(),
  };
  return { crossing, field };
};

export const checkRoadSurfaces = (check: Check, network: RoadNetwork): void => {
  // A curved four-way crossing reproduces the independently draped curb /
  // sidewalk shells. The invariant is geometric exclusivity, independent of
  // material sort order, depth precision, camera angle or the final bake.
  const { crossing, field } = crossingFixture();
  const parts = buildRoadParts(crossing, field);
  const asphaltPart = parts.find((p) => p.matKey === "asphalt");
  const curbPart = parts.find((p) => p.matKey === "curb");
  const walkPart = parts.find((p) => p.matKey === "walk");
  if (!asphaltPart || !curbPart || !walkPart) {
    check("crossing produces its three street surfaces", false);
    return;
  }
  const asphalt = surfaceSampler(geometry(asphaltPart));
  const curb = surfaceSampler(geometry(curbPart));
  const walk = surfaceSampler(geometry(walkPart));
  const { overlapping, curbSamples, walkSamples } = surfaceOverlaps(asphalt, curb, walk);
  check(
    "asphalt, kerb and sidewalk occupy disjoint footprints",
    overlapping === 0,
    `${overlapping} overlapping probes; ${curbSamples} kerb, ${walkSamples} walk`,
  );

  // Sample interiors, not only vertices: vertex-only seating left the middle
  // of a marking below the wide road triangle on SF's hill crests.
  const { buried, paintSamples, minClearance } = paintClearance(parts, asphalt);
  check(
    "paint triangle interiors remain above the draped road",
    buried === 0 && paintSamples > 0,
    `${buried}/${paintSamples} buried, minimum clearance ${minClearance.toFixed(4)}u`,
  );

  const { penetrations, samples, worst } = lanePenetrations(network);
  check(
    "rendered terrain stays beneath SF's travel lanes",
    penetrations === 0,
    `${penetrations}/${samples} penetrations, worst ${worst.toFixed(4)}u`,
  );
};
