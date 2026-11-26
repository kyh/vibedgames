import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Narrows an object to a mesh with three's default geometry and material types. */
export const isMesh = (object: THREE.Object3D): object is THREE.Mesh =>
  object instanceof THREE.Mesh;

/** `mergeGeometries`, typed as it behaves: null when the geometries' layouts disagree. */
export const mergeGeometriesOrNull: (
  geometries: THREE.BufferGeometry[],
  useGroups?: boolean,
) => THREE.BufferGeometry | null = mergeGeometries;

/** An index attribute's array as the Uint16 or Uint32 array three writes; any other typed array is widened into a Uint32Array copy. */
export const indexArrayOf = (index: THREE.BufferAttribute) =>
  index.array instanceof Uint16Array || index.array instanceof Uint32Array
    ? index.array
    : Uint32Array.from(index.array);

/** An attribute's backing array as a Float32Array; any other typed array is copied into one. */
export const float32ArrayOf = (
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
) =>
  attribute.array instanceof Float32Array ? attribute.array : Float32Array.from(attribute.array);
