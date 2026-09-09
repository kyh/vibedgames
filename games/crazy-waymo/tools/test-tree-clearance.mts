import * as THREE from "three";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

import { ModelCache } from "../src/assets/loader.ts";
import type { CityRestPayload } from "../src/world/city.ts";
import type { ParcelPlan } from "../src/world/parcel-plan.ts";
import { buildParcelClearance } from "../src/world/parcel-clearance.ts";
import {
  measureTreeTrunks,
  treeSourceKind,
  buildTreeClearance,
} from "../src/world/tree-clearance.ts";
import type { TreeTrunkProfile } from "../src/world/tree-clearance.ts";
import { districtAt } from "../src/world/sf-map.ts";
import { GGP_LAKE, inLake } from "../src/world/land-class.ts";
import { waterBodyContains } from "../src/world/water.ts";
import type { WaterBody } from "../src/world/water.ts";
import {
  ROAD_TILE,
  WORLD_H,
  WORLD_W,
  WORLD_HALF_X,
  WORLD_HALF_Z,
} from "../src/shared/constants.ts";
import type { PropInstance } from "./geometry-audit.mts";

type Check = (name: string, condition: boolean, detail?: string) => void;
interface Source {
  readonly trunks: readonly TreeTrunkProfile[];
  readonly node: THREE.Matrix4;
}
const SOURCES = [
  "props/tree-large.glb",
  "props/tree-small.glb",
  "props/kk-tree-a.glb",
  "props/kk-tree-b.glb",
  "props/kk-tree-c.glb",
  "parks/park-base-decorated-trees.glb",
];
const sourceCache = new Map<string, Source>();

const loadTreeSources = async (): Promise<ReadonlyMap<string, Source>> => {
  if (sourceCache.size === SOURCES.length) {
    return sourceCache;
  }
  const cache = new ModelCache();
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  await MeshoptDecoder.ready;
  for (const path of SOURCES) {
    const url = `/models/${path}`;
    const kind = treeSourceKind(url);
    if (!kind) {
      throw new Error(`Missing tree source classification: ${path}`);
    }
    const meshes: THREE.Mesh[] = [];
    if (kind === "sf") {
      await cache.ensure(url);
      const mesh = cache.srcMesh(url, 0);
      if (mesh) {
        meshes.push(mesh);
      }
    } else {
      const doc = await io.read(`public/models/${path}`);
      for (const node of doc.getRoot().listNodes()) {
        for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
          const position = primitive.getAttribute("POSITION");
          const uv = primitive.getAttribute("TEXCOORD_0");
          if (!position || !uv) {
            throw new Error(`Tree source lacks geometry or bark UVs: ${path}`);
          }
          const positions: number[] = [];
          const uvs: number[] = [];
          for (let i = 0; i < position.getCount(); i += 1) {
            positions.push(...position.getElement(i, []));
            uvs.push(...uv.getElement(i, []));
          }
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
          geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
          const accessor = primitive.getIndices();
          if (accessor) {
            const indices: number[] = [];
            for (let i = 0; i < accessor.getCount(); i += 1) {
              indices.push(accessor.getScalar(i));
            }
            geometry.setIndex(indices);
          }
          const mesh = new THREE.Mesh(geometry);
          mesh.matrix.fromArray(node.getWorldMatrix());
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrixWorld(true);
          meshes.push(mesh);
        }
      }
    }
    if (meshes.length !== 1 || !meshes[0]) {
      throw new Error(`Tree audit needs explicit multi-mesh source handling: ${path}`);
    }
    sourceCache.set(path, {
      node: meshes[0].matrixWorld.clone(),
      trunks: measureTreeTrunks(meshes, kind),
    });
  }
  return sourceCache;
};

/** Serialized matrices locate mesh nodes. The geometry-derived root centroid
 * locates the plant. Multi-stem park tiles retain one seat sample per asset. */
const treeSeat = (source: Source, meshWorld: THREE.Matrix4): THREE.Vector3 => {
  if (source.trunks.length === 0) {
    throw new Error("Tree seat lacks measured roots");
  }
  const root = new THREE.Vector3();
  for (const trunk of source.trunks) {
    root.add(new THREE.Vector3(trunk.rootX, trunk.minY, trunk.rootZ));
  }
  root.divideScalar(source.trunks.length);
  return root.applyMatrix4(meshWorld.clone().multiply(source.node.clone().invert()));
};

/** Correct only the seating coordinates; preserve every instance and its
 * identity so shoreline filtering and the rest of the geometry audit agree. */
export const treeRootSeatSamples = async (
  rest: CityRestPayload,
  props: readonly PropInstance[],
): Promise<
  ReadonlyMap<PropInstance, { readonly x: number; readonly y: number; readonly z: number }>
