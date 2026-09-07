import * as THREE from "three";

// Static geometry that lives on the GPU only. three keeps every vertex array
// on the JS heap after it uploads it, so the shipped city costs its full size
// TWICE — ~200 MB of typed arrays beside ~200 MB of GPU buffers on a phone.
// Desktop shrugs; a phone browser counts both against one per-tab budget and
// kills the WebGL context (blank canvas, HUD still alive) when it runs out.
// The city never changes after construction, so the CPU copy has no reader
// once the buffer exists.
//
// The array is swapped for an EMPTY typed array of the same type, not null:
// BatchedMesh reads `index.array.BYTES_PER_ELEMENT` every frame to size its
// multi-draw offsets, and `attribute.count` was fixed at construction, so an
// empty array keeps every render-time read valid. A later `needsUpdate` on a
// released attribute would re-upload nothing — the geometry must be final
// before it is drawn (the callers build a mesh completely before attaching
// it to the scene).
//
// The hook fires at upload time, per attribute, so a mesh culled off-screen
// keeps its data until its first draw — replacing arrays eagerly would hand
// the GPU an empty buffer for anything the camera had not seen yet. A mesh
// that was ALREADY drawn when it is registered would never fire the hook
// (three uploads a static buffer once), so registration bumps the attribute
// version: an uploaded buffer re-uploads once and releases, a fresh one
// uploads on its first draw as usual.
//
// DEFERRED releases wait for one late CPU reader: the ceiling harvest
// (world/solid-index.ts) walks the plain meshes' position arrays after the
// title screen is up, i.e. after their first draw. Those attributes park in
// `pending` when uploaded and are released together by
// `releaseDeferredArrays()` once the harvest has run.
//
// A RESTORED context re-uploads every geometry from its array. Once anything
// here has been released that would draw an empty city, so the restore path
// (main.ts) reloads the page instead when `hasReleasedArrays()` says so.

const hooked = new WeakSet<THREE.BufferAttribute>();
const pending = new Set<THREE.BufferAttribute>();
let armed = false;
let released = 0;

function release(attr: THREE.BufferAttribute): void {
  // SAFETY: BufferAttribute only ever holds a TypedArray (its constructor
  // and BatchedMesh's allocation both require one), so its constructor is
  // one of the TypedArrayConstructor members.
  const Ctor = attr.array.constructor as THREE.TypedArrayConstructor;
  attr.array = new Ctor(0);
  attr.updateRanges.length = 0;
  attr.onUpload(() => {});
  released++;
}

export function releaseArraysAfterUpload(
  geometry: THREE.BufferGeometry,
  options: { readonly deferred?: boolean } = {},
): void {
  const deferred = options.deferred === true;
  const attrs: THREE.BufferAttribute[] = [];
  for (const a of Object.values(geometry.attributes)) {
    if (a instanceof THREE.BufferAttribute) attrs.push(a);
  }
  if (geometry.index) attrs.push(geometry.index);
  for (const attr of attrs) {
    if (hooked.has(attr)) continue;
    hooked.add(attr);
    attr.onUpload(() => {
      if (deferred && !armed) pending.add(attr);
      else release(attr);
    });
    // Already on the GPU? One re-upload fires the hook (see header).
    attr.needsUpdate = true;
  }
}

/** The late CPU readers are done: drop every uploaded deferred array now, and
 *  every later one the moment it uploads. */
export function releaseDeferredArrays(): void {
  armed = true;
  for (const attr of pending) release(attr);
  pending.clear();
}

/** True once any array is gone — a restored context can no longer rebuild
 *  the scene from the heap. */
export function hasReleasedArrays(): boolean {
  return released > 0;
}
