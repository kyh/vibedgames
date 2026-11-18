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

export interface ParcelSource {
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
}

export const hintOf: (src: ParcelSource, i: number) => ParcelHint = (src, i) =>
  PARCEL_HINTS[src.hints[i] ?? 0] ?? "generic";

export const decodeParcelSource = (buf: ArrayBuffer) => {
  const dv = new DataView(buf);
  let off = 0;
  let magic = "";

  for (let i = 0; i < 4; i += 1) {
    magic += String.fromCodePoint(dv.getUint8(off));
    off += 1;
  }

  if (magic !== PARCEL_SOURCE_MAGIC) {
    throw new Error(`parcels.bin: bad magic ${magic}`);
  }

  const version = dv.getUint8(off);
  off += 1;

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
  let coords = new Float32Array(65_536);
  let nv = 0;

  for (let i = 0; i < count; i += 1) {
    const n = dv.getUint8(off);
    hints[i] = dv.getUint8(off + 1);
    hero[i] = dv.getUint8(off + 2) % 2;
    off += 3;
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

    for (let k = 0; k < n; k += 1) {
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

  return { blind, coords: coords.slice(0, nv * 2), count, heights, hero, hints, offsets };
};
