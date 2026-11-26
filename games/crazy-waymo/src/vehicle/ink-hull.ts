import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { isMesh } from "../shared/three-guards";

export const HULL_PX_HERO = 3.2;
const HULL_PX_FLEET = 2.2;
const HULL_FULL_REACH = 40;
const HULL_FADE_START = 110;
const HULL_FADE_END = 170;
const INK = 0x1b_14_28;

const hullGeometry = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
const parametricHulls = new Map<string, THREE.BufferGeometry>();
const res = new THREE.Vector2(1920, 1080);

const parametricKey = (geo: THREE.BufferGeometry) => {
  const params: unknown = "parameters" in geo ? geo.parameters : null;

  return params !== null && params !== undefined && geo.type !== "BufferGeometry"
    ? `${geo.type}:${JSON.stringify(params)}`
    : null;
};

const boundaryRatio = (geo: THREE.BufferGeometry) => {
  const { index } = geo;

  if (!index || index.count < 3) {
    return 1;
  }

  const uses = new Map<number, number>();
  const verts = geo.getAttribute("position").count;

  const edge = (a: number, b: number) => {
    const key = a < b ? a * verts + b : b * verts + a;
    uses.set(key, (uses.get(key) ?? 0) + 1);
  };

  for (let i = 0; i + 2 < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    edge(a, b);
    edge(b, c);
    edge(c, a);
  }

  let open = 0;

  for (const n of uses.values()) {
    if (n === 1) {
      open += 1;
    }
  }

  return uses.size === 0 ? 1 : open / uses.size;
};

const hullOf = (geo: THREE.BufferGeometry) => {
  const key = parametricKey(geo);

  const cached =
    hullGeometry.get(geo) ?? (key !== null && key !== "" ? parametricHulls.get(key) : undefined);

  if (cached) {
    return cached;
  }

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
  welded.userData.boundaryRatio = boundaryRatio(welded);
  welded.computeBoundingSphere();
  hullGeometry.set(geo, welded);

  if (key !== null && key !== "") {
    parametricHulls.set(key, welded);
  }

  return welded;
};

const HULL_VERTEX = `
#include <common>
#include <batching_pars_vertex>
uniform vec2 uRes;
uniform float uWidth;
void main() {
  #include <batching_vertex>
  vec4 local = vec4(position, 1.0);
  vec3 objectNormal = normal;
  #ifdef USE_BATCHING
    local = batchingMatrix * local;
    objectNormal = mat3(batchingMatrix) * objectNormal;
  #endif
  vec4 clip = projectionMatrix * modelViewMatrix * local;
  vec3 n = normalize(normalMatrix * objectNormal);
  // Normal direction in PIXELS, so the stroke is round on any aspect.
  vec2 dirPx = (projectionMatrix * vec4(n, 0.0)).xy * uRes;
  float len = length(dirPx);
  float px = uWidth * (uRes.y / 1080.0)
    * min(1.0, ${HULL_FULL_REACH.toFixed(1)} / max(clip.w, 1e-3))
    * (1.0 - smoothstep(${HULL_FADE_START.toFixed(1)}, ${HULL_FADE_END.toFixed(1)}, clip.w));
  if (len > 1e-5) {
    clip.xy += dirPx / len * px * 2.0 / uRes * clip.w;
  }
  gl_Position = clip;
}
`;

const HULL_FRAGMENT = `
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
  #include <colorspace_fragment>
}
`;

const materials = new Map<number, THREE.ShaderMaterial>();

const hullMaterial = (widthPx: number) => {
  let mat = materials.get(widthPx);

  if (!mat) {
    mat = new THREE.ShaderMaterial({
      fragmentShader: HULL_FRAGMENT,
      name: "ink-hull",
      side: THREE.BackSide,
      uniforms: {
        uColor: { value: new THREE.Color(INK) },
        uRes: { value: res },
        uWidth: { value: widthPx },
      },
      vertexShader: HULL_VERTEX,
    });
    materials.set(widthPx, mat);
  }

  return mat;
};

const syncRes = (renderer: THREE.WebGLRenderer) => {
  renderer.getDrawingBufferSize(res);
};

const HULL_NAME = "ink-hull";

const MAX_OPEN_EDGES = 0.04;

const wantsHull = (mat: THREE.Material) =>
  mat instanceof THREE.MeshStandardMaterial && !mat.transparent && mat.side !== THREE.BackSide;

