import * as THREE from "three";

export type PropInstance = {
  readonly geo: THREE.BufferGeometry;
  readonly matrix: THREE.Matrix4;
  readonly tint?: THREE.Color;
};

type PackedGroup = {
  readonly mesh: THREE.InstancedMesh;
  readonly matrices: Float32Array;
  readonly colors: Float32Array;
  readonly ids: Uint32Array;
};

type Entry =
  | {
      readonly kind: "packed";
      readonly group: PackedGroup;
      readonly source: number;
      slot: number | null;
    }
  | { readonly kind: "single"; readonly id: number; visible: boolean };

type Member = { readonly id: number; readonly item: PropInstance };

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
    if (source.instanceCount !== items.length)
      throw new Error("Prop instance IDs do not match source");
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
    this.entries = Array.from({ length: items.length }, () => undefined);

    const byGeometry = new Map<THREE.BufferGeometry, Member[]>();
    for (let id = 0; id < items.length; id++) {
      const item = items[id];
      if (!item) throw new Error("Missing prop instance");
      const members = byGeometry.get(item.geo);
      if (members) members.push({ id, item });
      else byGeometry.set(item.geo, [{ id, item }]);
    }
    const singles: Member[] = [];
    const tint = new THREE.Color();
    const localBounds = new THREE.Box3();
    const gpuMatrix = new THREE.Matrix4();
    for (const [geometry, members] of byGeometry) {
      if (members.length === 1) {
        const member = members[0];
        if (member) singles.push(member);
        continue;
      }
      const mesh = new THREE.InstancedMesh(geometry, source.material, members.length);
      mesh.name = `${source.name || "city"}-instances`;
      mesh.receiveShadow = source.receiveShadow;
      mesh.frustumCulled = false; // the same authoritative chunk mask as the source
      mesh.layers.mask = source.layers.mask;
      mesh.renderOrder = source.renderOrder;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const group: PackedGroup = {
        mesh,
        matrices: new Float32Array(members.length * 16),
        colors: new Float32Array(members.length * 3),
        ids: new Uint32Array(members.length),
      };
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const bounds = new THREE.Box3();
      mesh.count = 0;
      for (let index = 0; index < members.length; index++) {
        const member = members[index];
        if (!member) throw new Error("Missing grouped prop");
        const { id, item } = member;
        group.matrices.set(item.matrix.elements, index * 16);
        tint.copy(item.tint ?? WHITE);
        tint.toArray(group.colors, index * 3);
        if (geometry.boundingBox)
          bounds.union(
            localBounds
              .copy(geometry.boundingBox)
              .applyMatrix4(gpuMatrix.fromArray(group.matrices, index * 16)),
          );
        const slot = source.getVisibleAt(id) ? mesh.count++ : null;
        this.entries[id] = { kind: "packed", group, source: index, slot };
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
      if (!mesh.instanceColor) mesh.setColorAt(0, WHITE);
      mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
      mesh.visible = mesh.count > 0;
      this.packed.push(group);
      this.add(mesh);
    }
    if (singles.length > 0) {
      let vertices = 0;
      let indices = 0;
      for (const { item } of singles) {
        vertices += item.geo.getAttribute("position").count;
        indices += item.geo.index?.count ?? 0;
      }
      const mesh = new THREE.BatchedMesh(singles.length, vertices, indices, source.material);
      mesh.name = `${source.name || "city"}-unique`;
      mesh.receiveShadow = source.receiveShadow;
      mesh.perObjectFrustumCulled = false;
      mesh.sortObjects = false;
      mesh.frustumCulled = false;
      mesh.layers.mask = source.layers.mask;
      mesh.renderOrder = source.renderOrder;
      for (const { id, item } of singles) {
        const iid = mesh.addInstance(mesh.addGeometry(item.geo));
        mesh.setMatrixAt(iid, item.matrix);
        mesh.setColorAt(iid, item.tint ?? WHITE);
        const visible = source.getVisibleAt(id);
        mesh.setVisibleAt(iid, visible);
        if (visible) this.activeSingles++;
        this.entries[id] = { kind: "single", id: iid, visible };
      }
      mesh.computeBoundingSphere();
      mesh.visible = this.activeSingles > 0;
      this.singles = mesh;
      this.add(mesh);
    }
  }

  setVisibleAt(id: number, visible: boolean): void {
    if (this.disposed) throw new Error("Cannot update disposed prop instances");
    const entry = this.entries[id];
    if (!entry) throw new RangeError(`Unknown prop instance ${id}`);
    if (entry.kind === "single") {
      if (entry.visible === visible) return;
      entry.visible = visible;
      this.activeSingles += visible ? 1 : -1;
      if (this.singles) {
        this.singles.setVisibleAt(entry.id, visible);
        this.singles.visible = this.activeSingles > 0;
      }
      return;
    }
    if ((entry.slot !== null) === visible) return;
    const { group } = entry;
    const { mesh } = group;
    if (visible) {
      const slot = mesh.count++;
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
      this.markSlot(group, slot);
    } else if (entry.slot !== null) {
      const slot = entry.slot;
      const last = --mesh.count;
      if (slot !== last) {
        const movedId = group.ids[last];
        if (movedId === undefined) throw new Error("Missing packed prop ID");
        const moved = this.entries[movedId];
        if (!moved || moved.kind !== "packed") throw new Error("Corrupt packed prop IDs");
        mesh.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
        mesh.instanceColor?.array.copyWithin(slot * 3, last * 3, last * 3 + 3);
        group.ids[slot] = movedId;
        moved.slot = slot;
        this.markSlot(group, slot);
      }
      entry.slot = null;
    }
    // Zero-count meshes otherwise still enter WebGLRenderer's render list,
    // setProgram and material updates before their empty draw is skipped.
    // The enclosing group's externally controlled visibility is untouched.
    mesh.visible = mesh.count > 0;
  }

  private markSlot(group: PackedGroup, slot: number): void {
    const matrix = group.mesh.instanceMatrix;
    matrix.addUpdateRange(slot * 16, 16);
    matrix.needsUpdate = true;
    const color = group.mesh.instanceColor;
    if (color) {
      color.addUpdateRange(slot * 3, 3);
      color.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { mesh } of this.packed) mesh.dispose();
    this.singles?.dispose();
    this.clear();
  }
}

const WHITE = new THREE.Color(0xffffff);

export type PropBatch = THREE.BatchedMesh | InstancedProps;

/** Keep native multidraw, transparent sorting and per-pass shadow culling intact. */
export function compatiblePropBatch(
  source: THREE.BatchedMesh,
  items: readonly PropInstance[],
  multiDraw: boolean,
): PropBatch {
  if (multiDraw || source.castShadow || source.material.transparent) return source;
  const geometries = new Set(items.map((item) => item.geo));
  if (geometries.size === items.length) return source;
  const replacement = new InstancedProps(source, items);
  source.dispose(); // BatchedMesh owns its copied buffers, not the source assets.
  return replacement;
}
