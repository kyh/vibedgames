import * as THREE from "three";
import { isMesh } from "./mesh";

/** Clone every mesh material under `root` per-instance (optionally tinting),
 *  returning the standard-material list for emissive/opacity writes. */
export const cloneMats = (root: THREE.Object3D, tint: THREE.Color | null) => {
  const out: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    if (!isMesh(o)) {
      return;
    }

    o.material = Array.isArray(o.material)
      ? o.material.map((mm) => mm.clone())
      : o.material.clone();
    const list = Array.isArray(o.material) ? o.material : [o.material];

    for (const mat of list) {
      if (mat instanceof THREE.MeshStandardMaterial) {
        if (tint) {
          mat.color.lerp(tint, 0.18);
        }

        out.push(mat);
      }
    }
  });

  return out;
};

export const disposeMat = (m: THREE.Material | THREE.Material[]) => {
  if (Array.isArray(m)) {
    for (const mm of m) {
      mm.dispose();
    }
  } else {
    m.dispose();
  }
};
