// Per-instance material cloning for view objects: SkeletonUtils.clone shares
// materials across instances, so hit-flash / stealth / team-tint would bleed
// between units that share a model unless each view owns its own copies.
import * as THREE from "three";

/** Clone every mesh material under `root` per-instance (optionally tinting),
 *  returning the standard-material list for emissive/opacity writes. */
export const cloneMats = (
  root: THREE.Object3D,
  tint: THREE.Color | null,
): THREE.MeshStandardMaterial[] => {
  const out: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) {
      return;
    }
    o.material = Array.isArray(o.material)
      ? o.material.map((mm) => mm.clone())
      : o.material.clone();
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of list) {
      if (mat instanceof THREE.MeshStandardMaterial) {
        if (tint) {
          // subtle team/identity hue
          mat.color.lerp(tint, 0.18);
        }
        out.push(mat);
      }
    }
  });
  return out;
};

export const disposeMat = (m: THREE.Material | THREE.Material[]): void => {
  if (Array.isArray(m)) {
    for (const mm of m) {
      mm.dispose();
    }
  } else {
    m.dispose();
  }
};
