import * as THREE from "three";

import type { CityRestPayload } from "./city";
import type { CityGenPayload } from "./gen-worker";

// Binary serialization for the PRE-BAKED world: the same two payloads the
// runtime caches in IndexedDB, but shipped as static assets so first visits
// skip generation entirely. Format: [u32 headerLen][JSON header][buffers…].
// The header mirrors the payload structure with typed arrays replaced by
// { $buf: n, $type: "f32"|"u16"|"u32"|"i8" } refs into the buffer table.

export const WORLD_REV = 52; // bump when generation code changes → rebake (52 = street-control pass: no-bald-block dashes, all-way stop signs, signal buildout)

type Typed = Float32Array | Uint16Array | Uint32Array | Int8Array | Uint8Array | Int32Array;
type BufRef = { $buf: number; $type: "f32" | "u16" | "u32" | "i8" | "u8" | "i32" };

function isTyped(v: unknown): v is Typed {
  return (
    v instanceof Float32Array ||
    v instanceof Uint16Array ||
    v instanceof Uint32Array ||
    v instanceof Int8Array ||
    v instanceof Uint8Array ||
    v instanceof Int32Array
  );
}

function typeTag(v: Typed): BufRef["$type"] {
  if (v instanceof Float32Array) return "f32";
  if (v instanceof Uint16Array) return "u16";
  if (v instanceof Uint32Array) return "u32";
  if (v instanceof Int8Array) return "i8";
  if (v instanceof Uint8Array) return "u8";
  return "i32";
}

const BYTES: Record<BufRef["$type"], number> = { f32: 4, u32: 4, i32: 4, u16: 2, i8: 1, u8: 1 };
const CTOR: Record<BufRef["$type"], new (b: ArrayBuffer, o: number, l: number) => Typed> = {
  f32: Float32Array,
  u32: Uint32Array,
  i32: Int32Array,
  u16: Uint16Array,
  i8: Int8Array,
  u8: Uint8Array,
};

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

