import * as THREE from "three";

import type { CityRestPayload } from "./city";
import type { CityGenPayload } from "./gen-worker";
import { isBinArray, isBinRecord, isTyped, typeTag } from "./world-bin";
import type { BinTree, BufRef, PackedRest, Typed, WorldBinPayload } from "./world-bin";
import { packIndex, qNor, qPos } from "./quantized-geometry";

const strip: (value: BinTree, bufs: Typed[]) => BinTree = (value, bufs) => {
  if (isTyped(value)) {
    const ref: BufRef = { $buf: bufs.length, $type: typeTag(value) };
    bufs.push(value);

    return ref;
  }

  if (isBinArray(value)) {
    return value.map((v) => strip(v, bufs));
  }

  if (isBinRecord(value)) {
    const out: Record<string, BinTree> = {};

    for (const [k, v] of Object.entries(value)) {
      out[k] = strip(v, bufs);
    }

    return out;
  }

  return value;
};

export const serializeWorldBin = (payload: WorldBinPayload) => {
  const bufs: Typed[] = [];
  const tree = strip(payload, bufs);

  const header = JSON.stringify({
    buffers: bufs.map((b) => ({ length: b.length, type: typeTag(b) })),
    tree,
  });

  const headerBytes = new TextEncoder().encode(header);
  let total = 4 + headerBytes.length;
  const offsets: number[] = [];

  for (const b of bufs) {
    total = Math.ceil(total / 4) * 4;
    offsets.push(total);
    total += b.byteLength;
  }

  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, headerBytes.length, true);
  out.set(headerBytes, 4);

  for (let i = 0; i < bufs.length; i += 1) {
    const b = bufs[i];
    const off = offsets[i];

    if (b === undefined || off === undefined) {
      continue;
    }

    out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
  }

  return out;
};

export const packWorld = (world: CityGenPayload) => ({ tiles: world.tiles });

const packSolidFlags = (so: CityRestPayload["solids"][number]) =>
  (so.maxY === undefined ? 0 : 1) +
  (so.yaw === undefined ? 0 : 2) +
  (so.noBody === true ? 4 : 0) +
  (so.unseen === undefined ? 0 : 8) +
  (so.minY === undefined ? 0 : 16);

export const packSolids = (solids: CityRestPayload["solids"]) => {
  const n = solids.length;
  const data = new Float32Array(n * 6);
  const flags = new Uint8Array(n);
  const minY = new Float32Array(n);

  for (let i = 0; i < n; i += 1) {
    const so = solids[i];

    if (!so) {
      continue;
    }

    data[i * 6] = so.minX;
    data[i * 6 + 1] = so.maxX;
    data[i * 6 + 2] = so.minZ;
    data[i * 6 + 3] = so.maxZ;
    data[i * 6 + 4] = so.maxY ?? 0;
    data[i * 6 + 5] = so.yaw ?? 0;
    minY[i] = so.minY ?? 0;
    flags[i] = packSolidFlags(so);
  }

  return { count: n, data, flags, minY };
};

export const packRest: (rest: CityRestPayload) => PackedRest = (rest) => {
  const urls: string[] = [];
  const urlId = new Map<string, number>();
  const n = rest.batchItems.length;
  const urlIdx = new Int32Array(n);
  const rawIdx = new Int32Array(n);
  const tints = new Int32Array(n);
  const trs = new Float32Array(n * 5);
  const scales = new Uint16Array(n * 3);
  const exact = new Map<number, Float32Array>();
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();

  for (let i = 0; i < n; i += 1) {
    const it = rest.batchItems[i];

    if (!it) {
      continue;
    }

    if (it.url === null) {
      urlIdx[i] = -1;
      rawIdx[i] = it.raw ?? -1;
    } else {
      let id = urlId.get(it.url);

      if (id === undefined) {
        id = urls.length;
        urlId.set(it.url, id);
        urls.push(it.url);
      }

      urlIdx[i] = id * 4096 + it.idx;
      rawIdx[i] = -1;
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
      trs[i * 5 + 4] = 1;
      scales[i * 3] = Math.round((scl.x / 16) * 65_535);
      scales[i * 3 + 1] = Math.round((scl.y / 16) * 65_535);
      scales[i * 3 + 2] = Math.round((scl.z / 16) * 65_535);
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
    e += 1;
  }

  return {
    decks: rest.decks,
    items: { count: n, exactIdx, exactMats, rawIdx, scales, tints, trs, urlIdx, urls },
    lampHeads: rest.lampHeads,
    mergedChunks: rest.mergedChunks,
    parkedCars: rest.parkedCars,
    rawGeos: rest.rawGeos.map((g) => ({
      index: packIndex(g.index, g.position.length / 3),
      mat: g.mat,
      nor: g.normal ? qNor(g.normal) : null,
      pos: qPos(g.position),
      uv: null,
    })),
    solids: packSolids(rest.solids),
  };
};
