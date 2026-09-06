// The parcel SOURCE: every building footprint the fabric builds from, as one
// flat record stream fetched next to the world bins (public/world/parcels.bin,
// written by tools/sf-data/bake-parcels.mts — change the two together).
//
// Two provenances share the stream. The licensed downtown survey (`hero`)
// carries LiDAR-true heights and exact party walls and gets the full facade
// vocabulary; the OpenStreetMap footprints that cover the rest of the
// peninsula carry a height only where the map has one and are built lean —
// body, roof and a facade shader for the windows — because there are six of
// them for every survey parcel and the vertex budget is the whole design.
//
// Record: u8 n · u8 hint · u8 flags(bit0 hero) · u16 height×100 (0 =
// unknown) · u32 blind-edge mask · n × (int16 x, int16 z) at 5 cm, the first
// absolute and the rest deltas. Header "VGPC" · u8 version · u32 count.

export const PARCEL_SOURCE_MAGIC = "VGPC";
export const PARCEL_SOURCE_VERSION = 1;

/** What OSM says a building is, coarsened to what the style pass can use. */
export const PARCEL_HINTS = [
  "generic",
  "shed",
  "house",
  "apartments",
  "commercial",
  "industrial",
  "public",
] as const;
export type ParcelHint = (typeof PARCEL_HINTS)[number];

const Q = 20;

export type ParcelSource = {
  readonly count: number;
  /** Ring i is coords[offsets[i] * 2 .. offsets[i + 1] * 2). */
  readonly offsets: Uint32Array;
  readonly coords: Float32Array;
  /** World units; 0 = unknown, the plan picks a district-typical height. */
  readonly heights: Float32Array;
  readonly hints: Uint8Array;
  readonly hero: Uint8Array;
  /** Bit e set = ring edge e (vertex e -> e+1) is a party wall. */
  readonly blind: Uint32Array;
};

export function hintOf(src: ParcelSource, i: number): ParcelHint {
  return PARCEL_HINTS[src.hints[i] ?? 0] ?? "generic";
}

export function decodeParcelSource(buf: ArrayBuffer): ParcelSource {
  const dv = new DataView(buf);
  let off = 0;
  let magic = "";
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(dv.getUint8(off++));
  if (magic !== PARCEL_SOURCE_MAGIC) throw new Error(`parcels.bin: bad magic ${magic}`);
  const version = dv.getUint8(off++);
  if (version !== PARCEL_SOURCE_VERSION) {
    throw new Error(`parcels.bin: version ${version}, expected ${PARCEL_SOURCE_VERSION}`);
  }
  const count = dv.getUint32(off, true);
  off += 4;
  const offsets = new Uint32Array(count + 1);
  const heights = new Float32Array(count);
  const hints = new Uint8Array(count);
  const hero = new Uint8Array(count);
  const blind = new Uint32Array(count);
  // Two passes would need the vertex total up front; one pass over a growable
  // buffer is simpler and the stream is a few megabytes.
  let coords = new Float32Array(1 << 16);
  let nv = 0;
  for (let i = 0; i < count; i++) {
    const n = dv.getUint8(off++);
    hints[i] = dv.getUint8(off++);
    hero[i] = dv.getUint8(off++) & 1;
    heights[i] = dv.getUint16(off, true) / 100;
    off += 2;
    blind[i] = dv.getUint32(off, true);
    off += 4;
    offsets[i] = nv;
    if ((nv + n) * 2 > coords.length) {
      const grown = new Float32Array(Math.max(coords.length * 2, (nv + n) * 2));
      grown.set(coords);
      coords = grown;
    }
    let px = 0;
    let pz = 0;
    for (let k = 0; k < n; k++) {
      const dx = dv.getInt16(off, true);
      const dz = dv.getInt16(off + 2, true);
      off += 4;
      px = k === 0 ? dx : px + dx;
      pz = k === 0 ? dz : pz + dz;
      coords[(nv + k) * 2] = px / Q;
      coords[(nv + k) * 2 + 1] = pz / Q;
    }
    nv += n;
  }
  offsets[count] = nv;
  return { count, offsets, coords: coords.slice(0, nv * 2), heights, hints, hero, blind };
}
