import * as THREE from "three";

const hooked = new WeakSet<THREE.BufferAttribute>();
const pending = new Set<THREE.BufferAttribute>();
let armed = false;
let released = 0;

const release = (attr: THREE.BufferAttribute) => {
  attr.array = attr.array.slice(0, 0);
  attr.updateRanges.length = 0;
  attr.onUpload(THREE.BufferAttribute.prototype.onUploadCallback);
  released += 1;
};

const releaseOnUpload = (attr: THREE.BufferAttribute, deferred: boolean) => () => {
  if (deferred && !armed) {
    pending.add(attr);
  } else {
    release(attr);
  }
};

export const releaseArraysAfterUpload = (
  geometry: THREE.BufferGeometry,
  options: { readonly deferred?: boolean } = {},
) => {
  const deferred = options.deferred === true;
  const attrs: THREE.BufferAttribute[] = [];

  for (const a of Object.values(geometry.attributes)) {
    if (a instanceof THREE.BufferAttribute) {
      attrs.push(a);
    }
  }

  if (geometry.index) {
    attrs.push(geometry.index);
  }

  for (const attr of attrs) {
    if (hooked.has(attr)) {
      continue;
    }

    hooked.add(attr);
    attr.onUpload(releaseOnUpload(attr, deferred));
    attr.needsUpdate = true;
  }
};

/** The late CPU readers are done: drop every uploaded deferred array now, and
 *  every later one the moment it uploads. */
export const releaseDeferredArrays = () => {
  armed = true;

  for (const attr of pending) {
    release(attr);
  }

  pending.clear();
};

/** True once any array is gone — a restored context can no longer rebuild
 *  the scene from the heap. */
export const hasReleasedArrays = () => released > 0;
