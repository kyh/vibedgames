// Lamp posts: a merged post-and-arm geometry, plus a separate glass lantern
// instance whose emissive material the lighting rig drives at dusk.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { LAMP } from "../config";
import type { TileCoord } from "./grid";
import {
  SCRATCH_EULER,
  SCRATCH_MATRIX,
  SCRATCH_POSITION,
  SCRATCH_QUATERNION,
  SCRATCH_SCALE,
  tileCenter,
} from "./grid";

export interface Lantern {
  x: number;
  z: number;
}

/** Base plinth, post, arm and the lantern hanger, merged into one geometry. */
export const buildLampPostGeometry = (): THREE.BufferGeometry =>
  mergeGeometries([
    new THREE.CylinderGeometry(0.3, 0.4, 0.5, 10).translate(0, 0.25, 0),
    new THREE.CylinderGeometry(0.05, 0.075, LAMP.height, 8).translate(0, LAMP.height / 2, 0),
    new THREE.BoxGeometry(LAMP.arm + 0.12, 0.07, 0.07).translate(LAMP.arm / 2, LAMP.height, 0),
    new THREE.CylinderGeometry(0.07, 0.15, 0.07, 8).translate(LAMP.arm, LAMP.height - 0.02, 0),
    new THREE.CylinderGeometry(0.1, 0.06, 0.05, 8).translate(LAMP.arm, LAMP.height - 0.42, 0),
  ]);

export const buildLampGlassGeometry = (): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(0.135, 0.105, 0.34, 10).translate(0, -0.05, 0);

/**
 * Stands every lamp on its tile with the arm swung toward the arena centre
 * and returns the world position of each lantern for the lighting rig.
 */
export const placeLamps = (
  posts: THREE.InstancedMesh,
  glass: THREE.InstancedMesh,
  lampTiles: TileCoord[],
): Lantern[] => {
  const lanterns: Lantern[] = [];
  for (const [i, [tx, ty]] of lampTiles.entries()) {
    const x = tileCenter(tx);
    const z = tileCenter(ty);
    const len = Math.hypot(x, z) || 1;
    const dirX = -x / len;
    const dirZ = -z / len;
    SCRATCH_EULER.set(0, Math.atan2(-dirZ, dirX), 0);
    SCRATCH_QUATERNION.setFromEuler(SCRATCH_EULER);
    SCRATCH_MATRIX.compose(
      SCRATCH_POSITION.set(x, -0.03, z),
      SCRATCH_QUATERNION,
      SCRATCH_SCALE.set(1, 1, 1),
    );
    posts.setMatrixAt(i, SCRATCH_MATRIX);
    const lx = x + dirX * LAMP.arm;
    const lz = z + dirZ * LAMP.arm;
    SCRATCH_MATRIX.makeTranslation(lx, LAMP.height - 0.17, lz);
    glass.setMatrixAt(i, SCRATCH_MATRIX);
    lanterns.push({ x: lx, z: lz });
  }
  return lanterns;
};
