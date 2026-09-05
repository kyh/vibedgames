import * as THREE from "three";

import { getScaffoldKit, scaffoldYaw } from "../src/world/furniture.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;

export function checkScaffoldKit(check: Check): void {
  const kit = getScaffoldKit();
  const bounds = new THREE.Box3();
  let triangles = 0;
  for (const part of kit) {
    part.geo.computeBoundingBox();
    if (part.geo.boundingBox) bounds.union(part.geo.boundingBox);
    triangles += (part.geo.index?.count ?? part.geo.getAttribute("position").count) / 3;
  }
  check(
    "scaffold preserves its original placement and batching envelope",
    kit === getScaffoldKit() &&
      kit.length === 3 &&
      triangles < 1_000 &&
      Math.abs(bounds.min.y) < 1e-5 &&
      Math.abs(bounds.max.y - 6.2) < 1e-5 &&
      bounds.min.x >= -4.556 &&
      bounds.max.x <= 4.556 &&
      bounds.min.z >= -0.906 &&
      bounds.max.z <= 0.916,
    `${triangles} triangles, ${kit.length} shared materials`,
  );

  // Placement checks the two ends ALONG the road. Test every rendered vertex
  // against the actual road strip: a local-Z yaw instead of local-X puts a
  // scaffold leg into asphalt despite those endpoint checks passing.
  let clear = true;
  let worst = Infinity;
  const roadHalf = 5;
  const centerOffset = roadHalf + 1.25 + 1.5;
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  for (const angle of [0, 0.47, Math.PI / 4, Math.PI / 2, 2.13, Math.PI, 4.81]) {
    const tx = Math.cos(angle);
    const tz = Math.sin(angle);
    const nx = -tz;
    const nz = tx;
    for (const side of [-1, 1]) {
      matrix.makeRotationY(scaffoldYaw(tx, tz));
      matrix.setPosition(nx * centerOffset * side, 0, nz * centerOffset * side);
      for (const part of kit) {
        const positions = part.geo.getAttribute("position");
        for (let i = 0; i < positions.count; i++) {
          point.fromBufferAttribute(positions, i).applyMatrix4(matrix);
          const lateral = (point.x * nx + point.z * nz) * side - roadHalf;
          const along = Math.abs(point.x * tx + point.z * tz);
          worst = Math.min(worst, lateral);
          clear &&= lateral >= 0.4 && along <= 4.6;
        }
      }
    }
  }
  check(
    "scaffold rendered footprint matches kerb clearance on both sides of diagonal streets",
    clear,
    `nearest vertex ${worst.toFixed(3)}u off asphalt`,
  );

  const meshes = kit.map((part) => new THREE.Mesh(part.geo, part.mat));
  const ray = new THREE.Raycaster();
  const forward = new THREE.Vector3(0, 0, -1);
  let blocked = 0;
  const samples = 16 * 8;
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 8; y++) {
      ray.set(point.set(-4.35 + (x + 0.5) * (8.7 / 16), 2.85 + (y + 0.5) * (3.1 / 8), 2), forward);
      if (ray.intersectObjects(meshes, false).length > 0) blocked++;
    }
  }
  check(
    "scaffold backing remains visibly open instead of an opaque billboard",
    blocked / samples < 0.35,
    `${blocked}/${samples} view rays occluded`,
  );
}
