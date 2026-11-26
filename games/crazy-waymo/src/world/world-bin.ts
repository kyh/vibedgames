import * as THREE from "three";

import type { CityRestPayload, MatRec } from "./city";
import type { PackedGeometry, QPos } from "./quantized-geometry";
import type { PackedLots, PackedPlans } from "./parcel-pack";
import type { CityGenPayload } from "./gen-worker";
import { delay } from "../shared/wait";
import { isFiniteJsonNumber, isJsonObject } from "../shared/json";
import type { JsonValue } from "../shared/json";
import { paced, range } from "../shared/paced";

export const WORLD_REV = 98;

export type Typed =
  | Float32Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int8Array
  | Uint8Array
  | Int32Array;

export interface BufRef {
  $buf: number;
  $type: "f32" | "u16" | "i16" | "u32" | "i8" | "u8" | "i32";
}

/** A serialization-tree node: JSON structure with typed arrays at the leaves
 *  (runtime side) or `$buf` refs in their place (wire side). */
export type BinTree =
  | string
  | number
  | boolean
  | null
  | undefined
  | Typed
  | BufRef
  | readonly BinTree[]
  | { readonly [key: string]: BinTree };

export const isTyped = (v: BinTree): v is Typed =>
  v instanceof Float32Array ||
  v instanceof Uint16Array ||
  v instanceof Int16Array ||
  v instanceof Uint32Array ||
  v instanceof Int8Array ||
  v instanceof Uint8Array ||
  v instanceof Int32Array;

export const typeTag: (v: Typed) => BufRef["$type"] = (v) => {
  if (v instanceof Float32Array) {
    return "f32";
  }

  if (v instanceof Uint16Array) {
    return "u16";
  }

  if (v instanceof Int16Array) {
    return "i16";
  }

  if (v instanceof Uint32Array) {
    return "u32";
  }

  if (v instanceof Int8Array) {
    return "i8";
  }

  if (v instanceof Uint8Array) {
    return "u8";
  }

  return "i32";
};

const BYTES = { f32: 4, i16: 2, i32: 4, i8: 1, u16: 2, u32: 4, u8: 1 } satisfies Record<
  BufRef["$type"],
  number
>;

const CTOR = {
  f32: Float32Array,
  i16: Int16Array,
  i32: Int32Array,
  i8: Int8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  u8: Uint8Array,
} satisfies Record<BufRef["$type"], new (b: ArrayBuffer, o: number, l: number) => Typed>;

/** A `$buf` reference standing in for a typed array on the wire. */
export const isBufRef = (value: BinTree): value is BufRef =>
  value instanceof Object && "$buf" in value && "$type" in value;

export const isBinArray = (value: BinTree): value is readonly BinTree[] => Array.isArray(value);

export const isBinRecord = (value: BinTree): value is { readonly [key: string]: BinTree } =>
  value instanceof Object && !isTyped(value) && !Array.isArray(value);

const BUF_TYPES = [
  "f32",
  "u16",
  "i16",
  "u32",
  "i8",
  "u8",
  "i32",
] as const satisfies readonly BufRef["$type"][];

const hydrate: (value: BinTree, views: Typed[]) => BinTree = (value, views) => {
  if (isBufRef(value)) {
    return views[value.$buf];
  }

  if (isBinArray(value)) {
    return value.map((v) => hydrate(v, views));
  }

  if (value instanceof Object) {
    const out: Record<string, BinTree> = {};

    for (const [k, v] of Object.entries(value)) {
      out[k] = hydrate(v, views);
    }

    return out;
  }

  return value;
};

const bufferSpecOf = (spec: JsonValue) => {
  if (!isJsonObject(spec)) {
    throw new Error("world bin: buffer spec is not an object");
  }

  const type = BUF_TYPES.find((t) => t === spec.type);
  const { length } = spec;

  if (type === undefined || !isFiniteJsonNumber(length)) {
    throw new Error("world bin: buffer spec needs a known type and a length");
  }

  return { length, type };
};

export const deserializeWorldBin = (bytes: ArrayBuffer) => {
  const view = new DataView(bytes);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 4, headerLen)));

  if (!isJsonObject(header) || !Array.isArray(header.buffers) || header.tree === undefined) {
    throw new Error("world bin: header needs a tree and its buffers");
  }

  const views: Typed[] = [];
  let cursor = 4 + headerLen;

  for (const b of header.buffers.map(bufferSpecOf)) {
    cursor = Math.ceil(cursor / 4) * 4;
    views.push(new CTOR[b.type](bytes, cursor, b.length));
    cursor += b.length * BYTES[b.type];
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- the tree is this build's own serializeWorldBin output (callers drop any whose rev is not WORLD_REV); checking the multi-megabyte payload field by field would walk it a second time on every load
  return hydrate(header.tree, views) as WorldBinPayload;
};

