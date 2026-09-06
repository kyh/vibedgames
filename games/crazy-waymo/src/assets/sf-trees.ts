import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Reference: art/trees/reference.png. These are shared source templates, built
// once by ModelCache, then cloned/batched by the existing world streamer.
// Preserve one mesh and the source GLBs' node transforms: baked instance
// records address that mesh by index and already contain its transform.
export type SfTreeKind = "cypress" | "broadleaf";

type Crown = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
};

type Point = readonly [number, number, number];

const CYPRESS_CROWNS: readonly Crown[] = [
  { x: -0.2, y: 0.13, z: 0.035, rx: 0.23, ry: 0.13, rz: 0.23 },
  { x: 0.17, y: 0.4, z: 0.01, rx: 0.26, ry: 0.14, rz: 0.23 },
  { x: -0.17, y: 0.57, z: -0.04, rx: 0.21, ry: 0.13, rz: 0.21 },
  { x: 0.06, y: 0.77, z: 0.02, rx: 0.31, ry: 0.23, rz: 0.27 },
  { x: 0.22, y: 0.7, z: -0.08, rx: 0.19, ry: 0.15, rz: 0.2 },
];
const BROADLEAF_CROWNS: readonly Crown[] = [
  { x: -0.18, y: 0.25, z: 0.02, rx: 0.28, ry: 0.39, rz: 0.29 },
  { x: 0.18, y: 0.23, z: 0.04, rx: 0.29, ry: 0.4, rz: 0.3 },
  { x: -0.08, y: 0.57, z: -0.13, rx: 0.29, ry: 0.32, rz: 0.25 },
  { x: 0.04, y: 0.63, z: 0.08, rx: 0.32, ry: 0.37, rz: 0.3 },
  { x: 0.25, y: 0.57, z: -0.035, rx: 0.23, ry: 0.3, rz: 0.24 },
];

const LEAF_SHADE = new THREE.Color(0x345d43);
const LEAF_SUN = new THREE.Color(0x9cab58);
const BARK_SHADE = new THREE.Color(0x574338);
const BARK_SUN = new THREE.Color(0x997751);
const Y = new THREE.Vector3(0, 1, 0);

function leafTexture(): THREE.DataTexture {
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x - 16) / 112) * 9;
      const v = (y / size) * 7;
      const row = Math.floor(v);
      const col = Math.floor(u + (row % 2) * 0.5);
      const seed = Math.sin(col * 127.1 + row * 311.7) * 43758.5453;
      const variation = seed - Math.floor(seed);
      const dx = u + (row % 2) * 0.5 - col - 0.5;
      const dy = v - row - 0.5;
      const leaflet = 1 - THREE.MathUtils.smoothstep(dx * dx * 4.2 + dy * dy * 2.8, 0.03, 0.65);
      const shade = x < 16 ? 255 : Math.round((0.8 + leaflet * 0.13 + variation * 0.07) * 255);
      const i = (y * size + x) * 4;
      pixels[i] = shade;
      pixels[i + 1] = shade;
      pixels[i + 2] = shade;
      pixels[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const LEAF_TEXTURE = leafTexture();

function paint(geometry: THREE.BufferGeometry, foliage: boolean, seed: number): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const colors = new Float32Array(position.count * 3);
  const tint = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    // Bark samples the atlas's white margin; crown UVs retain the sphere's
    // continuous wrap. Mips settle this small leaf texture at street distance.
    uv.setX(i, foliage ? 0.14 + uv.getX(i) * 0.84 : 0.04);
    if (!foliage) uv.setY(i, 0.5);
    const top = normal.getY(i) * 0.5 + 0.5;
    const variation = Math.sin(position.getX(i) * 22 + position.getZ(i) * 17 + seed) * 0.035;
    tint.lerpColors(
      foliage ? LEAF_SHADE : BARK_SHADE,
      foliage ? LEAF_SUN : BARK_SUN,
      THREE.MathUtils.clamp((foliage ? 0.26 + 0.66 * top : 0.42 + 0.24 * top) + variation, 0, 1),
    );
    colors[i * 3] = tint.r;
    colors[i * 3 + 1] = tint.g;
    colors[i * 3 + 2] = tint.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function branch(start: Point, end: Point, base: number, tip: number): THREE.BufferGeometry {
  const a = new THREE.Vector3(...start);
  const b = new THREE.Vector3(...end);
  const axis = b.clone().sub(a);
  const geometry = new THREE.CylinderGeometry(tip, base, axis.length(), 5, 1, true);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y, axis.normalize()));
  geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  paint(geometry, false, a.y);
  return geometry;
}

