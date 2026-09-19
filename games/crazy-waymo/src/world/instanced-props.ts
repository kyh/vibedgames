import * as THREE from "three";

import { releaseArraysAfterUpload } from "../render/gpu-only-geometry";

export interface PropInstance {
  readonly geo: THREE.BufferGeometry;
  readonly matrix: THREE.Matrix4;
  readonly tint?: THREE.Color;
}

interface PackedGroup {
  readonly mesh: THREE.InstancedMesh;
  readonly matrices: Float32Array;
  readonly colors: Float32Array;
  readonly ids: Uint32Array;
}

type Entry =
  | {
      readonly kind: "packed";
      readonly group: PackedGroup;
      readonly source: number;
      slot: number | null;
    }
  | { readonly kind: "single"; readonly id: number; visible: boolean };

interface Member {
  readonly id: number;
  readonly item: PropInstance;
}

const WHITE = new THREE.Color(0xff_ff_ff);

const groupByGeometry = (items: readonly PropInstance[]): Map<THREE.BufferGeometry, Member[]> => {
  const byGeometry = new Map<THREE.BufferGeometry, Member[]>();
  for (let id = 0; id < items.length; id += 1) {
    const item = items[id];
    if (!item) {
      throw new Error("Missing prop instance");
    }
    const members = byGeometry.get(item.geo);
    if (members) {
      members.push({ id, item });
    } else {
      byGeometry.set(item.geo, [{ id, item }]);
    }
  }
  return byGeometry;
};

const inheritSourceLook = (
  mesh: THREE.InstancedMesh | THREE.BatchedMesh,
  source: THREE.BatchedMesh,
  suffix: string,
): void => {
  mesh.name = `${source.name || "city"}-${suffix}`;
  mesh.receiveShadow = source.receiveShadow;
  // the same authoritative chunk mask as the source
  mesh.frustumCulled = false;
  mesh.layers.mask = source.layers.mask;
  mesh.renderOrder = source.renderOrder;
};

/**
 * Opaque noncasters keep the city's existing chunk visibility contract, but
 * repeated geometry uses real instancing on drivers without WEBGL_multi_draw.
 * Stable city IDs map to a compact active prefix. Hiding one member swaps the
 * last active slot into its place; updates touch only changed matrix/color
 * ranges. Unique geometry stays in one BatchedMesh to avoid scene-node growth.
 * Source geometry and materials belong to ModelCache/the city, never this node.
 */
export class InstancedProps extends THREE.Group {
  private readonly entries: (Entry | undefined)[];
  private readonly packed: PackedGroup[] = [];
  private singles: THREE.BatchedMesh | null = null;
  private activeSingles = 0;
  private disposed = false;

  constructor(source: THREE.BatchedMesh, items: readonly PropInstance[]) {
    super();
    if (source.castShadow || source.material.transparent) {
      throw new Error("Instanced props require opaque noncasting source material");
    }
    if (source.instanceCount !== items.length) {
      throw new Error("Prop instance IDs do not match source");
    }
    this.name = source.name;
    this.position.copy(source.position);
    this.quaternion.copy(source.quaternion);
    this.scale.copy(source.scale);
    this.matrix.copy(source.matrix);
    this.matrixWorld.copy(source.matrixWorld);
    this.matrixAutoUpdate = source.matrixAutoUpdate;
    this.matrixWorldAutoUpdate = source.matrixWorldAutoUpdate;
    this.visible = source.visible;
    this.layers.mask = source.layers.mask;
    this.renderOrder = source.renderOrder;
    this.entries = Array.from<Entry | undefined>({ length: items.length });

    const singles: Member[] = [];
    for (const [geometry, members] of groupByGeometry(items)) {
      if (members.length === 1) {
        const [member] = members;
        if (member) {
          singles.push(member);
        }
        continue;
      }
      this.addPackedGroup(source, geometry, members);
    }
    if (singles.length > 0) {
      this.addSingles(source, singles);
    }
  }

