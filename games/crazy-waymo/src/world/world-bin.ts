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

// Bump when generation code changes → rebake. 60 = wave-2 map polish: the true
// Mission Creek coastline + 12 new hills + island (land mask, terrain, street
// network, ground classes all re-baked), the lot-line building fabric (stepped
// hill lots, party walls, tower massing), the Mediterranean ground palette off
// the single land-class resolver, and the real transit/paint pass (cable slots,
// Muni red, crosswalks, stencils, across-road uv).
// 61 = wave-3 polish: the Golden Gate's SECOND tower + orange deck truss, the
// Bay Bridge anchorage opened into a portal over the Embarcadero, the Dragon
// Gate straddling its street, an authored Painted Ladies terrace, Oracle Park
// and Fort Point re-sited, one rainbow crosswalk instead of a district of
// them, calmer Muni red, and moorings/floats that require water under them.
// The wave-3 range also carries the value/colour grade: ground.ts COVER_COLOR
// dropped ~18% in value so the ground is the BOTTOM band instead of the
// second-brightest (it is the largest area in most frames, and silhouettes were
// dying against it), and sf-map.ts PALETTES were rebuilt as one hue family plus
// a value ramp per district instead of a six-hue wheel per district. Both are
// VERTEX/TINT output — a bin baked before them ships the old colours.
// 65 = landmark reservation boxes are clamped off the DRAWN asphalt as well as
// off road cells (the Bay Bridge anchorage's box reached 7u into the
// Embarcadero on cells the raster called lot), plus the Sutro Tower lattice
// and the Bay Bridge anchorage's portal/relief.
// 66 = final-gate rebake. No generation change of its own: rev 65's bins were
// installed BEFORE the last edits to landmarks.ts landed, so the shipped world
// was not provably the shipped source. Rebaked so it is.
// 69 = the Golden Gate strait (67/68 were bake iterations of the same change).
// landFactor pulls the Presidio's north shore south across the strait's whole
// mouth — ~70u of water became ~222u — so both bridge towers stand IN the water
// with a real main span between them; the Marin coast is a traced line instead
// of a box; the headland behind it carries its real summits; and terrain.ts's
// cached field now covers the whole drawn ground skirt (an off-map crest used
// to render as a plateau). Land mask, street network, terrain and every seated
// prop moved.
// 71 = the landmark silhouette pass (70 was a bake iteration of it). The
// Golden Gate's towers go to their real 51u above the water on art-deco
// stepped legs with ziggurat portal bracing; its main cable becomes a true
// parabola between saddles and is finally VISIBLE at all (it was one
// world-space tube, so the batch streamer filed it at the map centre and
// streamed it in only at Twin Peaks — and once fixed, ONE 243 × 40u instance
// earns a box imposter of the same size, which read from the Marina as a solid
// red billboard over the strait, hence a chain of short links and 14.5u leg
// sections that stay above the 13u imposter threshold); it gains a suspender
// curtain at a 5u pitch and an orange stiffening truss. Fort Point moves onto
// the widened strait's new shore. The Painted Ladies get fenestration, roofs
// and stoops, and Alamo Square becomes a real block. The Bay Bridge
// anchorage's soffit is corrected from 8.0 to the 13.0 its own comment
// claimed, its cornice lands on the block instead of floating 4u over it, and
// the western approach stops where it can no longer fly. Baked meshes,
// landmark reservations and the procedural placement that follows them all
// moved.
// 73 = the wave-4 integration bake (72 was a bake iteration of it). It is the
// FIRST bin that contains every source edit of this wave at once — 71 was
// baked while the ground/kerb re-grade, the furniture seating fixes and the
// LOD pass were still in flight, so the shipped world was not provably the
// shipped source. It also carries two repairs of its own:
//   • The Golden Gate's landfall blend deck is pushed BEFORE the flat span and
//     the span is trimmed to meet it. `surface.ts heightAt` returns the first
//     matching deck, so the flat one used to win over the 12u it overlapped
//     and the blend was dead exactly where it does its work (a ~1.8u lip at
//     the Marin landfall).
//   • Shore lips seat on their own footprint (0.52 tiles, inside the lip's own
//     thickness) instead of 1.6u inland of it, with a bounded skirt down to
//     the boundary — on a bluff shore the two references differ by up to 6.8u
//     and ~300 caps hung in the air at the inland height.
// Measured effect on the shipped world: seated props floating 1045 -> 745,
// everything else within its ratchet.
// 74 = the wave-5 integration bake. Only ONE builder in this wave writes to the
// bins — `buildGoldenGate`, which is cold-gen only (see CLAUDE.md, "Two load
// paths") — so this rev exists for the crossing and nothing else:
//   • The anchorages are STONE in three stepped tiers with a banded setback at
//     each, and the only International Orange left on them is the saddle plate
//     the cable actually bears on. A 14u prism of flat accent paint at arm's
//     length was the last place the world had two material vocabularies.
//   • The towers are deep along the strait (LEG_DEPTH), capped with a cap plate
//     + saddle housing + crown, and their portal braces bunch toward the top.
//     End-on — which is how the crossing is seen from most of the city — a
//     square-legged tower with evenly spaced rungs is a fire escape.
//   • The deck truss walks down the ramp and dies into the anchorage instead of
//     stopping 26u out over open water.
//   • The tower fender: one stone mass across both legs at the waterline, so
//     the structure has a foot and the crossing keeps one masonry vocabulary
//     from shore to shore.
// Everything else this wave touched is runtime (sky, far terrain, freeway
// concrete, LOD banding) or is rebuilt live on both load paths (landmarks), so
// the bins' non-Gate contents are byte-identical in intent to 73.
// 75: freeway deck profile capped. The slew limiter was an unbounded max-plus
// dilation, so a summit held the deck up for kilometres either side — a
// quarter of the network stood above 24u, worst 58.3u (25x the car). Now each
// sample's rise is capped by its own ceiling and an over-steep pair settles by
// LOWERING the high side. Deck geometry, pillars and physics all move.
// 76: the Golden Gate's masonry becomes MASONRY (world/masonry.ts) — coursed
// ashlar with recessed bed joints, chamfered arrises, a cornice profile at each
// setback and drip staining under it, in place of flat prisms with a band on
// top. Both anchorages, both tower fenders and the Battery Ridge parapet.
// It has to be GEOMETRY and it has to be a rebake: buildGoldenGate is cold-gen
// only, its meshes ship in rest.bin, and the baked path rebuilds a material
// from the serialized MatRec — so a shader on the shared stone material reaches
// nobody who plays the shipped game (measured; see masonry.ts). The outer
// silhouette of every mass is unchanged: each block is sized to the setback
// band it replaces, so the anchorage corridor clearance the chase camera was
// measured against does not move.
// 77: the masonry `face` tone moves 0x9aa2a6 -> 0x9ba3a7. 76 shipped it at the
// seawall lip's EXACT descriptor, and the baked material factory dedupes by
// descriptor, so one material object ended up on two BatchedMeshes with
// different batch state and the anchorage's face stones drew pure BLACK from
// the standard chase framing. The colour lives in the bin's MatRec, so the
// separation only reaches players through a rebake. Nothing else moves.
// 81: rebake of the rev-79 network (80 tried a post-octilinear dedupe pass and
// was reverted — it could only take 2 of 15 candidates without stranding whole
// street clusters, and put a building facade on the asphalt for the trouble).
// 79: the map bake now also de-duplicates plain same-roadway pairs, not just
// divided-arterial twins (tools/sf-data/bake-network.mts sameRoadway) — 17
// edges that were one street mapped twice collapse, so their doubled asphalt,
// stranded centre lines and doubled traffic lanes go with them.
// 78: the Golden Gate's deck boards drop 0.5u so their TOP face is the
// carriageway — they were seated off a hardcoded offset that put them above
// city.heightAt, and since the wheels ride the surface the car drove the whole
// span half-buried in the roadway. Green bike lanes also now need a street
// wide enough to hold one (half >= 4.0): on the 3.2 residential class the band
// landed mid travel-lane and read as loose green patches, not a lane.
export const WORLD_REV = 82;

