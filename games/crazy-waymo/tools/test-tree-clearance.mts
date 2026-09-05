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
  type TreeTrunkProfile,
} from "../src/world/tree-clearance.ts";
import { districtAt } from "../src/world/sf-map.ts";
import { ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../src/shared/constants.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;
type Source = { readonly trunks: readonly TreeTrunkProfile[]; readonly node: THREE.Matrix4 };
const SOURCES = [
  "props/tree-large.glb",
  "props/tree-small.glb",
  "props/kk-tree-a.glb",
  "props/kk-tree-b.glb",
  "props/kk-tree-c.glb",
  "parks/park-base-decorated-trees.glb",
];
const sourceCache = new Map<string, Source>();

async function loadTreeSources(): Promise<ReadonlyMap<string, Source>> {
  if (sourceCache.size === SOURCES.length) return sourceCache;
  const cache = new ModelCache();
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  await MeshoptDecoder.ready;
  for (const path of SOURCES) {
    const url = `/models/${path}`;
    const kind = treeSourceKind(url);
    if (!kind) throw new Error(`Missing tree source classification: ${path}`);
    const meshes: THREE.Mesh[] = [];
    if (kind === "sf") {
      await cache.ensure(url);
      const mesh = cache.srcMesh(url, 0);
      if (mesh) meshes.push(mesh);
    } else {
      const doc = await io.read(`public/models/${path}`);
      for (const node of doc.getRoot().listNodes())
        for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
          const position = primitive.getAttribute("POSITION");
          const uv = primitive.getAttribute("TEXCOORD_0");
          if (!position || !uv) throw new Error(`Tree source lacks geometry or bark UVs: ${path}`);
          const positions: number[] = [];
          const uvs: number[] = [];
          for (let i = 0; i < position.getCount(); i++) {
            positions.push(...position.getElement(i, []));
            uvs.push(...uv.getElement(i, []));
          }
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
          geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
          const accessor = primitive.getIndices();
          if (accessor) {
            const indices: number[] = [];
            for (let i = 0; i < accessor.getCount(); i++) indices.push(accessor.getScalar(i));
            geometry.setIndex(indices);
          }
          const mesh = new THREE.Mesh(geometry);
          mesh.matrix.fromArray(node.getWorldMatrix());
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrixWorld(true);
          meshes.push(mesh);
        }
    }
    if (meshes.length !== 1 || !meshes[0])
      throw new Error(`Tree audit needs explicit multi-mesh source handling: ${path}`);
    sourceCache.set(path, {
      trunks: measureTreeTrunks(meshes, kind),
      node: meshes[0].matrixWorld.clone(),
    });
  }
  return sourceCache;
}

export async function checkTreeClearanceSources(check: Check): Promise<void> {
  const sources = await loadTreeSources();
  for (const [path, source] of sources) {
    const expected = path.startsWith("parks/") ? 4 : 1;
    check(
      `tree source exposes each connected trunk: ${path}`,
      source.trunks.length === expected,
      `${source.trunks.length} stems`,
    );
  }
  const cache = new ModelCache();
  const url = "/models/props/tree-large.glb";
  await cache.ensure(url);
  const clear = buildParcelClearance([
    {
      ring: new Float32Array([0, -10, 10, -10, 10, 10, 0, 10]),
      n: 4,
      obb: { cx: 5, cz: 0, halfA: 5, halfB: 10, ex: 1, ez: 0 },
    },
  ]);
  const tree = buildTreeClearance(cache, clear);
  const placement = { x: -1, z: 0, yaw: 0, scaleX: 10, scaleZ: 10 };
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
}

export type TreeClearanceReport = {
  readonly instances: number;
  readonly stems: number;
  readonly parkStems: number;
  readonly embeddedStems: number;
  readonly missingEmbeddedColliders: number;
  readonly blocked: readonly {
    readonly url: string;
    readonly x: number;
    readonly z: number;
    readonly parcel: number;
  }[];
};

/** Inspect the installed instance matrices, including the source child transform.
 * Exact XZ stem boxes are tested only against vertically overlapping buildings.
 */
