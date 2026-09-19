import type * as THREE from "three";

/** Flag `attr` for upload limited to its first `count` array elements — the
 *  handed-out prefix of a pool — instead of the whole preallocated buffer.
 *  Nothing is flagged for an empty prefix. */
export const uploadPrefix = (attr: THREE.BufferAttribute, count: number): void => {
  if (count <= 0) {
    return;
  }
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count);
  attr.needsUpdate = true;
};
