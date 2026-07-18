import * as THREE from "three";

import type { CityRestPayload } from "./city";
import type { CityGenPayload } from "./gen-worker";

// Binary serialization for the PRE-BAKED world: the same two payloads the
// runtime caches in IndexedDB, but shipped as static assets so first visits
// skip generation entirely. Format: [u32 headerLen][JSON header][buffers…].
// The header mirrors the payload structure with typed arrays replaced by
// { $buf: n, $type: "f32"|"u16"|"u32"|"i8" } refs into the buffer table.
// READ side of the world-bin split: deserialize/unpack live here (main
// bundle); the pack side in ./world-bin-pack.ts must mirror it exactly.

export const WORLD_REV = 56; // bump when generation code changes → rebake (56 = construction vehicles at chicane pockets)

export type Typed = Float32Array | Uint16Array | Uint32Array | Int8Array | Uint8Array | Int32Array;
export type BufRef = { $buf: number; $type: "f32" | "u16" | "u32" | "i8" | "u8" | "i32" };

export function isTyped(v: unknown): v is Typed {
  return (
    v instanceof Float32Array ||
    v instanceof Uint16Array ||
    v instanceof Uint32Array ||
    v instanceof Int8Array ||
    v instanceof Uint8Array ||
    v instanceof Int32Array
  );
}

export function typeTag(v: Typed): BufRef["$type"] {
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
// Quantized unpacking (the pack side lives in ./world-bin-pack.ts): Int16
// positions (bbox-normalized), Int8 normals, Uint8 vertex colors, columnar
// batch items dequantize back to the runtime payload shapes.
// ---------------------------------------------------------------------------

const UP_AXIS = new THREE.Vector3(0, 1, 0);

export type QPos = {
  q: Uint16Array;
  min: [number, number, number];
  span: [number, number, number];
};

function dqPos(p: QPos): Float32Array {
  const out = new Float32Array(p.q.length);
  for (let i = 0; i < p.q.length; i += 3) {
    out[i] = p.min[0] + ((p.q[i] ?? 0) / 65535) * p.span[0];
    out[i + 1] = p.min[1] + ((p.q[i + 1] ?? 0) / 65535) * p.span[1];
    out[i + 2] = p.min[2] + ((p.q[i + 2] ?? 0) / 65535) * p.span[2];
  }
  return out;
}

function dqNor(q: Int8Array): Float32Array {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = (q[i] ?? 0) / 127;
  return out;
}

export type QUv = { q: Uint16Array; min: [number, number]; span: [number, number] };

function dqUv(p: QUv): Float32Array {
  const out = new Float32Array(p.q.length);
  for (let i = 0; i < p.q.length; i += 2) {
    out[i] = p.min[0] + ((p.q[i] ?? 0) / 65535) * p.span[0];
    out[i + 1] = p.min[1] + ((p.q[i + 1] ?? 0) / 65535) * p.span[1];
  }
  return out;
}

function dqCol(q: Uint8Array): Float32Array {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = (q[i] ?? 0) / 255;
  return out;
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

export type PackedSolids = { data: Float32Array; flags: Uint8Array; count: number };

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
