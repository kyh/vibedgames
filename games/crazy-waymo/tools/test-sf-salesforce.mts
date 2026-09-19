import * as THREE from "three";

import {
  createSalesforceModel,
  getSalesforceKit,
  SALESFORCE_HEIGHT,
  SALESFORCE_RADIUS,
  setSalesforceNight,
} from "../src/world/sf-salesforce.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;

const kitStats = (kit: ReturnType<typeof getSalesforceKit>) => {
  let bytes = 0;
  let radius = 0;
  let triangles = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  let degenerate = 0;
  let finite = true;
  for (const part of kit) {
    const positions = part.geo.getAttribute("position");
    const normals = part.geo.getAttribute("normal");
    const index = part.geo.getIndex();
    triangles += (index?.count ?? positions.count) / 3;
    bytes +=
      positions.array.byteLength +
      normals.array.byteLength +
      part.geo.getAttribute("color").array.byteLength +
      (index?.array.byteLength ?? 0);
    for (let i = 0; i < positions.count; i += 1) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);
      radius = Math.max(radius, Math.hypot(x, z));
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      finite &&= [x, y, z, normals.getX(i), normals.getY(i), normals.getZ(i)].every(
        Number.isFinite,
      );
    }
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
      a.fromBufferAttribute(positions, index?.getX(i) ?? i);
      b.fromBufferAttribute(positions, index?.getX(i + 1) ?? i + 1).sub(a);
      c.fromBufferAttribute(positions, index?.getX(i + 2) ?? i + 2).sub(a);
      if (b.cross(c).lengthSq() <= 1e-14) {
        degenerate += 1;
      }
    }
  }
  return { bytes, degenerate, finite, maxY, minY, radius, triangles };
};

export const checkSalesforce = (check: Check): void => {
  const kit = getSalesforceKit();
  const repeated = getSalesforceKit();
  const { bytes, radius, triangles, minY, maxY, degenerate, finite } = kitStats(kit);
  check(
    "Salesforce preserves its circular placement and original height",
    finite && radius <= SALESFORCE_RADIUS && minY >= -1e-6 && maxY <= SALESFORCE_HEIGHT,
    `radius ${radius.toFixed(4)}, y ${minY.toFixed(4)}..${maxY.toFixed(4)}`,
  );
  check(
    "Salesforce keeps a bounded six-material shared kit",
    kit.length === 6 &&
      new Set(kit.map((p) => p.mat)).size === 6 &&
      kit.every((p, i) => p.geo === repeated[i]?.geo && p.mat === repeated[i]?.mat) &&
      triangles < 15_000,
    `${triangles} triangles, ${(bytes / 1_048_576).toFixed(3)} MiB`,
  );
  check("Salesforce has no collapsed triangles", degenerate === 0, `${degenerate} degenerate`);
  const a = createSalesforceModel();
  const b = createSalesforceModel();
  check(
    "Salesforce placements share buffers but own scene nodes",
    a !== b &&
      a.children.length === 6 &&
      a.children.every(
        (node, i) =>
          node !== b.children[i] && node instanceof THREE.Mesh && node.geometry === kit[i]?.geo,
      ),
  );
  check(
    "Salesforce translucent crown does not cast an opaque shadow",
    a.children.every(
      (node) =>
        !(node instanceof THREE.Mesh) ||
        Array.isArray(node.material) ||
        !node.material.transparent ||
        !node.castShadow,
    ),
  );
  const emitting = kit.filter((p) => p.mat.emissive.getHex() !== 0);
  const albedo = kit.map((p) => p.mat.color.getHex());
  setSalesforceNight(2);
  const bright = emitting.map((p) => p.mat.emissiveIntensity);
  setSalesforceNight(-1);
  const daylight = emitting.every((p) => p.mat.emissiveIntensity === 0);
  setSalesforceNight(Number.NaN);
  check(
    "Salesforce night emission is bounded and independent of albedo",
    bright.length === 2 &&
      bright.every((v) => v <= 0.75) &&
      daylight &&
      emitting.every((p) => p.mat.emissiveIntensity === 0) &&
      kit.every((p, i) => p.mat.color.getHex() === albedo[i]),
  );
};
