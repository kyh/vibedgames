import * as THREE from "three";

import type { CityRestPayload } from "./city";
import type { CityGenPayload } from "./gen-worker";
import { isTyped, typeTag } from "./world-bin";
import type {
  BinTree,
  BufRef,
  PackedRest,
  PackedSolids,
  PackedWorld,
  Typed,
  WorldBinPayload,
} from "./world-bin";
import { packIndex, qNor, qPos } from "./quantized-geometry";

// WRITE side of the world-bin split (bake-only, lazy-loaded): pack/serialize
// must mirror the unpack side in ./world-bin.ts exactly — change them together.

// Walk the payload, swap typed arrays for refs, collect buffers.
function strip(value: BinTree, bufs: Typed[]): BinTree {
  if (isTyped(value)) {
    const ref: BufRef = { $buf: bufs.length, $type: typeTag(value) };
    bufs.push(value);
    return ref;
  }
  if (Array.isArray(value)) return value.map((v) => strip(v, bufs));
  if (value instanceof Object) {
    const out: Record<string, BinTree> = {};
    for (const [k, v] of Object.entries(value)) out[k] = strip(v, bufs);
    return out;
  }
  return value;
}

export function serializeWorldBin(payload: WorldBinPayload): Uint8Array {
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
// Quantized packing: the geometry records arrive already packed
// (world/quantized-geometry.ts — the capture and the gen worker quantize at
// the source, and the runtime draws the same encoding). Batch items go
// columnar: nearly every instance is translate+yaw+scale — 20 bytes beats 64.
// ---------------------------------------------------------------------------

export function packWorld(world: CityGenPayload): PackedWorld {
  return { tiles: world.tiles };
}

export function packRest(rest: CityRestPayload): PackedRest {
  const urls: string[] = [];
  const urlId = new Map<string, number>();
  const n = rest.batchItems.length;
  const urlIdx = new Int32Array(n);
  const rawIdx = new Int32Array(n);
  const tints = new Int32Array(n);
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
    mergedChunks: rest.mergedChunks,
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

export function packSolids(solids: CityRestPayload["solids"]): PackedSolids {
  const n = solids.length;
  const data = new Float32Array(n * 6);
  const flags = new Uint8Array(n);
  const minY = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const so = solids[i];
    if (!so) continue;
    data[i * 6] = so.minX;
    data[i * 6 + 1] = so.maxX;
    data[i * 6 + 2] = so.minZ;
    data[i * 6 + 3] = so.maxZ;
    data[i * 6 + 4] = so.maxY ?? 0;
    data[i * 6 + 5] = so.yaw ?? 0;
    minY[i] = so.minY ?? 0;
    flags[i] =
      (so.maxY !== undefined ? 1 : 0) |
      (so.yaw !== undefined ? 2 : 0) |
      (so.noBody ? 4 : 0) |
      (so.unseen !== undefined ? 8 : 0) |
      (so.minY !== undefined ? 16 : 0); // reason string dropped; the bit is what the census needs
  }
  return { data, flags, count: n, minY };
}
