import type { Obb, ParcelLot, ParcelPlan } from "./parcel-plan";
import { PARCEL_HINTS } from "./parcel-source";
import type { FabricChar, ParcelKind } from "./parcel-style";
import type { Solid } from "../shared/types";

// The parcel plan, columnar. One ParcelPlan object per footprint was ~100 MB
// of heap for the 130k the city holds — most of a phone's budget for a table
// the streamer only reads one 80u cell at a time. Packed, the whole plan is
// a few typed arrays per world tile; a cell's plans are materialized when
// its geometry builds and are garbage as soon as it has. The same encoding
// ships in the baked tiles (world-bin.ts), so a first visit never runs the
// planner at all.
//
// Coordinates are Int16 steps of `scale` world units from `origin` — 1 cm
// steps about a tile's centre, coarser only when a set spans further than
// ±327 u (the skyline, packed city-wide). Origins are whole units, so a
// party wall's shared vertex quantizes to the same point from both
// neighbours whichever tile each is in. Heights and box extents are Int16
// centimetres; the integers gzip to a third of the floats they replace.

const PARCEL_KINDS: readonly ParcelKind[] = [
  "shed",
  "rowhouse",
  "stucco",
  "midrise",
  "tower",
  "warehouse",
];
const FABRIC_CHARS: readonly FabricChar[] = [
  "downtown",
  "highrise",
  "commercial",
  "wharf",
  "residential",
  "victorian",
  "industrial",
];

const CM = 0.01;
const I16_MAX = 32_767;
const FLAG_HERO = 1;
const FLAG_RECT = 2;
/* oxlint-disable no-bitwise -- the plan flags byte is a bit set */
const packFlags = (hero: boolean, rect: boolean): number =>
  (hero ? FLAG_HERO : 0) | (rect ? FLAG_RECT : 0);
const hasFlag = (flags: number, flag: number): boolean => (flags & flag) !== 0;
/* oxlint-enable no-bitwise */
const at0 = (values: ArrayLike<number>, i: number): number => values[i] ?? 0;
// cx, cz, ex, ez, halfA, halfB
const OBB_STRIDE = 6;
// x, z, half
const PILLAR_STRIDE = 3;

// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature BinTree needs
export type PackedPlans = {
  readonly count: number;
  /** Ring and centre coordinates are `origin + value * scale`. */
  readonly origin: readonly [number, number];
  readonly scale: number;
  readonly id: Uint32Array;
  readonly flags: Uint8Array;
  readonly hint: Uint8Array;
  readonly kind: Uint8Array;
  readonly character: Uint8Array;
  readonly district: Uint16Array;
  readonly seed: Uint32Array;
  readonly blockHash: Uint32Array;
  readonly n: Uint16Array;
  readonly front: Int16Array;
  readonly storeys: Uint16Array;
  readonly units: Uint8Array;
  /** Centimetres. */
  readonly seatY: Int16Array;
  readonly footY: Int16Array;
  readonly height: Int16Array;
  /** cx, cz (scaled), ex, ez (×32767), halfA, halfB (cm) per plan. */
  readonly obb: Int16Array;
  /** Vertex offset of plan i's ring (count + 1 entries). */
  readonly ringStart: Uint32Array;
  readonly ring: Int16Array;
  readonly blind: Uint8Array;
  readonly districts: string[];
};

// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature BinTree needs
export type PackedLots = {
  readonly count: number;
  readonly origin: readonly [number, number];
  readonly scale: number;
  readonly id: Uint32Array;
  readonly seed: Uint32Array;
  readonly n: Uint16Array;
  readonly ringStart: Uint32Array;
  readonly ring: Int16Array;
  /** Centimetres. */
  readonly ys: Int16Array;
  readonly obb: Int16Array;
  readonly pillarStart: Uint32Array;
  readonly pillars: Float32Array;
};

/** A coordinate frame every ring and centre of the set fits in Int16. */
interface Frame {
  readonly origin: readonly [number, number];
  readonly scale: number;
}

