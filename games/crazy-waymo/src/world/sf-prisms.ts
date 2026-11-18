import * as THREE from "three";

export interface PrismSpec {
  readonly cx: number;
  readonly cz: number;
  readonly h: number;
  /** ring points relative to (cx, cz): [dx0, dz0, dx1, dz1, ...] */
  readonly rel: readonly number[];
}

export const prismSpec = (flat: readonly number[]) => {
  const h = flat[0] ?? 0;
  const n = (flat.length - 1) / 2;

  if (h <= 0 || n < 3) {
    return null;
  }

  let cx = 0;
  let cz = 0;

  for (let i = 0; i < n; i += 1) {
    cx += flat[1 + i * 2] ?? 0;
    cz += flat[2 + i * 2] ?? 0;
  }

  cx /= n;
  cz /= n;
  const rel: number[] = [];

  for (let i = 0; i < n; i += 1) {
    rel.push((flat[1 + i * 2] ?? 0) - cx, (flat[2 + i * 2] ?? 0) - cz);
  }

  return { cx, cz, h, rel };
};

export const prismGeometry = (spec: PrismSpec, sink = 0) => {
  const n = spec.rel.length / 2;
  const pts: THREE.Vector2[] = [];

  for (let i = n - 1; i >= 0; i -= 1) {
    pts.push(new THREE.Vector2(spec.rel[i * 2] ?? 0, -(spec.rel[i * 2 + 1] ?? 0)));
  }

  const outline = new THREE.Shape(pts);

  const geo = new THREE.ExtrudeGeometry(outline, {
    bevelEnabled: false,
    curveSegments: 1,
    depth: spec.h + sink,
  });

  geo.rotateX(-Math.PI / 2);

  if (sink > 0) {
    geo.translate(0, -sink, 0);
  }

  return geo;
};

const facade = (color: number, roughness = 1, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness });

export const PRISM_GLASS: readonly THREE.MeshStandardMaterial[] = [
  facade(0x9f_b6_c4, 0.55, 0.18),
  facade(0x8f_a8_bd, 0.55, 0.18),
  facade(0xaf_c2_cc, 0.55, 0.18),
  facade(0x93_a5_b6, 0.55, 0.18),
];

export const PRISM_MID: readonly THREE.MeshStandardMaterial[] = [
  facade(0xcf_c7_b8),
  facade(0xbf_b4_a4),
  facade(0xc9_b8_a6),
  facade(0xd8_cf_c0),
  facade(0xa8_a2_9a),
  facade(0xa8_62_4e),
  facade(0xb9_ae_a6),
];

export const PRISM_LOW: readonly THREE.MeshStandardMaterial[] = [
  facade(0xe8_e2_d4),
  facade(0xd9_a0_8c),
  facade(0xa9_b8_9a),
  facade(0x9f_b8_c4),
  facade(0xd4_b0_6a),
  facade(0xd8_b8_a8),
  facade(0xc4_b4_9c),
  facade(0xcf_d2_c8),
];

export const prismMaterialsFor = (h: number) => {
  if (h > 32) {
    return PRISM_GLASS;
  }

  return h > 10 ? PRISM_MID : PRISM_LOW;
};