export type Typed = Float32Array | Uint16Array | Uint32Array | Int8Array | Uint8Array | Int32Array;
export type BufRef = { $buf: number; $type: "f32" | "u16" | "u32" | "i8" | "u8" | "i32" };

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

export function isTyped(v: BinTree): v is Typed {
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

const BYTES = { f32: 4, u32: 4, i32: 4, u16: 2, i8: 1, u8: 1 } satisfies Record<
  BufRef["$type"],
  number
>;
const CTOR = {
  f32: Float32Array,
  u32: Uint32Array,
  i32: Int32Array,
  u16: Uint16Array,
  i8: Int8Array,
  u8: Uint8Array,
} satisfies Record<BufRef["$type"], new (b: ArrayBuffer, o: number, l: number) => Typed>;

function hydrate(value: BinTree, views: Typed[]): BinTree {
  if (value instanceof Object) {
    if ("$buf" in value && "$type" in value) {
      // SAFETY: only the pack side's strip() writes $buf/$type objects into the
      // tree, always as a BufRef.
      const ref = value as BufRef;
      return views[ref.$buf];
    }
    if (Array.isArray(value)) return value.map((v) => hydrate(v, views));
    const out: Record<string, BinTree> = {};
    for (const [k, v] of Object.entries(value)) out[k] = hydrate(v, views);
    return out;
  }
  return value;
}

export function deserializeWorldBin(bytes: ArrayBuffer): WorldBinPayload {
  const view = new DataView(bytes);
  const headerLen = view.getUint32(0, true);
  // SAFETY: bins are produced only by serializeWorldBin (world-bin-pack.ts),
  // which writes exactly { tree, buffers } — and a foreign/stale artifact is
  // rejected by the WORLD_REV check before its contents are used.
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 4, headerLen))) as {
    tree: BinTree;
    buffers: { type: BufRef["$type"]; length: number }[];
  };
  const views: Typed[] = [];
  let cursor = 4 + headerLen;
  for (const b of header.buffers) {
    cursor = (cursor + 3) & ~3;
    views.push(new CTOR[b.type](bytes, cursor, b.length));
    cursor += b.length * BYTES[b.type];
  }
  // SAFETY: hydrate undoes strip() 1:1 — the tree is the WorldBinPayload that
  // serializeWorldBin consumed, with each $buf ref swapped back for its view.
  return hydrate(header.tree, views) as WorldBinPayload;
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

