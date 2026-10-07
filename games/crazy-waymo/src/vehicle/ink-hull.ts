import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

// Inverted-hull ink outlines for the hero vehicles (toon pass, 2026-10): a
// back-face shell around every body mesh, pushed out along its SMOOTHED normal
// in clip space by a constant number of pixels, drawn in the same plum ink as
// the post pass. The post ink (render/post.ts) already rings every silhouette
// on desktop; the hull is what gives the cars their chunkier toy-sticker line
// — and the only outline phones get, since they skip the post chain.
//
// Smoothed normals: the kit and generated bodies are flat-shaded low-poly, so
// their own normals split at every crease and a shell pushed along them tears
// open at the corners. The hull welds the positions (normals and uvs dropped
// first, or nothing welds) and recomputes vertex normals, once per source
// geometry. Cosmetic only: a body whose geometry cannot be welded just goes
// without a hull rather than failing the car build.

// Line width in drawing-buffer pixels at 1080 rows; scales with resolution.
const HULL_PX_1080 = 2.6;
const INK = 0x1b_14_28;

const hullGeometry = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
const res = new THREE.Vector2(1920, 1080);

const hullOf = (geo: THREE.BufferGeometry): THREE.BufferGeometry => {
  const cached = hullGeometry.get(geo);
  if (cached) {
    return cached;
  }
  // Plain float positions: the GLBs arrive interleaved and/or quantized, and
  // mergeVertices can only rebuild a flat attribute.
  const src = geo.getAttribute("position");
  const flat = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i += 1) {
    flat[i * 3] = src.getX(i);
    flat[i * 3 + 1] = src.getY(i);
    flat[i * 3 + 2] = src.getZ(i);
  }
  const bare = new THREE.BufferGeometry();
  bare.setAttribute("position", new THREE.BufferAttribute(flat, 3));
  if (geo.index) {
    bare.setIndex(geo.index.clone());
  }
  const welded = mergeVertices(bare, 1e-4);
  welded.computeVertexNormals();
  welded.computeBoundingSphere();
  hullGeometry.set(geo, welded);
  return welded;
};

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const HULL_VERTEX = /* glsl */ `
uniform vec2 uRes;
uniform float uWidth;
void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vec2 dir = (projectionMatrix * vec4(n, 0.0)).xy;
  float len = length(dir);
  if (len > 1e-5) {
    clip.xy += dir / len * uWidth * clip.w * 2.0 / uRes;
  }
  gl_Position = clip;
}
`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const HULL_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
  #include <colorspace_fragment>
}
`;

let shared: THREE.ShaderMaterial | null = null;

const hullMaterial = (): THREE.ShaderMaterial => {
  if (!shared) {
    shared = new THREE.ShaderMaterial({
      fragmentShader: HULL_FRAGMENT,
      name: "ink-hull",
      side: THREE.BackSide,
      uniforms: {
        uColor: { value: new THREE.Color(INK) },
        uRes: { value: res },
        uWidth: { value: HULL_PX_1080 },
      },
      vertexShader: HULL_VERTEX,
    });
  }
  return shared;
};

// One resolution write per frame is plenty; every hull shares the uniform.
const syncRes = (renderer: THREE.WebGLRenderer): void => {
  renderer.getDrawingBufferSize(res);
  const width = shared?.uniforms.uWidth;
  if (width) {
    width.value = Math.max(1.5, HULL_PX_1080 * (res.y / 1080));
  }
};

const HULL_NAME = "ink-hull";

/** Add an ink hull under every opaque mesh in `root`. Idempotent per mesh. */
export const addInkHulls = (root: THREE.Object3D): void => {
  const targets: THREE.Mesh[] = [];
  root.traverse((c) => {
    if (
      c instanceof THREE.Mesh &&
      c.name !== HULL_NAME &&
      !(c instanceof THREE.SkinnedMesh) &&
      !Array.isArray(c.material) &&
      c.material instanceof THREE.MeshStandardMaterial &&
      !c.material.transparent &&
      !c.children.some((k) => k.name === HULL_NAME)
    ) {
      targets.push(c);
    }
  });
  for (const mesh of targets) {
    let geo: THREE.BufferGeometry;
    try {
      geo = hullOf(mesh.geometry);
    } catch (error) {
      console.warn("[ink-hull] skipped", mesh.name, error);
      continue;
    }
    const hull = new THREE.Mesh(geo, hullMaterial());
    hull.name = HULL_NAME;
    hull.castShadow = false;
    hull.receiveShadow = false;
    hull.onBeforeRender = syncRes;
    mesh.add(hull);
  }
};
