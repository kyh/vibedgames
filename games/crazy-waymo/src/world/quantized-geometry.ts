import * as THREE from "three";

// Static world geometry ships AND draws quantized: Uint16 positions normalized
// over a per-record bounding box, Int8 normals, Uint8 vertex colours. three
// uploads normalized integer attributes untouched, so the GPU holds ~16 bytes
// per vertex instead of the ~40 of a Float32 layout, and nothing dequantizes
// on load. The bounding box becomes the mesh's own transform (position = box
// min, scale = box span); CPU readers go through the mesh matrix exactly like
// three's raycast does, and the ceiling harvest (world/solid-index.ts) scales
// the raw integers itself. A Float32 copy of a road tile is never made.

export type QPos = {
  q: Uint16Array;
  min: [number, number, number];
  span: [number, number, number];
};

export type QUv = {
  q: Uint16Array;
  min: [number, number];
  span: [number, number];
};

/** One static mesh's attributes as they ship: quantized, normals mandatory. */
export type PackedGeometry = {
  pos: QPos;
  nor: Int8Array;
  uv: QUv | null;
  col: Uint8Array | null;
  index: Uint16Array | Uint32Array | null;
};

export const qPos = (a: Float32Array): QPos => {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i] ?? 0;
    const y = a[i + 1] ?? 0;
    const z = a[i + 2] ?? 0;
    if (x < minX) {
      minX = x;
    }
    if (x > maxX) {
      maxX = x;
    }
    if (y < minY) {
      minY = y;
    }
    if (y > maxY) {
      maxY = y;
    }
    if (z < minZ) {
      minZ = z;
    }
    if (z > maxZ) {
      maxZ = z;
    }
  }
  if (a.length === 0) {
    minX = 0;
    minY = 0;
    minZ = 0;
    maxX = 0;
    maxY = 0;
    maxZ = 0;
  }
  const sx = maxX - minX || 1;
  const sy = maxY - minY || 1;
  const sz = maxZ - minZ || 1;
  const q = new Uint16Array(a.length);
  for (let i = 0; i < a.length; i += 3) {
    q[i] = Math.round((((a[i] ?? 0) - minX) / sx) * 65_535);
    q[i + 1] = Math.round((((a[i + 1] ?? 0) - minY) / sy) * 65_535);
    q[i + 2] = Math.round((((a[i + 2] ?? 0) - minZ) / sz) * 65_535);
  }
  return { min: [minX, minY, minZ], q, span: [sx, sy, sz] };
};

export const qNor = (a: Float32Array): Int8Array => {
  const q = new Int8Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    q[i] = Math.round((a[i] ?? 0) * 127);
  }
  return q;
};

export const qCol = (a: Float32Array): Uint8Array => {
  const q = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    q[i] = Math.round(Math.min(1, Math.max(0, a[i] ?? 0)) * 255);
  }
  return q;
};

/** An all-zero uv channel carries no information — drop it rather than pay
 *  2 bytes per vertex for it. */
export const allZero = (a: Float32Array): boolean => {
  for (const v of a) {
    if (v !== 0) {
      return false;
    }
  }
  return true;
};

export const qUv = (a: Float32Array): QUv => {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < a.length; i += 2) {
    const u = a[i] ?? 0;
    const v = a[i + 1] ?? 0;
    if (u < minU) {
      minU = u;
    }
    if (u > maxU) {
      maxU = u;
    }
    if (v < minV) {
      minV = v;
    }
    if (v > maxV) {
      maxV = v;
    }
  }
  if (a.length === 0) {
    minU = 0;
    minV = 0;
    maxU = 0;
    maxV = 0;
  }
  const su = maxU - minU || 1;
  const sv = maxV - minV || 1;
  const q = new Uint16Array(a.length);
  for (let i = 0; i < a.length; i += 2) {
    q[i] = Math.round((((a[i] ?? 0) - minU) / su) * 65_535);
    q[i + 1] = Math.round((((a[i + 1] ?? 0) - minV) / sv) * 65_535);
  }
  return { min: [minU, minV], q, span: [su, sv] };
};

// The road shaders read uv as authored (a lateral coordinate that runs past
// 1, atlas windows) — no normalized encoding reproduces that without a
// per-record uniform, so uv alone is expanded to Float32 at build time. It
// is the minority channel: ~40% of the records, and roads only.
export const dqUv = (p: QUv): Float32Array => {
  const out = new Float32Array(p.q.length);
  for (let i = 0; i < p.q.length; i += 2) {
    out[i] = p.min[0] + ((p.q[i] ?? 0) / 65_535) * p.span[0];
    out[i + 1] = p.min[1] + ((p.q[i + 1] ?? 0) / 65_535) * p.span[1];
  }
  return out;
};

