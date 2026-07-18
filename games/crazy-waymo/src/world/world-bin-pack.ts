import * as THREE from "three";

import type { CityRestPayload } from "./city";
import type { CityGenPayload } from "./gen-worker";
import { isTyped, typeTag } from "./world-bin";
import type { BufRef, PackedSolids, QPos, QUv, Typed } from "./world-bin";

// WRITE side of the world-bin split (bake-only, lazy-loaded): pack/serialize
// must mirror the unpack side in ./world-bin.ts exactly — change them together.

// Walk the payload, swap typed arrays for refs, collect buffers.
function strip(value: unknown, bufs: Typed[]): unknown {
  if (isTyped(value)) {
    const ref: BufRef = { $buf: bufs.length, $type: typeTag(value) };
    bufs.push(value);
    return ref;
  }
  if (Array.isArray(value)) return value.map((v) => strip(v, bufs));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = strip(v, bufs);
    return out;
  }
  return value;
}

export function serializeWorldBin(payload: {
  rev: number;
  world?: unknown;
  rest?: unknown;
}): Uint8Array {
  const bufs: Typed[] = [];
  const tree = strip(payload, bufs);
  const header = JSON.stringify({
    tree,
    buffers: bufs.map((b) => ({ type: typeTag(b), length: b.length })),
  });
  const headerBytes = new TextEncoder().encode(header);
  let total = 4 + headerBytes.length;
  const offsets: number[] = [];
  for (const b of bufs) {
    total = (total + 3) & ~3; // 4-byte align
    offsets.push(total);
    total += b.byteLength;
  }
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, headerBytes.length, true);
  out.set(headerBytes, 4);
  for (let i = 0; i < bufs.length; i++) {
    const b = bufs[i];
    const off = offsets[i];
    if (b === undefined || off === undefined) continue;
    out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quantized packing: Float32 geometry gzips terribly (~150MB artifacts). Per-
// record Int16 positions (bbox-normalized, ≤8mm error on chunk-sized pieces),
// Int8 normals, Uint8 vertex colors, columnar batch items. world.bin carries
// TERRAIN ONLY — with rest.bin present, the merged chunks already contain the
// roads, so shipping roadParts would double them.
// ---------------------------------------------------------------------------

function qPos(a: Float32Array): QPos {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i] ?? 0,
      y = a[i + 1] ?? 0,
      z = a[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const sx = maxX - minX || 1,
    sy = maxY - minY || 1,
    sz = maxZ - minZ || 1;
  const q = new Uint16Array(a.length);
  for (let i = 0; i < a.length; i += 3) {
    q[i] = Math.round((((a[i] ?? 0) - minX) / sx) * 65535);
    q[i + 1] = Math.round((((a[i + 1] ?? 0) - minY) / sy) * 65535);
    q[i + 2] = Math.round((((a[i + 2] ?? 0) - minZ) / sz) * 65535);
  }
  return { q, min: [minX, minY, minZ], span: [sx, sy, sz] };
}

function qNor(a: Float32Array): Int8Array {
  const q = new Int8Array(a.length);
  for (let i = 0; i < a.length; i++) q[i] = Math.round((a[i] ?? 0) * 127);
  return q;
}

function qUv(a: Float32Array): QUv {
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity;
  for (let i = 0; i < a.length; i += 2) {
    const u = a[i] ?? 0,
      v = a[i + 1] ?? 0;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const su = maxU - minU || 1,
    sv = maxV - minV || 1;
  const q = new Uint16Array(a.length);
  for (let i = 0; i < a.length; i += 2) {
    q[i] = Math.round((((a[i] ?? 0) - minU) / su) * 65535);
    q[i + 1] = Math.round((((a[i + 1] ?? 0) - minV) / sv) * 65535);
  }
  return { q, min: [minU, minV], span: [su, sv] };
}

function packIndex(
  idx: Uint16Array | Uint32Array | null,
  vertCount: number,
): Uint16Array | Uint32Array | null {
  if (!idx) return null;
  if (idx instanceof Uint16Array || vertCount > 65535) return idx;
  return Uint16Array.from(idx);
}

function qCol(a: Float32Array): Uint8Array {
  const q = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) q[i] = Math.round(Math.min(1, Math.max(0, a[i] ?? 0)) * 255);
  return q;
}

// Terrain-only world payload. Normals ship as Int8 (rev 19+): they gzip to
// almost nothing and their absence forced a computeVertexNormals pass over
// the whole map on EVERY visit — a main-thread freeze on phones.
export function packWorld(world: CityGenPayload): unknown {
  return {
    tiles: world.tiles.map((t) => ({
      pos: qPos(t.position),
      nor: t.normal ? qNor(t.normal) : null,
      col: t.color ? qCol(t.color) : null,
      index: t.index,
      x: t.x,
      z: t.z,
    })),
  };
}

export function packRest(rest: CityRestPayload): unknown {
  const urls: string[] = [];
  const urlId = new Map<string, number>();
  const n = rest.batchItems.length;
  const urlIdx = new Int32Array(n);
  const rawIdx = new Int32Array(n);
  const tints = new Int32Array(n);
  // Matrices: nearly every instance is translate+yaw+scale — 20 bytes beats
  // 64. Non-yaw rotations (tilted props) go to an exact f32 fallback list.
  const trs = new Float32Array(n * 5); // x, y, z, yaw, — scale packed below
  const scales = new Uint16Array(n * 3); // per-axis, quantized 0..16
  const exact = new Map<number, Float32Array>();
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const it = rest.batchItems[i];
    if (!it) continue;
    if (it.url !== null) {
      let id = urlId.get(it.url);
      if (id === undefined) {
        id = urls.length;
        urlId.set(it.url, id);
        urls.push(it.url);
      }
      urlIdx[i] = id * 4096 + it.idx; // url id + child idx packed
      rawIdx[i] = -1;
    } else {
      urlIdx[i] = -1;
      rawIdx[i] = it.raw ?? -1;
    }
    tints[i] = it.tint ?? -1;
    m4.fromArray(it.m);
    m4.decompose(pos, quat, scl);
    const yawOnly = Math.abs(quat.x) < 1e-4 && Math.abs(quat.z) < 1e-4;
    const sOk = scl.x < 16 && scl.y < 16 && scl.z < 16;
    if (yawOnly && sOk) {
      const yaw = 2 * Math.atan2(quat.y, quat.w);
      trs[i * 5] = pos.x;
      trs[i * 5 + 1] = pos.y;
      trs[i * 5 + 2] = pos.z;
      trs[i * 5 + 3] = yaw;
      trs[i * 5 + 4] = 1; // marker: TRS-encoded
      scales[i * 3] = Math.round((scl.x / 16) * 65535);
      scales[i * 3 + 1] = Math.round((scl.y / 16) * 65535);
      scales[i * 3 + 2] = Math.round((scl.z / 16) * 65535);
    } else {
      trs[i * 5 + 4] = 0;
      exact.set(i, new Float32Array(it.m));
    }
  }
  const exactIdx = new Int32Array(exact.size);
  const exactMats = new Float32Array(exact.size * 16);
  let e = 0;
  for (const [i, m] of exact) {
    exactIdx[e] = i;
    exactMats.set(m, e * 16);
    e++;
  }
  return {
    mergedChunks: rest.mergedChunks.map((r) => ({
      cx: r.cx,
      cz: r.cz,
      dist: r.dist,
      pos: qPos(r.position),
      nor: r.normal ? qNor(r.normal) : null,
      // uv only matters on textured (srcMat) records — dead weight elsewhere
      uv: r.srcMat && r.uv ? qUv(r.uv) : null,
      col: r.color ? qCol(r.color) : null,
      index: packIndex(r.index, r.position.length / 3),
      mat: r.mat,
      srcMat: r.srcMat,
    })),
    rawGeos: rest.rawGeos.map((g) => ({
      pos: qPos(g.position),
      nor: g.normal ? qNor(g.normal) : null,
      uv: null, // raw geos are untextured by construction
      index: packIndex(g.index, g.position.length / 3),
      mat: g.mat,
    })),
    items: { urls, urlIdx, rawIdx, trs, scales, exactIdx, exactMats, tints, count: n },
    solids: packSolids(rest.solids),
    parkedCars: rest.parkedCars,
    lampHeads: rest.lampHeads,
    decks: rest.decks,
  };
}

function packSolids(solids: CityRestPayload["solids"]): PackedSolids {
  const n = solids.length;
  const data = new Float32Array(n * 6);
  const flags = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const so = solids[i];
    if (!so) continue;
    data[i * 6] = so.minX;
    data[i * 6 + 1] = so.maxX;
    data[i * 6 + 2] = so.minZ;
    data[i * 6 + 3] = so.maxZ;
    data[i * 6 + 4] = so.maxY ?? 0;
    data[i * 6 + 5] = so.yaw ?? 0;
    flags[i] =
      (so.maxY !== undefined ? 1 : 0) |
      (so.yaw !== undefined ? 2 : 0) |
      (so.noBody ? 4 : 0) |
      (so.unseen !== undefined ? 8 : 0); // reason string dropped; the bit is what the census needs
  }
  return { data, flags, count: n };
}