// The packed payload shapes are the contract between the pack side
// (./world-bin-pack.ts) and this unpack side — packWorld/packRest construct
// them, serialize/hydrate round-trip them structurally, unpack consumes them.
export type PackedTile = {
  pos: QPos;
  nor: Int8Array | null;
  col: Uint8Array | null;
  index: Uint16Array | Uint32Array | null;
  x: number;
  z: number;
};
export type PackedWorld = { tiles: PackedTile[] };

export type PackedMergedChunk = {
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
};
export type PackedRawGeo = {
  pos: QPos;
  nor: Int8Array | null;
  uv: null;
  index: Uint16Array | Uint32Array | null;
  mat: CityRestPayload["rawGeos"][number]["mat"];
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

export type WorldBinPayload = { rev: number; world?: PackedWorld; rest?: PackedRest };

export function unpackWorld(p: PackedWorld): CityGenPayload {
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

export async function unpackRest(p: PackedRest): Promise<CityRestPayload> {
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

// Mutable staging shape for Solid: the flag-gated fields are added one
// statement at a time, and Solid itself is readonly.
type UnpackedSolid = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxY?: number;
  yaw?: number;
  noBody?: boolean;
  unseen?: string;
};

function unpackSolids(p: PackedSolids): CityRestPayload["solids"] {
  const out: CityRestPayload["solids"] = [];
  for (let i = 0; i < p.count; i++) {
    const f = p.flags[i] ?? 0;
    const solid: UnpackedSolid = {
      minX: p.data[i * 6] ?? 0,
      maxX: p.data[i * 6 + 1] ?? 0,
      minZ: p.data[i * 6 + 2] ?? 0,
      maxZ: p.data[i * 6 + 3] ?? 0,
    };
    if (f & 1) solid.maxY = p.data[i * 6 + 4] ?? 0;
    if (f & 8) solid.unseen = "baked";
    if (f & 2) solid.yaw = p.data[i * 6 + 5] ?? 0;
    if (f & 4) solid.noBody = true;
    out.push(solid);
  }
  return out;
}
