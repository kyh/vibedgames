import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { BrawlerId } from "../config";

interface Part {
  mesh: THREE.Object3D;
  geometry: THREE.BufferGeometry;
}

// Kit topology and local part transforms are fixed; only materials vary per player.
// Keep baked geometry across rematches, bounded by the nine authored kits.
const kitGeometry = new Map<BrawlerId, Map<string, THREE.BufferGeometry>>();

const bakePart = ({ mesh, geometry }: Part): THREE.BufferGeometry => {
  const baked = new THREE.BufferGeometry();
  const positions = geometry.getAttribute("position");
  baked.setAttribute("position", positions.clone());
  baked.setAttribute("normal", geometry.getAttribute("normal").clone());
  // All kit materials are untextured. A shared indexed layout also accommodates
  // rounded boxes and extrusions, whose source geometry is non-indexed.
  if (geometry.index) {
    baked.setIndex(geometry.index.clone());
  } else {
    baked.setIndex(Array.from({ length: positions.count }, (_, index) => index));
  }
  baked.applyMatrix4(mesh.matrix);
  if (mesh.matrix.determinant() < 0 && baked.index) {
    const indices = baked.index;
    for (let i = 0; i < indices.count; i += 3) {
      const second = indices.getX(i + 1);
      indices.setX(i + 1, indices.getX(i + 2));
      indices.setX(i + 2, second);
    }
  }
  return baked;
};

/** Batch rigid pieces within each joint; never bake across an animated pivot. */
export const batchBrawlerParts = (root: THREE.Group, id: BrawlerId): void => {
  const cache = kitGeometry.get(id) ?? new Map<string, THREE.BufferGeometry>();
  kitGeometry.set(id, cache);
  const visit = (parent: THREE.Object3D, path: string): void => {
    const batches = new Map<THREE.Material, Part[]>();
    for (const [index, child] of parent.children.entries()) {
      if (child instanceof THREE.Group) {
        visit(child, `${path}/${index}`);
      } else if (
        child instanceof THREE.Mesh &&
        child.geometry instanceof THREE.BufferGeometry &&
        child.material instanceof THREE.Material
      ) {
        child.updateMatrix();
        child.matrixAutoUpdate = false;
        const parts = batches.get(child.material) ?? [];
        parts.push({ geometry: child.geometry, mesh: child });
        batches.set(child.material, parts);
      }
    }
    for (const [index, [material, parts]] of [...batches].entries()) {
      if (parts.length < 2) {
        continue;
      }
      const key = `${path}:${index}`;
      let geometry = cache.get(key);
      if (!geometry) {
        const pieces = parts.map(bakePart);
        geometry = mergeGeometries(pieces) ?? undefined;
        for (const piece of pieces) {
          piece.dispose();
        }
        if (!geometry) {
          throw new Error(`Cannot batch champion ${id} at ${key}`);
        }
        geometry.computeBoundingSphere();
        cache.set(key, geometry);
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldNeedsUpdate = true;
      for (const part of parts) {
        parent.remove(part.mesh);
      }
      parent.add(mesh);
    }
  };
  visit(root, "root");
};