> => {
  if (props.length !== rest.batchItems.length) {
    throw new Error("Seat samples lost instance correspondence");
  }
  const sources = await loadTreeSources();
  const result = new Map<
    PropInstance,
    { readonly x: number; readonly y: number; readonly z: number }
  >();
  for (const [i, item] of rest.batchItems.entries()) {
    const prop = props[i];
    if (!prop || !item.url) {
      continue;
    }
    const source = sources.get(item.url.slice(item.url.indexOf("models/") + 7));
    if (!source) {
      continue;
    }
    const root = treeSeat(source, new THREE.Matrix4().fromArray(item.m));
    result.set(prop, { x: root.x, y: root.y, z: root.z });
  }
  return result;
};

export const checkTreeClearanceSources = async (check: Check): Promise<void> => {
  const sources = await loadTreeSources();
  for (const [path, source] of sources) {
    const expected = path.startsWith("parks/") ? 4 : 1;
    check(
      `tree source exposes each connected trunk: ${path}`,
      source.trunks.length === expected,
      `${source.trunks.length} stems`,
    );
  }
  const geometry = new THREE.BoxGeometry(0.6, 2, 0.8).translate(0.3, 1, -0.4);
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, 0.01, 0.1);
  }
  const mesh = new THREE.Mesh(geometry);
  mesh.position.set(0.7, 2, -1.3);
  mesh.scale.setScalar(0.5);
  mesh.updateMatrixWorld(true);
  const translated = new THREE.Mesh(geometry.clone().translate(-4, 3, -7));
  translated.matrixAutoUpdate = false;
  translated.matrix.copy(mesh.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(4, -3, 7));
  translated.updateMatrixWorld(true);
  const rootPlacement = new THREE.Matrix4().compose(
    new THREE.Vector3(-80, 10, -35),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2),
    new THREE.Vector3(2.3, 0.8, 1.7),
  );
  const rootA = treeSeat(
    { node: mesh.matrixWorld, trunks: measureTreeTrunks([mesh], "sf") },
    rootPlacement.clone().multiply(mesh.matrixWorld),
  );
  const rootB = treeSeat(
    { node: translated.matrixWorld, trunks: measureTreeTrunks([translated], "sf") },
    rootPlacement.clone().multiply(translated.matrixWorld),
  );
  const expectedRoot = new THREE.Vector3(0.3, 0, -0.4)
    .applyMatrix4(mesh.matrixWorld)
    .applyMatrix4(rootPlacement);
  check(
    "translated GLB mesh origins cannot move the measured planted root under yaw and scale",
    rootA.distanceTo(rootB) < 1e-6 && rootA.distanceTo(expectedRoot) < 1e-6,
  );
  geometry.dispose();
  translated.geometry.dispose();
  const cache = new ModelCache();
  const url = "/models/props/tree-large.glb";
  await cache.ensure(url);
  const clear = buildParcelClearance([
    {
      n: 4,
      obb: { cx: 5, cz: 0, ex: 1, ez: 0, halfA: 5, halfB: 10 },
      ring: new Float32Array([0, -10, 10, -10, 10, 10, 0, 10]),
    },
  ]);
  const tree = buildTreeClearance(cache, clear);
  const placement = { scaleX: 10, scaleZ: 10, x: -1, yaw: 0, z: 0 };
  check(
    "tree gate keeps canopy overhang but rejects planted stems",
    tree(url, placement) &&
      !tree(url, { ...placement, x: 0.1 }) &&
      !tree(url, { ...placement, x: -0.4 }),
  );
  const decisions = [
    placement,
    { ...placement, x: 0.1 },
    { ...placement, yaw: 1.8 },
    { ...placement, scaleX: 0.6 },
  ];
  const first = decisions.map((p) => tree(url, p));
  const second = decisions.map((p) => tree(url, p));
  check(
    "repeated tree placement decisions are deterministic",
    JSON.stringify(first) === JSON.stringify(second),
  );
  const pool: WaterBody = {
    halfX: 3,
    halfZ: 2,
    kind: "ellipse",
    x: -80,
    y: 0,
    yaw: 0.6,
    z: -35,
  };
  const poolClear = buildTreeClearance(cache, clear, [pool]);
  check(
    "authored lagoon rejects planted roots while keeping dry surrounding trees",
    !poolClear(url, { ...placement, scaleX: 1, scaleZ: 1, x: pool.x, z: pool.z }) &&
      poolClear(url, { ...placement, scaleX: 1, scaleZ: 1, x: pool.x - 10, z: pool.z }),
  );
  const lakeX = (GGP_LAKE.u - 0.5) * WORLD_W;
  const lakeZ = (GGP_LAKE.v - 0.5) * WORLD_H;
  check(
    "planting keeps dry lake banks but rejects water roots",
    !tree(url, { ...placement, x: lakeX, yaw: 1.8, z: lakeZ }) &&
      tree(url, { ...placement, x: lakeX + GGP_LAKE.ru + 1, yaw: 1.8, z: lakeZ }),
  );
};

