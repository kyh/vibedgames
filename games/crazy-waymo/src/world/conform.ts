import * as THREE from "three";

import type { Terrain } from "./terrain";

// Drapes world-baked static geometry (road tiles, grass patches) over the
// terrain: triangles are adaptively subdivided where the height field curves
// underneath them, then every vertex is displaced by the terrain height. Since
// the ground mesh samples the same field, roads hug the hills with no seams.

// Coarser than the original 0.03/1.6/5: at the full-SF cell count the conform
// output dominates heap (non-indexed verts x 16k road cells), and a 6cm bow
// under a 13u-wide road is invisible. Markings float on a raised lift so the
// looser tolerance can't tuck them under the asphalt.
const MAX_ERROR = 0.06; // split a triangle when the surface bows past this
const MIN_EDGE = 2.4; // never split edges shorter than this (runaway guard)
const MAX_DEPTH = 4;
const UP_DOT = 0.8; // vertices at least this upright adopt the terrain normal

// Meshopt-compressed GLBs arrive with quantized (Int16/interleaved) attributes.
// Baking world transforms writes float world coords back into those arrays —
// which truncates them to garbage — so promote to plain Float32 first.
export function toFloat32Attributes(geo: THREE.BufferGeometry): void {
  for (const name of ["position", "normal", "uv"] as const) {
    const a = geo.getAttribute(name);
    if (!a) continue;
    if (a instanceof THREE.BufferAttribute && a.array instanceof Float32Array && !a.normalized) {
      continue;
    }
    const size = a.itemSize;
    const arr = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) {
      arr[i * size] = a.getX(i);
      if (size > 1) arr[i * size + 1] = a.getY(i);
      if (size > 2) arr[i * size + 2] = a.getZ(i);
    }
    geo.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
}

// A vertex is [x, y, z, nx, ny, nz, u, v].
type Vert = readonly [number, number, number, number, number, number, number, number];

function mid(a: Vert, b: Vert): Vert {
  return [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    (a[2] + b[2]) / 2,
    (a[3] + b[3]) / 2,
    (a[4] + b[4]) / 2,
    (a[5] + b[5]) / 2,
    (a[6] + b[6]) / 2,
    (a[7] + b[7]) / 2,
  ];
}

// The geometry must already be in world space (matrixWorld baked in).
export function conformToTerrain(
  geo: THREE.BufferGeometry,
  terrain: Terrain,
  lift: number,
): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const pos = src.getAttribute("position");
  const nor = src.getAttribute("normal");
  const uv = src.getAttribute("uv");

  const outP: number[] = [];
  const outN: number[] = [];
  const outU: number[] = [];

  const vertAt = (i: number): Vert => [
    pos.getX(i),
    pos.getY(i),
    pos.getZ(i),
    nor ? nor.getX(i) : 0,
    nor ? nor.getY(i) : 1,
    nor ? nor.getZ(i) : 0,
    uv ? uv.getX(i) : 0,
    uv ? uv.getY(i) : 0,
  ];

  const emit = (a: Vert, b: Vert, c: Vert): void => {
    for (const v of [a, b, c]) {
      outP.push(v[0], v[1], v[2]);
      outN.push(v[3], v[4], v[5]);
      outU.push(v[6], v[7]);
    }
  };

  // Does the terrain bow away from a straight line across any edge?
  const needsSplit = (a: Vert, b: Vert, c: Vert): boolean => {
    const edges: readonly (readonly [Vert, Vert])[] = [
      [a, b],
      [b, c],
      [c, a],
    ];
    for (const [p, q] of edges) {
      const dx = p[0] - q[0];
      const dz = p[2] - q[2];
      if (Math.hypot(dx, dz) < MIN_EDGE) continue;
      const hMid = terrain.heightAt((p[0] + q[0]) / 2, (p[2] + q[2]) / 2);
      const hAvg = (terrain.heightAt(p[0], p[2]) + terrain.heightAt(q[0], q[2])) / 2;
      if (Math.abs(hMid - hAvg) > MAX_ERROR) return true;
    }
    return false;
  };

  const split = (a: Vert, b: Vert, c: Vert, depth: number): void => {
    if (depth < MAX_DEPTH && needsSplit(a, b, c)) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      split(a, ab, ca, depth + 1);
      split(ab, b, bc, depth + 1);
      split(ca, bc, c, depth + 1);
      split(ab, bc, ca, depth + 1);
      return;
    }
    emit(a, b, c);
  };

  for (let i = 0; i < pos.count; i += 3) {
    split(vertAt(i), vertAt(i + 1), vertAt(i + 2), 0);
  }

  // Displace through the height field; upright normals follow the slope.
  const n = new THREE.Vector3();
  for (let i = 0; i < outP.length; i += 3) {
    const x = outP[i] ?? 0;
    const z = outP[i + 2] ?? 0;
    outP[i + 1] = (outP[i + 1] ?? 0) + terrain.heightAt(x, z) + lift;
    if ((outN[i + 1] ?? 0) > UP_DOT) {
      terrain.normalInto(n, x, z);
      outN[i] = n.x;
      outN[i + 1] = n.y;
      outN[i + 2] = n.z;
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(new Float32Array(outP), 3));
  out.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(outN), 3));
  out.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(outU), 2));
  return out;
}