const frameFor = (rings: readonly Float32Array[], centres: readonly Obb[]): Frame => {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  const take = (x: number, z: number): void => {
    if (x < minX) {
      minX = x;
    }
    if (x > maxX) {
      maxX = x;
    }
    if (z < minZ) {
      minZ = z;
    }
    if (z > maxZ) {
      maxZ = z;
    }
  };
  for (const r of rings) {
    for (let v = 0; v + 1 < r.length; v += 2) {
      take(r[v] ?? 0, r[v + 1] ?? 0);
    }
  }
  for (const o of centres) {
    take(o.cx, o.cz);
  }
  if (!Number.isFinite(minX)) {
    return { origin: [0, 0], scale: CM };
  }
  // Whole-unit origin (see the header); the coarsest extent picks the scale
  // in whole centimetres so neighbouring sets agree on the grid.
  const origin: readonly [number, number] = [
    Math.round((minX + maxX) / 2),
    Math.round((minZ + maxZ) / 2),
  ];
  const reach = Math.max(
    Math.abs(minX - origin[0]),
    Math.abs(maxX - origin[0]),
    Math.abs(minZ - origin[1]),
    Math.abs(maxZ - origin[1]),
  );
  const scale = Math.max(CM, Math.ceil(reach / I16_MAX / CM) * CM);
  return { origin, scale };
};

const q16 = (value: number, what: string): number => {
  const v = Math.round(value);
  if (v < -I16_MAX - 1 || v > I16_MAX) {
    throw new Error(`parcel-pack: ${what} ${value} overflows`);
  }
  return v;
};

const qCm = (value: number, what: string): number => q16(value / CM, what);

const EMPTY_SOLIDS: readonly Solid[] = Object.freeze([]);

const indexOf = <T>(table: readonly T[], value: T, what: string): number => {
  const i = table.indexOf(value);
  if (i === -1) {
    throw new Error(`parcel-pack: unknown ${what} ${String(value)}`);
  }
  return i;
};

const checkRange = (value: number, max: number, what: string): number => {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`parcel-pack: ${what} ${value} out of range`);
  }
  return value;
};

const writeObb = (out: Int16Array, i: number, o: Obb, f: Frame): void => {
  out[i * OBB_STRIDE] = q16((o.cx - f.origin[0]) / f.scale, "obb cx");
  out[i * OBB_STRIDE + 1] = q16((o.cz - f.origin[1]) / f.scale, "obb cz");
  out[i * OBB_STRIDE + 2] = q16(o.ex * I16_MAX, "obb ex");
  out[i * OBB_STRIDE + 3] = q16(o.ez * I16_MAX, "obb ez");
  out[i * OBB_STRIDE + 4] = qCm(o.halfA, "obb halfA");
  out[i * OBB_STRIDE + 5] = qCm(o.halfB, "obb halfB");
};

const readObb = (p: Int16Array, i: number, f: Frame): Obb => ({
  cx: f.origin[0] + (p[i * OBB_STRIDE] ?? 0) * f.scale,
  cz: f.origin[1] + (p[i * OBB_STRIDE + 1] ?? 0) * f.scale,
  ex: (p[i * OBB_STRIDE + 2] ?? 0) / I16_MAX,
  ez: (p[i * OBB_STRIDE + 3] ?? 0) / I16_MAX,
  halfA: (p[i * OBB_STRIDE + 4] ?? 0) * CM,
  halfB: (p[i * OBB_STRIDE + 5] ?? 0) * CM,
});

const writeRing = (out: Int16Array, at: number, ring: Float32Array, n: number, f: Frame): void => {
  for (let v = 0; v < n; v += 1) {
    out[(at + v) * 2] = q16(((ring[v * 2] ?? 0) - f.origin[0]) / f.scale, "ring x");
    out[(at + v) * 2 + 1] = q16(((ring[v * 2 + 1] ?? 0) - f.origin[1]) / f.scale, "ring z");
  }
};

const readRing = (p: Int16Array, at: number, n: number, f: Frame): Float32Array => {
  const ring = new Float32Array(n * 2);
  for (let v = 0; v < n; v += 1) {
    ring[v * 2] = f.origin[0] + (p[(at + v) * 2] ?? 0) * f.scale;
    ring[v * 2 + 1] = f.origin[1] + (p[(at + v) * 2 + 1] ?? 0) * f.scale;
  }
  return ring;
};