export interface TreeClearanceReport {
  readonly instances: number;
  readonly stems: number;
  readonly parkStems: number;
  readonly embeddedStems: number;
  readonly missingEmbeddedColliders: number;
  readonly waterRoots: readonly { readonly url: string; readonly x: number; readonly z: number }[];
  readonly blocked: readonly {
    readonly url: string;
    readonly x: number;
    readonly z: number;
    readonly parcel: number;
  }[];
}

const bucketParcels = (plans: readonly ParcelPlan[]): Map<string, ParcelPlan[]> => {
  const buckets = new Map<string, ParcelPlan[]>();
  for (const parcel of plans) {
    const o = parcel.obb;
    const rx = Math.abs(o.ex * o.halfA) + Math.abs(o.ez * o.halfB);
    const rz = Math.abs(o.ez * o.halfA) + Math.abs(o.ex * o.halfB);
    for (let x = Math.floor((o.cx - rx) / 32); x <= Math.floor((o.cx + rx) / 32); x += 1) {
      for (let z = Math.floor((o.cz - rz) / 32); z <= Math.floor((o.cz + rz) / 32); z += 1) {
        const key = `${x},${z}`;
        const list = buckets.get(key);
        if (list) {
          list.push(parcel);
        } else {
          buckets.set(key, [parcel]);
        }
      }
    }
  }
  return buckets;
};

const embeddedTreeSolids = (rest: CityRestPayload): Map<string, { x: number; z: number }[]> => {
  const treeSolids = new Map<string, { x: number; z: number }[]>();
  for (const solid of rest.solids) {
    if (
      !solid.noBody ||
      Math.abs(solid.maxX - solid.minX - 1.1) > 0.01 ||
      Math.abs(solid.maxZ - solid.minZ - 1.1) > 0.01
    ) {
      continue;
    }
    const x = (solid.minX + solid.maxX) / 2;
    const z = (solid.minZ + solid.maxZ) / 2;
    const key = `${Math.floor(x)},${Math.floor(z)}`;
    const list = treeSolids.get(key);
    if (list) {
      list.push({ x, z });
    } else {
      treeSolids.set(key, [{ x, z }]);
    }
  }
  return treeSolids;
};

const seatedOnCollider = (
  treeSolids: ReadonlyMap<string, { x: number; z: number }[]>,
  foot: THREE.Vector3,
): boolean => {
  for (let x = Math.floor(foot.x - 0.02); x <= Math.floor(foot.x + 0.02); x += 1) {
    for (let z = Math.floor(foot.z - 0.02); z <= Math.floor(foot.z + 0.02); z += 1) {
      for (const solid of treeSolids.get(`${x},${z}`) ?? []) {
        if (Math.hypot(solid.x - foot.x, solid.z - foot.z) < 0.02) {
          return true;
        }
      }
    }
  }
  return false;
};

const blockingParcel = (
  buckets: ReadonlyMap<string, ParcelPlan[]>,
  center: THREE.Vector3,
  stem: { hw: number; hd: number; yaw: number; minY: number; maxY: number },
): ParcelPlan | null => {
  const { hw, hd, yaw, minY, maxY } = stem;
  const rx = Math.abs(Math.cos(yaw) * hw) + Math.abs(Math.sin(yaw) * hd) + 0.01;
  const rz = Math.abs(Math.sin(yaw) * hw) + Math.abs(Math.cos(yaw) * hd) + 0.01;
  const candidates = new Set<ParcelPlan>();
  for (let x = Math.floor((center.x - rx) / 32); x <= Math.floor((center.x + rx) / 32); x += 1) {
    for (let z = Math.floor((center.z - rz) / 32); z <= Math.floor((center.z + rz) / 32); z += 1) {
      for (const p of buckets.get(`${x},${z}`) ?? []) {
        candidates.add(p);
      }
    }
  }
  for (const p of candidates) {
    if (maxY <= p.footY + 0.01 || minY >= p.seatY + p.height - 0.01) {
      continue;
    }
    if (
      buildParcelClearance([p])(
        { halfDepth: hd, halfWidth: hw, x: center.x, yaw, z: center.z },
        0.01,
      )
    ) {
      continue;
    }
    return p;
  }
  return null;
};

