import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { PARK_TREES, TREE_LARGE, TREE_SMALL } from "../assets/manifest";
import { inLake } from "./land-class";
import type { ParcelClearance } from "./parcel-clearance";
import { waterBodyContains } from "./water";
import type { WaterBody } from "./water";

interface TreePlacement {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly scaleX: number;
  readonly scaleZ: number;
}
export interface TreeTrunkProfile {
  readonly x: number;
  readonly z: number;
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly minY: number;
  readonly maxY: number;
  readonly rootX: number;
  readonly rootZ: number;
}
export type TreeClearance = (url: string, placement: TreePlacement) => boolean;
export type TreeSourceKind = "sf" | "kaykit";
const SF_FILES = new Set([TREE_LARGE, TREE_SMALL].map((name) => `${name}.glb`));
const PARK_FILES = new Set(
  [...PARK_TREES, "park-base-decorated-trees"].map((name) => `${name}.glb`),
);
const WALL_MARGIN = 0.05;

export const treeSourceKind = (url: string): TreeSourceKind | null => {
  const file = url.slice(url.lastIndexOf("/") + 1);
  if (SF_FILES.has(file)) {
    return "sf";
  }
  return PARK_FILES.has(file) ? "kaykit" : null;
};

/** The authored bark atlas regions: SF's white margin; KayKit's brown strip.
 * Leaves occupy different UV regions. This is checked against every tree source
 * by the artifact audit, so an asset palette change cannot silently lose stems.
 */
const isWood = (kind: TreeSourceKind, u: number, v: number): boolean =>
  kind === "sf" ? u < 0.08 : u > 0.77 && u < 0.83 && v > 0.07 && v < 0.25;

interface WeldSet {
  readonly points: THREE.Vector3[];
  readonly parents: number[];
  readonly welded: Map<string, number>;
}

const weldRoot = (parents: readonly number[], start: number): number => {
  let current = start;
  for (;;) {
    const next = parents[current];
    if (next === undefined || next === current) {
      return current;
    }
    current = next;
  }
};

/** Weld one mesh's bark vertices by position and union its bark triangles. */
const weldMeshWood = (set: WeldSet, mesh: THREE.Mesh, kind: TreeSourceKind): void => {
  mesh.updateWorldMatrix(true, false);
  const positions = mesh.geometry.getAttribute("position");
  const uv = mesh.geometry.getAttribute("uv");
  if (!uv) {
    return;
  }
  const ids = new Int32Array(positions.count).fill(-1);
  for (let i = 0; i < positions.count; i += 1) {
    if (!isWood(kind, uv.getX(i), uv.getY(i))) {
      continue;
    }
    const point = new THREE.Vector3()
      .fromBufferAttribute(positions, i)
      .applyMatrix4(mesh.matrixWorld);
    const key = `${Math.round(point.x * 1e5)},${Math.round(point.y * 1e5)},${Math.round(point.z * 1e5)}`;
    let id = set.welded.get(key);
    if (id === undefined) {
      id = set.points.length;
      set.points.push(point);
      set.parents.push(id);
      set.welded.set(key, id);
    }
    ids[i] = id;
  }
  const index = mesh.geometry.getIndex();
  const count = index?.count ?? positions.count;
  for (let i = 0; i < count; i += 3) {
    const a = ids[index ? index.getX(i) : i] ?? -1;
    const b = ids[index ? index.getX(i + 1) : i + 1] ?? -1;
    const c = ids[index ? index.getX(i + 2) : i + 2] ?? -1;
    if (a < 0 || b < 0 || c < 0) {
      continue;
    }
    set.parents[weldRoot(set.parents, b)] = weldRoot(set.parents, a);
    set.parents[weldRoot(set.parents, c)] = weldRoot(set.parents, a);
  }
};

const trunkProfile = (
  box: THREE.Box3,
  stem: readonly THREE.Vector3[],
  ground: number,
): TreeTrunkProfile | null => {
  if (stem.length < 6 || box.min.y > ground + 0.01 || box.max.y - box.min.y < 0.025) {
    return null;
  }
  const foot = new THREE.Box3();
  for (const point of stem) {
    if (point.y <= box.min.y + 0.01) {
      foot.expandByPoint(point);
    }
  }
  return {
    halfDepth: (box.max.z - box.min.z) / 2,
    halfWidth: (box.max.x - box.min.x) / 2,
    maxY: box.max.y,
    minY: box.min.y,
    rootX: (foot.min.x + foot.max.x) / 2,
    rootZ: (foot.min.z + foot.max.z) / 2,
    x: (box.min.x + box.max.x) / 2,
    z: (box.min.z + box.max.z) / 2,
  };
};

