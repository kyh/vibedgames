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
//
// Width is authored in pixels at 1080 rows and extruded in PIXEL space (the
// clip-space normal is scaled by the viewport before it is normalised, so a
// wide canvas doesn't skew the stroke). Past HULL_FULL_REACH it thins with
// distance and is gone by HULL_FADE_END — a fixed-pixel line on a car 150u
// away is an ink blob, and the taper lands well before the fog plane, so the
// hull never needs the aerial-fog chunks. Hero bodies (player, remote
// drivers, the garage) take the fat sticker line; the batched traffic and
// parked fleets a lighter one so the hero still owns the frame.

// Line widths in drawing-buffer pixels at 1080 rows; scale with resolution.
export const HULL_PX_HERO = 3.2;
const HULL_PX_FLEET = 2.2;
// Constant-pixel out to here (world units), then perspective-thinning...
const HULL_FULL_REACH = 40;
// ...and faded to nothing across this band.
const HULL_FADE_START = 110;
const HULL_FADE_END = 170;
const INK = 0x1b_14_28;

const hullGeometry = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
// Parametric primitives (the sensor pods, the carstache lobes) are rebuilt
// fresh on every body build — keyed by their parameters instead, so a
// remote-car respawn or a skin swap reuses one welded hull instead of
// leaking a new GPU buffer each time.
const parametricHulls = new Map<string, THREE.BufferGeometry>();
const res = new THREE.Vector2(1920, 1080);

const parametricKey = (geo: THREE.BufferGeometry): string | null => {
  const params: unknown = "parameters" in geo ? geo.parameters : null;
  return params && geo.type !== "BufferGeometry" ? `${geo.type}:${JSON.stringify(params)}` : null;
};

// Share of edges used by only one triangle. A closed shell is ~0; an open
// sheet (a single-plane decal, a thin generated panel) is large.
const boundaryRatio = (geo: THREE.BufferGeometry): number => {
  const { index } = geo;
  if (!index || index.count < 3) {
    return 1;
  }
  const uses = new Map<number, number>();
  const verts = geo.getAttribute("position").count;
  const edge = (a: number, b: number): void => {
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

const hullOf = (geo: THREE.BufferGeometry): THREE.BufferGeometry => {
  const key = parametricKey(geo);
  const cached = hullGeometry.get(geo) ?? (key ? parametricHulls.get(key) : undefined);
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
  welded.userData.boundaryRatio = boundaryRatio(welded);
  welded.computeBoundingSphere();
  hullGeometry.set(geo, welded);
  if (key) {
    parametricHulls.set(key, welded);
  }
  return welded;
};

// Batched fleets (traffic, parked) draw their hulls through a BatchedMesh, so
// the shader takes three's batching chunks: under USE_BATCHING the per-instance
// matrix comes from the batch's matrix texture, otherwise they compile away.
// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const HULL_VERTEX = /* glsl */ `
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

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const HULL_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
  #include <colorspace_fragment>
}
`;

const materials = new Map<number, THREE.ShaderMaterial>();

const hullMaterial = (widthPx: number): THREE.ShaderMaterial => {
  let mat = materials.get(widthPx);
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      fragmentShader: HULL_FRAGMENT,
      name: "ink-hull",
      side: THREE.BackSide,
      uniforms: {
        uColor: { value: new THREE.Color(INK) },
        // shared by every hull material: one viewport
        uRes: { value: res },
        uWidth: { value: widthPx },
      },
      vertexShader: HULL_VERTEX,
    });
    materials.set(widthPx, mat);
  }
  return mat;
};

// Every hull shares the one viewport uniform; the garage preview's own
// renderer rewrites it before its draws, the main renderer before its own.
const syncRes = (renderer: THREE.WebGLRenderer): void => {
  renderer.getDrawingBufferSize(res);
};

const HULL_NAME = "ink-hull";

// A DoubleSide part is lined only when its welded shell is (near) closed:
// the car GLBs export doubleSided on closed bodies, but an OPEN double-sided
// sheet would show its hull's back faces as a solid ink plate from behind.
const MAX_OPEN_EDGES = 0.04;

/** Opaque standard paint only; glass and decals stay unlined. */
const wantsHull = (mat: THREE.Material): boolean =>
  mat instanceof THREE.MeshStandardMaterial && !mat.transparent && mat.side !== THREE.BackSide;

/** The part's hull, or null when it should go unlined (see MAX_OPEN_EDGES). */
const linedHull = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.BufferGeometry | null => {
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
export const addInkHulls = (root: THREE.Object3D, widthPx = HULL_PX_HERO): void => {
  const targets: THREE.Mesh[] = [];
  root.traverse((c) => {
    if (
      c instanceof THREE.Mesh &&
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

/** One mesh part of a batched fleet model (traffic.ts / parked-cars.ts). */
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
export const createHullBatch = (parts: Iterable<FleetTemplatePart>): HullBatch | null => {
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
  // per-instance culling stays on inside
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
): { batch: THREE.BatchedMesh; instanceId: number; local: THREE.Matrix4 }[] => {
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