export const packIndex = (
  idx: Uint16Array | Uint32Array | null,
  vertCount: number,
): Uint16Array | Uint32Array | null => {
  if (!idx) {
    return null;
  }
  if (idx instanceof Uint16Array || vertCount > 65_535) {
    return idx;
  }
  return Uint16Array.from(idx);
};

const float32Of = (
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): Float32Array => {
  if (attr instanceof THREE.BufferAttribute && attr.array instanceof Float32Array) {
    return attr.array;
  }
  const out = new Float32Array(attr.count * attr.itemSize);
  for (let i = 0; i < attr.count; i += 1) {
    out[i * attr.itemSize] = attr.getX(i);
    if (attr.itemSize > 1) {
      out[i * attr.itemSize + 1] = attr.getY(i);
    }
    if (attr.itemSize > 2) {
      out[i * attr.itemSize + 2] = attr.getZ(i);
    }
  }
  return out;
};

/** Quantize a Float32 geometry's attributes. Normals are computed here when
 *  the geometry has none, so every packed record carries them. */
export const packGeometry = (geo: THREE.BufferGeometry): PackedGeometry => {
  const pos = geo.getAttribute("position");
  if (!pos) {
    throw new Error("packGeometry: geometry has no position attribute");
  }
  if (!geo.getAttribute("normal")) {
    geo.computeVertexNormals();
  }
  const nor = geo.getAttribute("normal");
  const uv = geo.getAttribute("uv");
  const col = geo.getAttribute("color");
  const uvArr = uv ? float32Of(uv) : null;
  const idx = geo.index;
  // SAFETY: BufferAttribute.array only remembers TypedArray; the geometries
  // packed here (merged chunks, terrain tiles) index with Uint16/Uint32.
  const index = idx ? (idx.array as Uint16Array | Uint32Array) : null;
  return {
    col: col ? qCol(float32Of(col)) : null,
    index: packIndex(index, pos.count),
    nor: qNor(float32Of(nor)),
    pos: qPos(float32Of(pos)),
    uv: uvArr && !allZero(uvArr) ? qUv(uvArr) : null,
  };
};

/** The GPU-side geometry: normalized integer attributes, no Float32 copies. */
export const buildPackedGeometry = (p: PackedGeometry): THREE.BufferGeometry => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(p.pos.q, 3, true));
  geo.setAttribute("normal", new THREE.BufferAttribute(p.nor, 3, true));
  if (p.uv) {
    geo.setAttribute("uv", new THREE.BufferAttribute(dqUv(p.uv), 2));
  }
  if (p.col) {
    geo.setAttribute("color", new THREE.BufferAttribute(p.col, 3, true));
  }
  if (p.index) {
    geo.setIndex(new THREE.BufferAttribute(p.index, 1));
  }
  return geo;
};

/** A constant vertex colour in the same Uint8 encoding the packed records use. */
export const constantColorAttribute = (
  count: number,
  color: THREE.Color,
): THREE.BufferAttribute => {
  const col = new Uint8Array(count * 3);
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  for (let i = 0; i < col.length; i += 3) {
    col[i] = r;
    col[i + 1] = g;
    col[i + 2] = b;
  }
  return new THREE.BufferAttribute(col, 3, true);
};

/** Seat a mesh built by buildPackedGeometry in its bounding-box frame. */
export const seatPackedMesh = (mesh: THREE.Object3D, p: QPos): void => {
  mesh.position.set(p.min[0], p.min[1], p.min[2]);
  mesh.scale.set(p.span[0], p.span[1], p.span[2]);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
};

/** Multiplier that turns a normalized attribute's raw integers into its
 *  float values — what three's getX applies, for callers on a hot loop. */
export const normalizedScale = (attr: THREE.BufferAttribute): number => {
  if (!attr.normalized) {
    return 1;
  }
  const a = attr.array;
  if (a instanceof Uint16Array) {
    return 1 / 65_535;
  }
  if (a instanceof Int16Array) {
    return 1 / 32_767;
  }
  if (a instanceof Uint8Array) {
    return 1 / 255;
  }
  if (a instanceof Int8Array) {
    return 1 / 127;
  }
  if (a instanceof Uint32Array) {
    return 1 / 4_294_967_295;
  }
  if (a instanceof Int32Array) {
    return 1 / 2_147_483_647;
  }
  return 1;
};