  private addPackedGroup(
    source: THREE.BatchedMesh,
    geometry: THREE.BufferGeometry,
    members: readonly Member[],
  ): void {
    const tint = new THREE.Color();
    const localBounds = new THREE.Box3();
    const gpuMatrix = new THREE.Matrix4();
    const mesh = new THREE.InstancedMesh(geometry, source.material, members.length);
    inheritSourceLook(mesh, source, "instances");
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const group: PackedGroup = {
      colors: new Float32Array(members.length * 3),
      ids: new Uint32Array(members.length),
      matrices: new Float32Array(members.length * 16),
      mesh,
    };
    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }
    const bounds = new THREE.Box3();
    mesh.count = 0;
    for (const [index, { id, item }] of members.entries()) {
      group.matrices.set(item.matrix.elements, index * 16);
      tint.copy(item.tint ?? WHITE);
      tint.toArray(group.colors, index * 3);
      if (geometry.boundingBox) {
        bounds.union(
          localBounds
            .copy(geometry.boundingBox)
            .applyMatrix4(gpuMatrix.fromArray(group.matrices, index * 16)),
        );
      }
      let slot: number | null = null;
      if (source.getVisibleAt(id)) {
        slot = mesh.count;
        mesh.count += 1;
      }
      this.entries[id] = { group, kind: "packed", slot, source: index };
      if (slot !== null) {
        group.ids[slot] = id;
        mesh.setMatrixAt(slot, item.matrix);
        mesh.setColorAt(slot, tint);
      }
    }
    // Even an initially empty imposter keeps conservative bounds when shown.
    mesh.boundingBox = bounds.expandByScalar(1e-5);
    mesh.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
    // Allocate colors even when every member starts hidden. No later shader
    // variant/first-show allocation is allowed during a neighborhood change.
    if (!mesh.instanceColor) {
      mesh.setColorAt(0, WHITE);
    }
    mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    mesh.visible = mesh.count > 0;
    this.packed.push(group);
    this.add(mesh);
  }

  private addSingles(source: THREE.BatchedMesh, singles: readonly Member[]): void {
    let vertices = 0;
    let indices = 0;
    for (const { item } of singles) {
      vertices += item.geo.getAttribute("position").count;
      indices += item.geo.index?.count ?? 0;
    }
    const mesh = new THREE.BatchedMesh(singles.length, vertices, indices, source.material);
    inheritSourceLook(mesh, source, "unique");
    mesh.perObjectFrustumCulled = false;
    mesh.sortObjects = false;
    for (const { id, item } of singles) {
      const iid = mesh.addInstance(mesh.addGeometry(item.geo));
      mesh.setMatrixAt(iid, item.matrix);
      mesh.setColorAt(iid, item.tint ?? WHITE);
      const visible = source.getVisibleAt(id);
      mesh.setVisibleAt(iid, visible);
      if (visible) {
        this.activeSingles += 1;
      }
      this.entries[id] = { id: iid, kind: "single", visible };
    }
    mesh.computeBoundingSphere();
    mesh.visible = this.activeSingles > 0;
    this.singles = mesh;
    this.add(mesh);
  }

  setVisibleAt(id: number, visible: boolean): void {
    if (this.disposed) {
      throw new Error("Cannot update disposed prop instances");
    }
    const entry = this.entries[id];
    if (!entry) {
      throw new RangeError(`Unknown prop instance ${id}`);
    }
    if (entry.kind === "single") {
      if (entry.visible === visible) {
        return;
      }
      entry.visible = visible;
      this.activeSingles += visible ? 1 : -1;
      if (this.singles) {
        this.singles.setVisibleAt(entry.id, visible);
        this.singles.visible = this.activeSingles > 0;
      }
      return;
    }
    if ((entry.slot !== null) === visible) {
      return;
    }
    const { group } = entry;
    const { mesh } = group;
    if (visible) {
      const slot = mesh.count;
      mesh.count += 1;
      entry.slot = slot;
      group.ids[slot] = id;
      mesh.instanceMatrix.array.set(
        group.matrices.subarray(entry.source * 16, entry.source * 16 + 16),
        slot * 16,
      );
      mesh.instanceColor?.array.set(
        group.colors.subarray(entry.source * 3, entry.source * 3 + 3),
        slot * 3,
      );
      InstancedProps.markSlot(group, slot);
    } else if (entry.slot !== null) {
      const { slot } = entry;
      mesh.count -= 1;
      const last = mesh.count;
      if (slot !== last) {
        const movedId = group.ids[last];
        if (movedId === undefined) {
          throw new Error("Missing packed prop ID");
        }
        const moved = this.entries[movedId];
        if (!moved || moved.kind !== "packed") {
          throw new Error("Corrupt packed prop IDs");
        }
        mesh.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
        mesh.instanceColor?.array.copyWithin(slot * 3, last * 3, last * 3 + 3);
        group.ids[slot] = movedId;
        moved.slot = slot;
        InstancedProps.markSlot(group, slot);
      }
      entry.slot = null;
    }
    // Zero-count meshes otherwise still enter WebGLRenderer's render list,
    // setProgram and material updates before their empty draw is skipped.
    // The enclosing group's externally controlled visibility is untouched.
    mesh.visible = mesh.count > 0;
  }

  private static markSlot(group: PackedGroup, slot: number): void {
    const matrix = group.mesh.instanceMatrix;
    matrix.addUpdateRange(slot * 16, 16);
    matrix.needsUpdate = true;
    const color = group.mesh.instanceColor;
    if (color) {
      color.addUpdateRange(slot * 3, 3);
      color.needsUpdate = true;
    }
  }

  /** Drop the CPU copy of the unique-geometry batch once the GPU has it
   *  (render/gpu-only-geometry.ts). The packed groups share ModelCache
   *  template geometry with everything else and keep theirs. */
  releaseCpuGeometry(): void {
    if (this.singles) {
      releaseArraysAfterUpload(this.singles.geometry);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const { mesh } of this.packed) {
      mesh.dispose();
    }
    this.singles?.dispose();
    this.clear();
  }
}

export type PropBatch = THREE.BatchedMesh | InstancedProps;

/** Keep native multidraw, transparent sorting and per-pass shadow culling intact. */
export const compatiblePropBatch = (
  source: THREE.BatchedMesh,
  items: readonly PropInstance[],
  multiDraw: boolean,
): PropBatch => {
  if (multiDraw || source.castShadow || source.material.transparent) {
    return source;
  }
  const geometries = new Set(items.map((item) => item.geo));
  if (geometries.size === items.length) {
    return source;
  }
  const replacement = new InstancedProps(source, items);
  // BatchedMesh owns its copied buffers, not the source assets.
  source.dispose();
  return replacement;
};