/** Full ground-connected stems, with child transforms applied. Weld by position
 * across UV/normal seams, then exclude detached limbs and all foliage. A park
 * tile yields several independent trunk boxes; its grass never joins the test.
 */
export const measureTreeTrunks = (
  meshes: Iterable<THREE.Mesh>,
  kind: TreeSourceKind,
): readonly TreeTrunkProfile[] => {
  const set: WeldSet = { parents: [], points: [], welded: new Map() };
  for (const mesh of meshes) {
    weldMeshWood(set, mesh, kind);
  }
  const groups = new Map<number, { box: THREE.Box3; points: THREE.Vector3[] }>();
  let ground = Infinity;
  for (const [i, point] of set.points.entries()) {
    ground = Math.min(ground, point.y);
    const key = weldRoot(set.parents, i);
    let group = groups.get(key);
    if (!group) {
      group = { box: new THREE.Box3(), points: [] };
      groups.set(key, group);
    }
    group.box.expandByPoint(point);
    group.points.push(point);
  }
  const profiles: TreeTrunkProfile[] = [];
  for (const { box, points: stem } of groups.values()) {
    const profile = trunkProfile(box, stem, ground);
    if (profile) {
      profiles.push(profile);
    }
  }
  return profiles;
};

const profileCaches = new WeakMap<ModelCache, Map<string, readonly TreeTrunkProfile[]>>();

/** Shared by placement and collision: no second measurement or parcel index. */
export const getTreeTrunks = (cache: ModelCache, url: string): readonly TreeTrunkProfile[] => {
  const kind = treeSourceKind(url);
  if (!kind || !cache.has(url)) {
    return [];
  }
  let profiles = profileCaches.get(cache);
  if (!profiles) {
    profiles = new Map();
    profileCaches.set(cache, profiles);
  }
  const cached = profiles.get(url);
  if (cached) {
    return cached;
  }
  const meshes: THREE.Mesh[] = [];
  for (let index = 0; ; index += 1) {
    const mesh = cache.srcMesh(url, index);
    if (!mesh) {
      break;
    }
    meshes.push(mesh);
  }
  const trunks = measureTreeTrunks(meshes, kind);
  if (trunks.length === 0) {
    throw new Error(`Tree source has no ground-connected trunk: ${url}`);
  }
  profiles.set(url, trunks);
  return trunks;
};

/** All planting paths share one parcel index and one profile cache. */
export const buildTreeClearance =
  (
    cache: ModelCache,
    parcelClear: ParcelClearance,
    waterBodies: readonly WaterBody[] = [],
  ): TreeClearance =>
  (url, placement) => {
    if (!treeSourceKind(url)) {
      return true;
    }
    const trunks = getTreeTrunks(cache, url);
    if (trunks.length === 0) {
      return false;
    }
    const { x, z, yaw, scaleX, scaleZ } = placement;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    return trunks.every((profile) => {
      // Test actual roots, not the model origin: decorated park tiles contain
      // several offset trees. This gate runs after the planting RNG draws.
      const rootX = profile.rootX * scaleX;
      const rootZ = profile.rootZ * scaleZ;
      const wx = x + rootX * cos + rootZ * sin;
      const wz = z - rootX * sin + rootZ * cos;
      if (inLake(wx, wz) || waterBodies.some((body) => waterBodyContains(body, wx, wz))) {
        return false;
      }
      const dx = profile.x * scaleX;
      const dz = profile.z * scaleZ;
      return parcelClear(
        {
          halfDepth: profile.halfDepth * Math.abs(scaleZ),
          halfWidth: profile.halfWidth * Math.abs(scaleX),
          x: x + dx * cos + dz * sin,
          yaw,
          z: z - dx * sin + dz * cos,
        },
        WALL_MARGIN,
      );
    });
  };