function hydrate(value: unknown, views: Typed[]): unknown {
  if (value && typeof value === "object") {
    if ("$buf" in value && "$type" in value) {
      return views[(value as BufRef).$buf];
    }
    if (Array.isArray(value)) return value.map((v) => hydrate(v, views));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = hydrate(v, views);
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

export function deserializeWorldBin(bytes: ArrayBuffer): {
  rev: number;
  world?: unknown;
  rest?: unknown;
} {
  const view = new DataView(bytes);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 4, headerLen))) as {
    tree: unknown;
    buffers: { type: BufRef["$type"]; length: number }[];
  };
  const views: Typed[] = [];
  let cursor = 4 + headerLen;
  for (const b of header.buffers) {
    cursor = (cursor + 3) & ~3;
    views.push(new CTOR[b.type](bytes, cursor, b.length));
    cursor += b.length * BYTES[b.type];
  }
  return hydrate(header.tree, views) as {
    rev: number;
    world?: unknown;
    rest?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Quantized packing: Float32 geometry gzips terribly (~150MB artifacts). Per-
// record Int16 positions (bbox-normalized, ≤8mm error on chunk-sized pieces),
// Int8 normals, Uint8 vertex colors, columnar batch items. world.bin carries
// TERRAIN ONLY — with rest.bin present, the merged chunks already contain the
// roads, so shipping roadParts would double them.
// ---------------------------------------------------------------------------

const UP_AXIS = new THREE.Vector3(0, 1, 0);

type QPos = { q: Uint16Array; min: [number, number, number]; span: [number, number, number] };

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

function dqPos(p: QPos): Float32Array {
  const out = new Float32Array(p.q.length);
  for (let i = 0; i < p.q.length; i += 3) {
    out[i] = p.min[0] + ((p.q[i] ?? 0) / 65535) * p.span[0];
    out[i + 1] = p.min[1] + ((p.q[i + 1] ?? 0) / 65535) * p.span[1];
    out[i + 2] = p.min[2] + ((p.q[i + 2] ?? 0) / 65535) * p.span[2];
  }
  return out;
}

function qNor(a: Float32Array): Int8Array {
  const q = new Int8Array(a.length);
  for (let i = 0; i < a.length; i++) q[i] = Math.round((a[i] ?? 0) * 127);
  return q;
}

function dqNor(q: Int8Array): Float32Array {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = (q[i] ?? 0) / 127;
  return out;
}

type QUv = { q: Uint16Array; min: [number, number]; span: [number, number] };

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

function dqUv(p: QUv): Float32Array {
  const out = new Float32Array(p.q.length);
  for (let i = 0; i < p.q.length; i += 2) {
    out[i] = p.min[0] + ((p.q[i] ?? 0) / 65535) * p.span[0];
    out[i + 1] = p.min[1] + ((p.q[i + 1] ?? 0) / 65535) * p.span[1];
  }
  return out;
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

function dqCol(q: Uint8Array): Float32Array {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = (q[i] ?? 0) / 255;
  return out;
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

export function unpackWorld(packed: unknown): CityGenPayload {
  const p = packed as {
    tiles: {
      pos: QPos;
      nor: Int8Array | null;
      col: Uint8Array | null;
      index: Uint16Array | Uint32Array | null;
      x: number;
      z: number;
    }[];
  };
  return {
    roadParts: [], // rest.bin's merged chunks carry the roads
    tiles: p.tiles.map((t) => ({
      position: dqPos(t.pos),
      normal: t.nor ? dqNor(t.nor) : null,
      color: t.col ? dqCol(t.col) : null,
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

// Time-sliced yield: the unpack runs behind the title screen, and its dq
// loops over the whole city would otherwise starve the render loop.
let lastUnpackYield = 0;
async function unpackYield(): Promise<void> {
  if (performance.now() - lastUnpackYield < 12) return;
  await new Promise((r) => setTimeout(r, 0));
  lastUnpackYield = performance.now();
}

export async function unpackRest(packed: unknown): Promise<CityRestPayload> {
  const p = packed as {
    mergedChunks: {
      cx: number;
      cz: number;
      dist: number;
      pos: QPos;
      nor: Int8Array | null;
      uv: QUv | null;
      col: Uint8Array | null;
      index: Uint16Array | Uint32Array | null;
      mat: CityRestPayload["mergedChunks"][number]["mat"];
      srcMat: { url: string; idx: number } | null;
    }[];
    rawGeos: {
      pos: QPos;
      nor: Int8Array | null;
      uv: null;
      index: Uint16Array | Uint32Array | null;
      mat: CityRestPayload["rawGeos"][number]["mat"];
    }[];
    items: {
      urls: string[];
      urlIdx: Int32Array;
      rawIdx: Int32Array;
      trs: Float32Array;
      scales: Uint16Array;
      exactIdx: Int32Array;
      exactMats: Float32Array;
      tints: Int32Array;
      count: number;
    };
    solids: PackedSolids;
    parkedCars: CityRestPayload["parkedCars"];
    lampHeads: CityRestPayload["lampHeads"];
    decks: CityRestPayload["decks"];
  };
  const exactBy = new Map<number, number>();
  for (let e = 0; e < p.items.exactIdx.length; e++) {
    const idx = p.items.exactIdx[e];
    if (idx !== undefined) exactBy.set(idx, e);
  }
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const batchItems: CityRestPayload["batchItems"] = [];
  for (let i = 0; i < p.items.count; i++) {
    if (i % 4096 === 0) await unpackYield();
    const u = p.items.urlIdx[i] ?? -1;
    const tintV = p.items.tints[i] ?? -1;
    let m: Float32Array;
    if ((p.items.trs[i * 5 + 4] ?? 0) === 1) {
      const yaw = p.items.trs[i * 5 + 3] ?? 0;
      q.setFromAxisAngle(UP_AXIS, yaw);
      m4.compose(
        new THREE.Vector3(p.items.trs[i * 5], p.items.trs[i * 5 + 1], p.items.trs[i * 5 + 2]),
        q,
        new THREE.Vector3(
          ((p.items.scales[i * 3] ?? 0) / 65535) * 16,
          ((p.items.scales[i * 3 + 1] ?? 0) / 65535) * 16,
          ((p.items.scales[i * 3 + 2] ?? 0) / 65535) * 16,
        ),
      );
      m = new Float32Array(m4.elements);
    } else {
      const e = exactBy.get(i) ?? 0;
      m = p.items.exactMats.slice(e * 16, e * 16 + 16);
    }
    batchItems.push({
      url: u >= 0 ? (p.items.urls[Math.floor(u / 4096)] ?? null) : null,
      idx: u >= 0 ? u % 4096 : 0,
      raw: u >= 0 ? null : (p.items.rawIdx[i] ?? -1),
      m,
      tint: tintV >= 0 ? tintV : null,
      big: false,
    });
  }
  const mergedChunks: CityRestPayload["mergedChunks"] = [];
  for (const r of p.mergedChunks) {
    await unpackYield();
    mergedChunks.push({
      cx: r.cx,
      cz: r.cz,
      dist: r.dist,
      position: dqPos(r.pos),
      // Legacy (rev ≤18) artifacts ship without normals — mesh build recomputes.
      normal: r.nor ? dqNor(r.nor) : null,
      uv: r.uv ? dqUv(r.uv) : null,
      color: r.col ? dqCol(r.col) : null,
      index: r.index,
      mat: r.mat,
      srcMat: r.srcMat,
    });
  }
  return {
    mergedChunks,
    rawGeos: p.rawGeos.map((g) => ({
      position: dqPos(g.pos),
      normal: g.nor ? dqNor(g.nor) : null,
      uv: null,
      index: g.index,
      mat: g.mat,
    })),
    batchItems,
    solids: unpackSolids(p.solids),
    parkedCars: p.parkedCars,
    lampHeads: p.lampHeads,
    decks: p.decks,
  };
}

type PackedSolids = { data: Float32Array; flags: Uint8Array; count: number };

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

function unpackSolids(p: PackedSolids): CityRestPayload["solids"] {
  const out: CityRestPayload["solids"] = [];
  for (let i = 0; i < p.count; i++) {
    const f = p.flags[i] ?? 0;
    out.push({
      minX: p.data[i * 6] ?? 0,
      maxX: p.data[i * 6 + 1] ?? 0,
      minZ: p.data[i * 6 + 2] ?? 0,
      maxZ: p.data[i * 6 + 3] ?? 0,
      ...(f & 1 ? { maxY: p.data[i * 6 + 4] ?? 0 } : {}),
      ...(f & 8 ? { unseen: "baked" } : {}),
      ...(f & 2 ? { yaw: p.data[i * 6 + 5] ?? 0 } : {}),
      ...(f & 4 ? { noBody: true } : {}),
    });
  }
  return out;
}