export const packPlans = (plans: readonly ParcelPlan[]): PackedPlans => {
  const count = plans.length;
  const districts: string[] = [];
  const districtId = new Map<string, number>();
  let verts = 0;
  for (const p of plans) {
    verts += p.n;
  }
  const frame = frameFor(
    plans.map((p) => p.ring),
    plans.map((p) => p.obb),
  );
  const out = {
    blind: new Uint8Array(verts),
    blockHash: new Uint32Array(count),
    character: new Uint8Array(count),
    count,
    district: new Uint16Array(count),
    districts,
    flags: new Uint8Array(count),
    footY: new Int16Array(count),
    front: new Int16Array(count),
    height: new Int16Array(count),
    hint: new Uint8Array(count),
    id: new Uint32Array(count),
    kind: new Uint8Array(count),
    n: new Uint16Array(count),
    obb: new Int16Array(count * OBB_STRIDE),
    origin: frame.origin,
    ring: new Int16Array(verts * 2),
    ringStart: new Uint32Array(count + 1),
    scale: frame.scale,
    seatY: new Int16Array(count),
    seed: new Uint32Array(count),
    storeys: new Uint16Array(count),
    units: new Uint8Array(count),
  };
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    const p = plans[i];
    if (!p) {
      continue;
    }
    let d = districtId.get(p.district);
    if (d === undefined) {
      d = districts.length;
      districts.push(p.district);
      districtId.set(p.district, d);
    }
    out.id[i] = checkRange(p.id, 0xff_ff_ff_ff, "id");
    out.flags[i] = packFlags(p.hero, p.rect);
    out.hint[i] = indexOf(PARCEL_HINTS, p.hint, "hint");
    out.kind[i] = indexOf(PARCEL_KINDS, p.kind, "kind");
    out.character[i] = indexOf(FABRIC_CHARS, p.character, "character");
    out.district[i] = checkRange(d, 0xff_ff, "district");
    out.seed[i] = checkRange(p.seed, 0xff_ff_ff_ff, "seed");
    out.blockHash[i] = checkRange(p.blockHash, 0xff_ff_ff_ff, "blockHash");
    out.n[i] = checkRange(p.n, 0xff_ff, "n");
    if (!Number.isInteger(p.front) || p.front < -1 || p.front >= p.n) {
      throw new Error(`parcel-pack: front ${p.front} out of range`);
    }
    out.front[i] = p.front;
    out.storeys[i] = checkRange(p.storeys, 0xff_ff, "storeys");
    out.units[i] = checkRange(p.units, 0xff, "units");
    out.seatY[i] = qCm(p.seatY, "seatY");
    out.footY[i] = qCm(p.footY, "footY");
    out.height[i] = qCm(p.height, "height");
    writeObb(out.obb, i, p.obb, frame);
    out.ringStart[i] = at;
    writeRing(out.ring, at, p.ring, p.n, frame);
    for (let v = 0; v < p.n; v += 1) {
      out.blind[at + v] = p.blind[v] ?? 0;
    }
    at += p.n;
  }
  out.ringStart[count] = at;
  return out;
};

/** Plan `i` as the mesh generator reads it. Solids are not carried: the
 *  baked meta ships every collision box already (see world-loader.ts). */
export const unpackPlan = (p: PackedPlans, i: number): ParcelPlan => {
  const n = at0(p.n, i);
  const at = at0(p.ringStart, i);
  const flags = at0(p.flags, i);
  return {
    blind: p.blind.slice(at, at + n),
    blockHash: at0(p.blockHash, i),
    character: FABRIC_CHARS[at0(p.character, i)] ?? "residential",
    district: p.districts[at0(p.district, i)] ?? "",
    footY: at0(p.footY, i) * CM,
    front: p.front[i] ?? -1,
    height: at0(p.height, i) * CM,
    hero: hasFlag(flags, FLAG_HERO),
    hint: PARCEL_HINTS[at0(p.hint, i)] ?? "generic",
    id: at0(p.id, i),
    kind: PARCEL_KINDS[at0(p.kind, i)] ?? "shed",
    n,
    obb: readObb(p.obb, i, p),
    rect: hasFlag(flags, FLAG_RECT),
    ring: readRing(p.ring, at, n, p),
    seatY: at0(p.seatY, i) * CM,
    seed: at0(p.seed, i),
    solids: EMPTY_SOLIDS,
    storeys: at0(p.storeys, i),
    units: p.units[i] ?? 1,
  };
};

