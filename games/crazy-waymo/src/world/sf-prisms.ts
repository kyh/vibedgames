import * as THREE from "three";

// The downtown fabric: real footprint rings extruded as flat-shaded prisms.
// This is deliberately the licensed model's own look (monolithic massing, the
// actual lot pattern) rendered in the game's palette — kit boxes stretched to
// bboxes never read as SF (see tools/sf-data/extract-footprints.mjs).

// Entry format from sf-footprints.ts: [height, x0, z0, x1, z1, ...] CCW ring.

export type PrismSpec = {
  readonly cx: number;
  readonly cz: number;
  readonly h: number;
  /** ring points relative to (cx, cz): [dx0, dz0, dx1, dz1, ...] */
  readonly rel: readonly number[];
};

export function prismSpec(flat: readonly number[]): PrismSpec | null {
  const h = flat[0] ?? 0;
  const n = (flat.length - 1) / 2;
  if (h <= 0 || n < 3) return null;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += flat[1 + i * 2] ?? 0;
    cz += flat[2 + i * 2] ?? 0;
  }
  cx /= n;
  cz /= n;
  const rel: number[] = [];
  for (let i = 0; i < n; i++) {
    rel.push((flat[1 + i * 2] ?? 0) - cx, (flat[2 + i * 2] ?? 0) - cz);
  }
  return { cx, cz, h, rel };
}

// Extruded prism, centered on the centroid, top at y=h. `sink` extends the
// walls below y=0 (hillside foundation — fills the downhill gap a highest-
// corner seat leaves open).
export function prismGeometry(spec: PrismSpec, sink = 0): THREE.BufferGeometry {
  const n = spec.rel.length / 2;
  // Shape plane → world: rotateX(-90°) maps (sx, sy, sz) → (sx, sz, -sy),
  // so shape.x = dx and shape.y = -dz. World-CCW rings need reversing to
  // stay CCW in shape space (the y negation mirrors them).
  const pts: THREE.Vector2[] = [];
  for (let i = n - 1; i >= 0; i--) {
    pts.push(new THREE.Vector2(spec.rel[i * 2] ?? 0, -(spec.rel[i * 2 + 1] ?? 0)));
  }
  const shape = new THREE.Shape(pts);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: spec.h + sink,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  if (sink > 0) geo.translate(0, -sink, 0);
  return geo;
}

// Shared facade materials by height class — few materials keep the batcher's
// draw-call count down; variety comes from picking within the class.
function facade(color: number, roughness = 1, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}
export const PRISM_GLASS: readonly THREE.MeshStandardMaterial[] = [
  facade(0x9fb6c4, 0.55, 0.18),
  facade(0x8fa8bd, 0.55, 0.18),
  facade(0xafc2cc, 0.55, 0.18),
  facade(0x93a5b6, 0.55, 0.18),
];
export const PRISM_MID: readonly THREE.MeshStandardMaterial[] = [
  facade(0xcfc7b8),
  facade(0xbfb4a4),
  facade(0xc9b8a6),
  facade(0xd8cfc0),
  facade(0xa8a29a),
  facade(0xa8624e), // brick
  facade(0xb9aea6),
];
export const PRISM_LOW: readonly THREE.MeshStandardMaterial[] = [
  facade(0xe8e2d4), // SF white
  facade(0xd9a08c), // salmon
  facade(0xa9b89a), // sage
  facade(0x9fb8c4), // sky
  facade(0xd4b06a), // mustard
  facade(0xd8b8a8),
  facade(0xc4b49c),
  facade(0xcfd2c8),
];

export function prismMaterialsFor(h: number): readonly THREE.MeshStandardMaterial[] {
  return h > 32 ? PRISM_GLASS : h > 10 ? PRISM_MID : PRISM_LOW;
}