const UP_AXIS = new THREE.Vector3(0, 1, 0);

export type { QPos, QUv } from "./quantized-geometry";

export type PackedTile = PackedGeometry & {
  x: number;
  z: number;
};

export type PackedWorld = {
  tiles: PackedTile[];
};

export type PackedMergedChunk = PackedGeometry & {
  cx: number;
  cz: number;
  dist: number;
  mat: MatRec;
  srcMat: { url: string; idx: number } | null;
};

export type PackedRawGeo = {
  pos: QPos;
  nor: Int8Array | null;
  uv: null;
  index: Uint16Array | Uint32Array | null;
  mat: MatRec;
};

export type PackedBatchItems = {
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

export type PackedRest = {
  mergedChunks: PackedMergedChunk[];
  rawGeos: PackedRawGeo[];
  items: PackedBatchItems;
  solids: PackedSolids;
  parkedCars: CityRestPayload["parkedCars"];
  lampHeads: CityRestPayload["lampHeads"];
  decks: CityRestPayload["decks"];
};

/** One 320u world tile (shared/constants CHUNK): the merged static geometry
 *  inside it plus the parcel fabric whose centres fall in it. */
export type PackedWorldTile = {
  ix: number;
  iz: number;
  cx: number;
  cz: number;
  mergedChunks: PackedMergedChunk[];
  plans: PackedPlans;
  lots: PackedLots;
  /** The parcel walls whose centres fall in the tile. */
  solids: PackedSolids;
};

export type WorldTileRef = {
  ix: number;
  iz: number;
  cx: number;
  cz: number;
  /** Gzipped size, for download progress. */
  bytes: number;
};

/** Everything of the built city that is not tiled: batch instances (whose
 *  templates are shared GLB geometry), the base collision boxes (borders,
 *  seawalls, landmarks, furniture — the parcel walls ride their tiles), and
 *  the skyline, which reads from anywhere and is built once. */
export type PackedMeta = {
  rawGeos: PackedRawGeo[];
  items: PackedBatchItems;
  solids: PackedSolids;
  parkedCars: CityRestPayload["parkedCars"];
  lampHeads: CityRestPayload["lampHeads"];
  decks: CityRestPayload["decks"];
  skyline: PackedPlans;
  tiles: WorldTileRef[];
};

/** A bake's output as one download: each entry is a finished artifact's
 *  bytes (gzipped) under its public/world path. */
export type BakeFile = {
  name: string;
  data: Uint8Array;
};

export type WorldBinPayload = {
  rev: number;
  world?: PackedWorld;
  rest?: PackedRest;
  meta?: PackedMeta;
  tile?: PackedWorldTile;
  files?: BakeFile[];
};

export type CityRestMeta = Omit<CityRestPayload, "mergedChunks"> & {
  readonly skyline: PackedPlans;
  readonly tiles: readonly WorldTileRef[];
};

export const unpackWorld: (p: PackedWorld) => CityGenPayload = (p) => ({
  roadParts: [],
  tiles: p.tiles,
});

let lastUnpackYield = 0;

const unpackYield = async () => {
  if (performance.now() - lastUnpackYield < 12) {
    return;
  }

  await delay(0);
  lastUnpackYield = performance.now();
};

const dqPos = (p: QPos) => {
  const out = new Float32Array(p.q.length);

  for (let i = 0; i < p.q.length; i += 3) {
    out[i] = p.min[0] + ((p.q[i] ?? 0) / 65_535) * p.span[0];
    out[i + 1] = p.min[1] + ((p.q[i + 1] ?? 0) / 65_535) * p.span[1];
    out[i + 2] = p.min[2] + ((p.q[i + 2] ?? 0) / 65_535) * p.span[2];
  }

  return out;
};

const dqNor = (q: Int8Array) => {
  const out = new Float32Array(q.length);

  for (let i = 0; i < q.length; i += 1) {
    out[i] = (q[i] ?? 0) / 127;
  }

  return out;
};

export const unpackBatchItems = async (p: PackedBatchItems) => {
  const exactBy = new Map<number, number>();

  for (let e = 0; e < p.exactIdx.length; e += 1) {
    const idx = p.exactIdx[e];

    if (idx !== undefined) {
      exactBy.set(idx, e);
    }
  }

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const batchItems: CityRestPayload["batchItems"] = [];

  for await (const start of paced(range(p.count, 0, 4096), unpackYield)) {
    for (let i = start; i < Math.min(start + 4096, p.count); i += 1) {
      const u = p.urlIdx[i] ?? -1;
      const tintV = p.tints[i] ?? -1;
      let m: Float32Array;

      if ((p.trs[i * 5 + 4] ?? 0) === 1) {
        const yaw = p.trs[i * 5 + 3] ?? 0;
        q.setFromAxisAngle(UP_AXIS, yaw);
        m4.compose(
          new THREE.Vector3(p.trs[i * 5], p.trs[i * 5 + 1], p.trs[i * 5 + 2]),
          q,
          new THREE.Vector3(
            ((p.scales[i * 3] ?? 0) / 65_535) * 16,
            ((p.scales[i * 3 + 1] ?? 0) / 65_535) * 16,
            ((p.scales[i * 3 + 2] ?? 0) / 65_535) * 16,
          ),
        );
        m = new Float32Array(m4.elements);
      } else {
        const e = exactBy.get(i) ?? 0;
        m = p.exactMats.slice(e * 16, e * 16 + 16);
      }

      batchItems.push({
        big: false,
        idx: u >= 0 ? u % 4096 : 0,
        m,
        raw: u >= 0 ? null : (p.rawIdx[i] ?? -1),
        tint: tintV >= 0 ? tintV : null,
        url: u >= 0 ? (p.urls[Math.floor(u / 4096)] ?? null) : null,
      });
    }
  }

  return batchItems;
};

/** Raw geometries are BatchedMesh templates beside the GLB ones, which are
 *  Float32 — they stay Float32 so a bucket's layouts match. They are small. */
export const unpackRawGeos = (p: readonly PackedRawGeo[]) =>
  p.map((g) => ({
    // oxlint-disable-next-line unicorn/prefer-spread -- typed array: slice keeps the element type, spread would not
    index: g.index?.slice() ?? null,
    mat: g.mat,
    normal: g.nor ? dqNor(g.nor) : null,
    position: dqPos(g.pos),
    uv: null,
  }));

export type PackedSolids = {
  data: Float32Array;
  flags: Uint8Array;
  count: number;
  minY?: Float32Array;
};

interface UnpackedSolid {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxY?: number;
  yaw?: number;
  noBody?: boolean;
  unseen?: string;
}

// oxlint-disable-next-line no-bitwise -- the solid flags are a bit set (see packSolidFlags)
const hasFlag = (flags: number, bit: number) => (flags & bit) !== 0;

export const unpackSolids = (p: PackedSolids) => {
  const out: CityRestPayload["solids"] = [];

  for (let i = 0; i < p.count; i += 1) {
    const f = p.flags[i] ?? 0;

    const solid: UnpackedSolid = {
      maxX: p.data[i * 6 + 1] ?? 0,
      maxZ: p.data[i * 6 + 3] ?? 0,
      minX: p.data[i * 6] ?? 0,
      minZ: p.data[i * 6 + 2] ?? 0,
    };

    if (hasFlag(f, 1)) {
      solid.maxY = p.data[i * 6 + 4] ?? 0;
    }

    if (hasFlag(f, 8)) {
      solid.unseen = "baked";
    }

    if (hasFlag(f, 2)) {
      solid.yaw = p.data[i * 6 + 5] ?? 0;
    }

    if (hasFlag(f, 4)) {
      solid.noBody = true;
    }

    if (hasFlag(f, 16)) {
      const minY = p.minY?.[i];
      const { maxY } = solid;

      if (
        minY === undefined ||
        maxY === undefined ||
        !Number.isFinite(minY) ||
        !Number.isFinite(maxY) ||
        minY >= maxY
      ) {
        throw new Error("Invalid packed wall height");
      }

      out.push({ ...solid, maxY, minY });
    } else {
      out.push(solid);
    }
  }

  return out;
};

export const unpackRest = async (p: PackedRest) => ({
  batchItems: await unpackBatchItems(p.items),
  decks: p.decks,
  lampHeads: p.lampHeads,
  mergedChunks: p.mergedChunks,
  parkedCars: p.parkedCars,
  rawGeos: unpackRawGeos(p.rawGeos),
  solids: unpackSolids(p.solids),
});

export const unpackMeta = async (p: PackedMeta) => ({
  batchItems: await unpackBatchItems(p.items),
  decks: p.decks,
  lampHeads: p.lampHeads,
  parkedCars: p.parkedCars,
  rawGeos: unpackRawGeos(p.rawGeos),
  skyline: p.skyline,
  solids: unpackSolids(p.solids),
  tiles: p.tiles,
});