export const unpackPlans = (p: PackedPlans, indices?: Iterable<number>): ParcelPlan[] => {
  const out: ParcelPlan[] = [];
  if (indices) {
    for (const index of indices) {
      out.push(unpackPlan(p, index));
    }
  } else {
    for (let i = 0; i < p.count; i += 1) {
      out.push(unpackPlan(p, i));
    }
  }
  return out;
};

export const packLots = (lots: readonly ParcelLot[]): PackedLots => {
  const count = lots.length;
  let verts = 0;
  let pillarN = 0;
  for (const l of lots) {
    verts += l.n;
    pillarN += l.pillars.length;
  }
  const frame = frameFor(
    lots.map((l) => l.ring),
    lots.map((l) => l.obb),
  );
  const out = {
    count,
    id: new Uint32Array(count),
    n: new Uint16Array(count),
    obb: new Int16Array(count * OBB_STRIDE),
    origin: frame.origin,
    pillarStart: new Uint32Array(count + 1),
    pillars: new Float32Array(pillarN * PILLAR_STRIDE),
    ring: new Int16Array(verts * 2),
    ringStart: new Uint32Array(count + 1),
    scale: frame.scale,
    seed: new Uint32Array(count),
    ys: new Int16Array(verts),
  };
  let at = 0;
  let pillarAt = 0;
  for (let i = 0; i < count; i += 1) {
    const l = lots[i];
    if (!l) {
      continue;
    }
    out.id[i] = checkRange(l.id, 0xff_ff_ff_ff, "lot id");
    out.seed[i] = checkRange(l.seed, 0xff_ff_ff_ff, "lot seed");
    out.n[i] = checkRange(l.n, 0xff_ff, "lot n");
    out.ringStart[i] = at;
    writeRing(out.ring, at, l.ring, l.n, frame);
    for (let v = 0; v < l.n; v += 1) {
      out.ys[at + v] = qCm(l.ys[v] ?? 0, "lot y");
    }
    at += l.n;
    writeObb(out.obb, i, l.obb, frame);
    out.pillarStart[i] = pillarAt;
    for (const pillar of l.pillars) {
      out.pillars[pillarAt * PILLAR_STRIDE] = pillar.x;
      out.pillars[pillarAt * PILLAR_STRIDE + 1] = pillar.z;
      out.pillars[pillarAt * PILLAR_STRIDE + 2] = pillar.half;
      pillarAt += 1;
    }
  }
  out.ringStart[count] = at;
  out.pillarStart[count] = pillarAt;
  return out;
};

export const unpackLot = (p: PackedLots, i: number): ParcelLot => {
  const n = p.n[i] ?? 0;
  const at = p.ringStart[i] ?? 0;
  const pillars: { readonly x: number; readonly z: number; readonly half: number }[] = [];
  for (let k = p.pillarStart[i] ?? 0; k < (p.pillarStart[i + 1] ?? 0); k += 1) {
    pillars.push({
      half: p.pillars[k * PILLAR_STRIDE + 2] ?? 0,
      x: p.pillars[k * PILLAR_STRIDE] ?? 0,
      z: p.pillars[k * PILLAR_STRIDE + 1] ?? 0,
    });
  }
  return {
    id: p.id[i] ?? 0,
    n,
    obb: readObb(p.obb, i, p),
    pillars,
    ring: readRing(p.ring, at, n, p),
    seed: p.seed[i] ?? 0,
    ys: Float32Array.from(p.ys.subarray(at, at + n), (y) => y * CM),
  };
};

export const unpackLots = (p: PackedLots, indices?: Iterable<number>): ParcelLot[] => {
  const out: ParcelLot[] = [];
  if (indices) {
    for (const index of indices) {
      out.push(unpackLot(p, index));
    }
  } else {
    for (let i = 0; i < p.count; i += 1) {
      out.push(unpackLot(p, i));
    }
  }
  return out;
};

/** Centre of plan/lot `i` — what the streamer files it under. */
export const packedCentre = (p: PackedPlans | PackedLots, i: number): readonly [number, number] => [
  p.origin[0] + (p.obb[i * OBB_STRIDE] ?? 0) * p.scale,
  p.origin[1] + (p.obb[i * OBB_STRIDE + 1] ?? 0) * p.scale,
];

export const EMPTY_PACKED_PLANS: PackedPlans = packPlans([]);
export const EMPTY_PACKED_LOTS: PackedLots = packLots([]);