const instanceTransform = (m: readonly number[], node: THREE.Matrix4) => {
  const instance = new THREE.Matrix4().fromArray(m).multiply(node.clone().invert());
  const e = instance.elements;
  return {
    instance,
    sx: Math.hypot(e[0] ?? 0, e[1] ?? 0, e[2] ?? 0),
    sy: Math.hypot(e[4] ?? 0, e[5] ?? 0, e[6] ?? 0),
    sz: Math.hypot(e[8] ?? 0, e[9] ?? 0, e[10] ?? 0),
    yaw: Math.atan2(e[8] ?? 0, e[10] ?? 0),
  };
};

const rootInWater = (foot: THREE.Vector3, waterBodies: readonly WaterBody[]): boolean =>
  inLake(foot.x, foot.z) || waterBodies.some((body) => waterBodyContains(body, foot.x, foot.z));

/** Inspect the installed instance matrices, including the source child transform.
 * Exact XZ stem boxes are tested only against vertically overlapping buildings.
 */
export const auditTreeClearance = async (
  rest: CityRestPayload,
  plans: readonly ParcelPlan[],
  waterBodies: readonly WaterBody[],
): Promise<TreeClearanceReport> => {
  const sources = await loadTreeSources();
  const buckets = bucketParcels(plans);
  let embeddedStems = 0;
  let instances = 0;
  let missingEmbeddedColliders = 0;
  let parkStems = 0;
  let stems = 0;
  const treeSolids = embeddedTreeSolids(rest);
  const blocked: { url: string; x: number; z: number; parcel: number }[] = [];
  const waterRoots: { url: string; x: number; z: number }[] = [];
  for (const item of rest.batchItems) {
    const { url } = item;
    if (!url) {
      continue;
    }
    const path = url.slice(url.indexOf("models/") + 7);
    const source = sources.get(path);
    if (!source) {
      continue;
    }
    instances += 1;
    const { instance, sx, sy, sz, yaw } = instanceTransform(item.m, source.node);
    for (const trunk of source.trunks) {
      stems += 1;
      const foot = new THREE.Vector3(trunk.rootX, 0, trunk.rootZ).applyMatrix4(instance);
      if (rootInWater(foot, waterBodies)) {
        waterRoots.push({ url, x: foot.x, z: foot.z });
      }
      if (path.startsWith("parks/")) {
        embeddedStems += 1;
        if (!seatedOnCollider(treeSolids, foot)) {
          missingEmbeddedColliders += 1;
        }
      }
      const center = new THREE.Vector3(trunk.x, 0, trunk.z).applyMatrix4(instance);
      const district = districtAt(
        Math.floor((center.x + WORLD_HALF_X) / ROAD_TILE),
        Math.floor((center.z + WORLD_HALF_Z) / ROAD_TILE),
      );
      if (district.character === "park") {
        parkStems += 1;
      }
      const minY = center.y + trunk.minY * sy;
      const maxY = center.y + trunk.maxY * sy;
      const hw = trunk.halfWidth * sx;
      const hd = trunk.halfDepth * sz;
      const blocker = blockingParcel(buckets, center, { hd, hw, maxY, minY, yaw });
      if (blocker) {
        blocked.push({ parcel: blocker.id, url, x: center.x, z: center.z });
      }
    }
  }
  return {
    blocked,
    embeddedStems,
    instances,
    missingEmbeddedColliders,
    parkStems,
    stems,
    waterRoots,
  };
};

export const checkBakedTreeClearance = async (
  check: Check,
  rest: CityRestPayload,
  plans: readonly ParcelPlan[],
  waterBodies: readonly WaterBody[],
): Promise<void> => {
  const report = await auditTreeClearance(rest, plans, waterBodies);
  check(
    "installed tree roots stay outside Stow and authored landmark water",
    report.waterRoots.length === 0,
    `${report.waterRoots.length}/${report.stems} water roots; examples ${JSON.stringify(report.waterRoots.slice(0, 5))}`,
  );
  check(
    "installed tree stems clear building walls",
    report.blocked.length === 0,
    `${report.blocked.length}/${report.stems} blocked; examples ${JSON.stringify(report.blocked.slice(0, 5))}`,
  );
  check(
    "tree clearance preserves planted parks",
    report.parkStems >= 10_000,
    `${report.parkStems} park stems, ${report.embeddedStems} embedded stems`,
  );
  check(
    "tree clearance retains city planting",
    report.stems >= 17_000,
    `${report.instances} instances / ${report.stems} stems`,
  );
  check(
    "embedded park trees collide at their visible roots",
    report.missingEmbeddedColliders === 0,
    `${report.missingEmbeddedColliders}/${report.embeddedStems} missing root colliders`,
  );
};