function trunk(points: readonly Point[], base: number, tip: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)));
  const rings = 8;
  const sides = 6;
  const geometry = new THREE.TubeGeometry(curve, rings, 1, sides, false);
  const position = geometry.getAttribute("position");
  for (let ring = 0; ring <= rings; ring++) {
    const t = ring / rings;
    const center = curve.getPointAt(t);
    const radius = THREE.MathUtils.lerp(base, tip, t);
    for (let side = 0; side <= sides; side++) {
      const i = ring * (sides + 1) + side;
      position.setXYZ(
        i,
        center.x + (position.getX(i) - center.x) * radius,
        center.y + (position.getY(i) - center.y) * radius,
        center.z + (position.getZ(i) - center.z) * radius,
      );
    }
  }
  geometry.computeVertexNormals();
  paint(geometry, false, 0);
  return geometry;
}

export function createSfTreeModel(kind: SfTreeKind): THREE.Group {
  const pieces: THREE.BufferGeometry[] = [];
  const crowns = kind === "cypress" ? CYPRESS_CROWNS : BROADLEAF_CROWNS;
  if (kind === "cypress") {
    pieces.push(
      trunk(
        [
          [0, -1, 0],
          [0.08, -0.67, 0.02],
          [-0.075, -0.23, 0],
          [0.035, 0.75, 0.02],
        ],
        0.082,
        0.014,
      ),
    );
    pieces.push(branch([-0.03, -0.08, 0], [-0.2, 0.1, 0.035], 0.035, 0.012));
    pieces.push(branch([-0.02, 0.1, 0.01], [0.17, 0.37, 0.01], 0.033, 0.011));
    pieces.push(branch([0.02, 0.38, 0.02], [-0.17, 0.54, -0.04], 0.025, 0.01));
  } else {
    pieces.push(
      trunk(
        [
          [0, -1, 0],
          [-0.035, -0.28, 0.005],
          [0.05, 0.65, 0.04],
        ],
        0.074,
        0.013,
      ),
    );
    pieces.push(branch([-0.03, -0.2, 0], [-0.19, 0.27, 0.01], 0.032, 0.012));
    pieces.push(branch([-0.02, -0.12, 0], [0.19, 0.29, 0.02], 0.03, 0.011));
  }
  for (const [i, crown] of crowns.entries()) {
    const geometry = new THREE.SphereGeometry(1, 10, 5);
    geometry.scale(crown.rx, crown.ry, crown.rz);
    geometry.rotateY(i * 0.77);
    geometry.translate(crown.x, crown.y, crown.z);
    paint(geometry, true, i * 1.7);
    pieces.push(geometry);
  }
  const geometry = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  if (!geometry) throw new Error("SF tree geometry layouts must agree");
  geometry.scale(1.3, 1, 1.2);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) throw new Error("SF tree geometry must have bounds");
  const yScale = 2 / (bounds.max.y - bounds.min.y);
  const yOffset = -1 - bounds.min.y * yScale;
  geometry.scale(1, yScale, 1);
  geometry.translate(0, yOffset, 0);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    map: LEAF_TEXTURE,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });
  material.name = "sf-tree-foliage-bark";
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = kind === "cypress" ? "tree-large" : "tree-small";
  // Match the original mesh-local Y -1..1 and glTF node transforms. Existing
  // world records stay seated even before the next world bake finishes.
  const sourceScale = kind === "cypress" ? 0.38349997997283936 : 0.2835000157356262;
  mesh.position.y = sourceScale;
  mesh.scale.setScalar(sourceScale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.name = `sf-${kind}`;
  group.add(mesh);
  return group;
}
