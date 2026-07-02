import { Vector3 } from "three";
import { DEFAULT_WORLD_BASIS } from "./world-basis.js";

export const VECTOR_EPS = 1e-6;

export function toVec3(value, fallback = { x: 0, y: 0, z: 0 }) {
  return new Vector3(
    value?.x ?? fallback.x ?? 0,
    value?.y ?? fallback.y ?? 0,
    value?.z ?? fallback.z ?? 0,
  );
}

export function toUnitVec3(value, fallback = { x: 0, y: 1, z: 0 }) {
  const vector = toVec3(value, fallback);
  if (vector.lengthSq() <= VECTOR_EPS * VECTOR_EPS) {
    const fallbackVector = toVec3(fallback);
    if (fallbackVector.lengthSq() <= VECTOR_EPS * VECTOR_EPS) {
      return new Vector3();
    }
    return fallbackVector.normalize();
  }
  return vector.normalize();
}

export function toPlanarUnitVec3(
  value,
  fallback = { x: 0, y: 0, z: -1 },
  basis = DEFAULT_WORLD_BASIS,
) {
  const worldBasis = basis;
  const vector = toVec3(value, fallback);
  worldBasis.flatten(vector);
  if (vector.lengthSq() > VECTOR_EPS * VECTOR_EPS) {
    return vector.normalize();
  }

  const fallbackVector = toVec3(fallback);
  worldBasis.flatten(fallbackVector);
  if (fallbackVector.lengthSq() <= VECTOR_EPS * VECTOR_EPS) {
    return new Vector3();
  }
  return fallbackVector.normalize();
}
