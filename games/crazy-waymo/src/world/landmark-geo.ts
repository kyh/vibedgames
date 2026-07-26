import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Shared geometry kit for the landmark set (see landmarks.ts).
//
// Landmarks are rebuilt live on every load and are NOT part of the batching /
// merge pipeline the rest of the city goes through, so a monument's draw-call
// cost is exactly the number of DISTINCT materials it touches — `packLandmark`
// merges everything else away. Build new monuments out of THIS palette; a
// one-off material is a permanent extra draw call.

/** The whole landmark palette. Anything drawn with one of these is packable. */
export const MAT = {
  orange: new THREE.MeshStandardMaterial({ color: 0xc0362c, roughness: 0.6 }),
  // Landmark white is NOT paper white. At 0xeceff2 it measured within a few
  // points of the noon sky, so the Pyramid, Coit and the Cliff House had no
  // silhouette from any distance — the one thing a beacon may not lack. This
  // is a warm off-white that still reads as "white building" up close and
  // holds a value edge against the sky band.
  white: new THREE.MeshStandardMaterial({ color: 0xd8dae0, roughness: 0.7 }),
  cream: new THREE.MeshStandardMaterial({ color: 0xe6dcc4, roughness: 0.75 }),
  glass: new THREE.MeshStandardMaterial({ color: 0xbfd4dd, roughness: 0.25, metalness: 0.5 }),
  // Deeper glass for the big towers — the pale `glass` + distance fog read as
  // a featureless beam of sky.
  towerGlass: new THREE.MeshStandardMaterial({
    color: 0x7d9cb2,
    roughness: 0.4,
    metalness: 0.35,
  }),
  steel: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.5, metalness: 0.4 }),
  gateRed: new THREE.MeshStandardMaterial({ color: 0xb5382e, roughness: 0.6 }),
  gateGreen: new THREE.MeshStandardMaterial({ color: 0x3e7d54, roughness: 0.6 }),
  rock: new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 1 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd6a943, roughness: 0.32, metalness: 0.7 }),
  /** Oxidised copper — City Hall's dome shell. */
  patina: new THREE.MeshStandardMaterial({ color: 0x4f8a72, roughness: 0.7, metalness: 0.2 }),
  /** Warm brown copper cladding — the de Young. */
  copper: new THREE.MeshStandardMaterial({ color: 0x996337, roughness: 0.8, metalness: 0.15 }),
  brick: new THREE.MeshStandardMaterial({ color: 0x9c5f45, roughness: 0.95 }),
  hedge: new THREE.MeshStandardMaterial({ color: 0x3f6d3a, roughness: 1 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0xb2b1a8, roughness: 1 }),
  slate: new THREE.MeshStandardMaterial({ color: 0x51565c, roughness: 0.9 }),
  /** Still ornamental water — the Palace lagoon, the flooded Sutro basins. */
  lagoon: new THREE.MeshStandardMaterial({ color: 0x2f6d86, roughness: 0.15, metalness: 0.2 }),
  /** Ballpark turf. */
  field: new THREE.MeshStandardMaterial({ color: 0x4f8f45, roughness: 1 }),
  // Lamps are light SOURCES: unlit + untonemapped, like the traffic signals,
  // so they hold up as beacons after dark instead of dimming with the scene.
  lamp: new THREE.MeshBasicMaterial({ color: 0xffeec4, toneMapped: false }),
} as const;

const PACKABLE: ReadonlySet<THREE.Material> = new Set<THREE.Material>(Object.values(MAT));

export function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Axis-aligned block, optionally yawed about its own centre. */
export function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  yaw = 0,
): THREE.Mesh {
  const m = mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  m.rotation.y = yaw;
  return m;
}

/**
 * Flat-shade a primitive in place.
 *
 * three's cone/cylinder builders average their vertex normals AROUND the ring,
 * which is right for a 24-sided pipe and wrong for everything the landmark kit
 * uses them for: a 4-sided `ConeGeometry` is a PYRAMID, and smooth ring normals
 * shade it as a rounded horn with no visible edges. That is exactly why the
 * Transamerica read as "a smooth white cone" instead of the city's most
 * recognisable four-faced silhouette. Anything whose faces are meant to be seen
 * as faces goes through here.
 */
export function facet(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = geo.index === null ? geo : geo.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

/** Upright cylinder / truncated cone, seated by its CENTRE like every other
 *  three primitive. */
export function cyl(
  rTop: number,
  rBot: number,
  h: number,
  seg: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  return mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat, x, y, z);
}

/** Shallow dome: the top of a sphere, squashed to `h` tall, sitting on y. */
export function dome(
  r: number,
  h: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  seg = 18,
): THREE.Mesh {
  const m = mesh(
    new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1), 0, Math.PI * 2, 0, Math.PI / 2),
    mat,
    x,
    y,
    z,
  );
  m.scale.set(1, h / r, 1);
  return m;
}

/** A member spanning two points (cable, brace, strut). */
export function strut(
  a: THREE.Vector3,
  b: THREE.Vector3,
  r: number,
  mat: THREE.Material,
  seg = 6,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length() || 0.001;
  const m = mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.divideScalar(len));
  return m;
}

/**
 * Ring / arc of identical uprights (peristyles, stadium bowls, parapets).
 * `deg0`/`sweep` are degrees measured clockwise from due north (−Z), matching
 * how the rest of the world talks about bearings; `cb` receives the local
 * point and the tangent yaw so callers can face pieces along the arc.
 */
export function arc(
  count: number,
  radius: number,
  deg0: number,
  sweep: number,
  cb: (x: number, z: number, yaw: number, i: number) => void,
): void {
  for (let i = 0; i < count; i++) {
    const a = THREE.MathUtils.degToRad(deg0 + (sweep * (i + 0.5)) / count);
    cb(Math.sin(a) * radius, -Math.cos(a) * radius, -a, i);
  }
}

/**
 * Collapse a freshly built monument to one mesh per shared material: every
 * packable mesh's geometry is baked into the group's local space and merged.
 * Kit-model instances (their materials are per-instance clones) are left
 * alone. Call it BEFORE the group is positioned in the world so the merge
 * happens around the monument's own origin and it still frustum-culls as one
 * compact object.
 *
 * `extra` admits a monument's own SHARED materials (one per Painted Lady, say)
 * into the pack. They still cost one draw call each — the rule is that a
 * material must be reused across the monument to earn its keep, not that only
 * `MAT` may be used.
 */
export function packLandmark(src: THREE.Group, extra?: Iterable<THREE.Material>): THREE.Group {
  const packable = extra ? new Set<THREE.Material>([...PACKABLE, ...extra]) : PACKABLE;
  src.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const packed: THREE.Mesh[] = [];
  src.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = o.material;
    if (Array.isArray(mat) || !packable.has(mat)) return;
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const list = buckets.get(mat);
    if (list) list.push(geo);
    else buckets.set(mat, [geo]);
    packed.push(o);
  });
  for (const m of packed) m.removeFromParent();
  for (const [mat, list] of buckets) {
    const first = list[0];
    if (!first) continue;
    // mergeGeometries rejects a mix of indexed and non-indexed inputs (the
    // polyhedron primitives are non-indexed) — level them first.
    const geos = list.every((g) => g.index !== null)
      ? list
      : list.map((g) => (g.index === null ? g : g.toNonIndexed()));
    const merged = geos.length === 1 ? first : mergeGeometries(geos, false);
    if (!merged) {
      for (const g of geos) src.add(mesh(g, mat));
      continue;
    }
    src.add(mesh(merged, mat));
  }
  return src;
}