const linedHull = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
  if (!wantsHull(mat)) {
    return null;
  }

  try {
    const hull = hullOf(geo);
    const open = Number(hull.userData.boundaryRatio ?? 1);

    return mat.side === THREE.DoubleSide && open > MAX_OPEN_EDGES ? null : hull;
  } catch (error) {
    console.warn("[ink-hull] skipped", error);

    return null;
  }
};

/** Add an ink hull under every lined mesh in `root`. Idempotent per mesh. */
export const addInkHulls = (root: THREE.Object3D, widthPx = HULL_PX_HERO) => {
  const targets: THREE.Mesh[] = [];
  root.traverse((c) => {
    if (
      isMesh(c) &&
      c.name !== HULL_NAME &&
      !(c instanceof THREE.SkinnedMesh) &&
      !Array.isArray(c.material) &&
      !c.children.some((k) => k.name === HULL_NAME)
    ) {
      targets.push(c);
    }
  });

  for (const mesh of targets) {
    const { material } = mesh;
    const geo = Array.isArray(material) ? null : linedHull(mesh.geometry, material);

    if (!geo) {
      continue;
    }

    const hull = new THREE.Mesh(geo, hullMaterial(widthPx));
    hull.name = HULL_NAME;
    hull.castShadow = false;
    hull.receiveShadow = false;
    hull.onBeforeRender = syncRes;
    mesh.add(hull);
  }
};

/** One mesh part of a batched fleet model (traffic.ts). Parked cars carry no
 *  hull: ~12.7k part instances would double their culling, and the desktop
 *  post ink already rings them (phones see them small and static). */
interface FleetTemplatePart {
  readonly geo: THREE.BufferGeometry;
  readonly mat: THREE.Material;
  readonly local: THREE.Matrix4;
}

/** A hull BatchedMesh for a batched fleet. Its instances ride in the fleet's
 *  own part lists, so the existing setMatrixAt / setVisibleAt code moves and
 *  hides them with the car — no second bookkeeping path. */
export interface HullBatch {
  readonly batch: THREE.BatchedMesh;
  readonly ids: ReadonlyMap<THREE.BufferGeometry, number>;
}

/** Size and fill one hull batch for every part the fleet will place. */
export const createHullBatch = (parts: Iterable<FleetTemplatePart>) => {
  const welded = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  let instances = 0;
  let verts = 0;
  let indices = 0;

  for (const p of parts) {
    const hull = linedHull(p.geo, p.mat);

    if (!hull) {
      continue;
    }

    instances += 1;

    if (!welded.has(p.geo)) {
      welded.set(p.geo, hull);
      verts += hull.getAttribute("position").count;
      indices += hull.index?.count ?? 0;
    }
  }

  if (welded.size === 0) {
    return null;
  }

  const batch = new THREE.BatchedMesh(
    instances,
    verts,
    Math.max(indices, 3),
    hullMaterial(HULL_PX_FLEET),
  );

  batch.name = HULL_NAME;
  batch.castShadow = false;
  batch.receiveShadow = false;
  batch.frustumCulled = false;
  batch.onBeforeRender = syncRes;
  const ids = new Map<THREE.BufferGeometry, number>();

  for (const [src, hull] of welded) {
    ids.set(src, batch.addGeometry(hull));
  }

  return { batch, ids };
};

/** Hull instances for one placed car: one per lined part, stamped at
 *  `carMatrix` when given. Returned in the fleet's part shape so the caller
 *  just appends them to the car's slots. */
export const placeHulls = (
  hulls: HullBatch | null,
  parts: readonly FleetTemplatePart[],
  carMatrix?: THREE.Matrix4,
) => {
  const out: { batch: THREE.BatchedMesh; instanceId: number; local: THREE.Matrix4 }[] = [];

  if (!hulls) {
    return out;
  }

  for (const p of parts) {
    const geometryId = linedHull(p.geo, p.mat) ? hulls.ids.get(p.geo) : undefined;

    if (geometryId === undefined) {
      continue;
    }

    const instanceId = hulls.batch.addInstance(geometryId);

    if (carMatrix) {
      hulls.batch.setMatrixAt(instanceId, PLACE_M4.multiplyMatrices(carMatrix, p.local));
    }

    out.push({ batch: hulls.batch, instanceId, local: p.local });
  }

  return out;
};

const PLACE_M4 = new THREE.Matrix4();