export async function auditTreeClearance(
  rest: CityRestPayload,
  plans: readonly ParcelPlan[],
): Promise<TreeClearanceReport> {
  const sources = await loadTreeSources();
  const buckets = new Map<string, ParcelPlan[]>();
  for (const parcel of plans) {
    const o = parcel.obb;
    const rx = Math.abs(o.ex * o.halfA) + Math.abs(o.ez * o.halfB);
    const rz = Math.abs(o.ez * o.halfA) + Math.abs(o.ex * o.halfB);
    for (let x = Math.floor((o.cx - rx) / 32); x <= Math.floor((o.cx + rx) / 32); x++)
      for (let z = Math.floor((o.cz - rz) / 32); z <= Math.floor((o.cz + rz) / 32); z++) {
        const key = `${x},${z}`,
          list = buckets.get(key);
        if (list) list.push(parcel);
        else buckets.set(key, [parcel]);
      }
  }
  let instances = 0,
    stems = 0,
    parkStems = 0,
    embeddedStems = 0,
    missingEmbeddedColliders = 0;
  const treeSolids = new Map<string, { x: number; z: number }[]>();
  for (const solid of rest.solids) {
    if (
      !solid.noBody ||
      Math.abs(solid.maxX - solid.minX - 1.1) > 0.01 ||
      Math.abs(solid.maxZ - solid.minZ - 1.1) > 0.01
    )
      continue;
    const x = (solid.minX + solid.maxX) / 2;
    const z = (solid.minZ + solid.maxZ) / 2;
    const key = `${Math.floor(x)},${Math.floor(z)}`;
    const list = treeSolids.get(key);
    if (list) list.push({ x, z });
    else treeSolids.set(key, [{ x, z }]);
  }
  const blocked: { url: string; x: number; z: number; parcel: number }[] = [];
  for (const item of rest.batchItems) {
    const url = item.url;
    if (!url) continue;
    const path = url.slice(url.indexOf("models/") + 7);
    const source = sources.get(path);
    if (!source) continue;
    instances++;
    const instance = new THREE.Matrix4().fromArray(item.m).multiply(source.node.clone().invert());
    const m = instance.elements;
    const sx = Math.hypot(m[0] ?? 0, m[1] ?? 0, m[2] ?? 0);
    const sy = Math.hypot(m[4] ?? 0, m[5] ?? 0, m[6] ?? 0);
    const sz = Math.hypot(m[8] ?? 0, m[9] ?? 0, m[10] ?? 0);
    const yaw = Math.atan2(m[8] ?? 0, m[10] ?? 0);
    for (const trunk of source.trunks) {
      stems++;
      if (path.startsWith("parks/")) {
        embeddedStems++;
        const foot = new THREE.Vector3(trunk.rootX, 0, trunk.rootZ).applyMatrix4(instance);
        let seated = false;
        for (let x = Math.floor(foot.x - 0.02); x <= Math.floor(foot.x + 0.02); x++)
          for (let z = Math.floor(foot.z - 0.02); z <= Math.floor(foot.z + 0.02); z++)
            for (const solid of treeSolids.get(`${x},${z}`) ?? [])
              if (Math.hypot(solid.x - foot.x, solid.z - foot.z) < 0.02) seated = true;
        if (!seated) missingEmbeddedColliders++;
      }
      const center = new THREE.Vector3(trunk.x, 0, trunk.z).applyMatrix4(instance);
      const district = districtAt(
        Math.floor((center.x + WORLD_HALF_X) / ROAD_TILE),
        Math.floor((center.z + WORLD_HALF_Z) / ROAD_TILE),
      );
      if (district.character === "park") parkStems++;
      const minY = center.y + trunk.minY * sy;
      const maxY = center.y + trunk.maxY * sy;
      const hw = trunk.halfWidth * sx,
        hd = trunk.halfDepth * sz;
      const rx = Math.abs(Math.cos(yaw) * hw) + Math.abs(Math.sin(yaw) * hd) + 0.01;
      const rz = Math.abs(Math.sin(yaw) * hw) + Math.abs(Math.cos(yaw) * hd) + 0.01;
      const candidates = new Set<ParcelPlan>();
      for (let x = Math.floor((center.x - rx) / 32); x <= Math.floor((center.x + rx) / 32); x++)
        for (let z = Math.floor((center.z - rz) / 32); z <= Math.floor((center.z + rz) / 32); z++) {
          for (const p of buckets.get(`${x},${z}`) ?? []) candidates.add(p);
        }
      for (const p of candidates) {
        if (maxY <= p.footY + 0.01 || minY >= p.seatY + p.height - 0.01) continue;
        if (
          buildParcelClearance([p])(
            { x: center.x, z: center.z, halfWidth: hw, halfDepth: hd, yaw },
            0.01,
          )
        )
          continue;
        blocked.push({ url, x: center.x, z: center.z, parcel: p.id });
        break;
      }
    }
  }
  return { instances, stems, parkStems, embeddedStems, missingEmbeddedColliders, blocked };
}

export async function checkBakedTreeClearance(
  check: Check,
  rest: CityRestPayload,
  plans: readonly ParcelPlan[],
): Promise<void> {
  const report = await auditTreeClearance(rest, plans);
  check(
    "installed tree stems clear building walls",
    report.blocked.length === 0,
    `${report.blocked.length}/${report.stems} blocked; examples ${JSON.stringify(report.blocked.slice(0, 5))}`,
  );
  check(
    "tree clearance preserves planted parks",
    report.parkStems >= 10000,
    `${report.parkStems} park stems, ${report.embeddedStems} embedded stems`,
  );
  check(
    "tree clearance retains city planting",
    report.stems >= 17000,
    `${report.instances} instances / ${report.stems} stems`,
  );
  check(
    "embedded park trees collide at their visible roots",
    report.missingEmbeddedColliders === 0,
    `${report.missingEmbeddedColliders}/${report.embeddedStems} missing root colliders`,
  );
}
