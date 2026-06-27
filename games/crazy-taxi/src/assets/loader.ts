import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export type Bounds = {
  readonly size: THREE.Vector3; // width(x), height(y), depth(z) of visible mesh
  readonly min: THREE.Vector3;
  readonly center: THREE.Vector3;
};

// Mesh-only bounds (ignores empty groups/helpers). Models with no mesh fall
// back to a unit box so placement math never divides by zero.
function computeMeshBounds(obj: THREE.Object3D): Bounds {
  const box = new THREE.Box3();
  let found = false;
  obj.updateWorldMatrix(true, true);
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry instanceof THREE.BufferGeometry) {
      child.geometry.computeBoundingBox();
      const bb = child.geometry.boundingBox;
      if (!bb) return;
      const mb = bb.clone();
      mb.applyMatrix4(child.matrixWorld);
      box.union(mb);
      found = true;
    }
  });
  if (!found) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return { size, min: box.min.clone(), center };
}

export class ModelCache {
  private loader = new GLTFLoader();
  private templates = new Map<string, THREE.Object3D>();
  private boundsCache = new Map<string, Bounds>();

  private loadOne(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => {
          const scene = gltf.scene;
          scene.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          this.templates.set(url, scene);
          this.boundsCache.set(url, computeMeshBounds(scene));
          resolve();
        },
        undefined,
        (err) => reject(err instanceof Error ? err : new Error(String(err))),
      );
    });
  }

  // Load all URLs, reporting fractional progress. Failures are tolerated so one
  // bad asset can't black-screen the whole game (callers get a fallback box).
  async preload(urls: readonly string[], onProgress: (frac: number) => void): Promise<void> {
    let done = 0;
    const total = urls.length;
    await Promise.all(
      urls.map(async (url) => {
        try {
          await this.loadOne(url);
        } catch (e) {
          console.warn("[assets] failed to load", url, e);
        }
        done++;
        onProgress(done / total);
      }),
    );
  }

  bounds(url: string): Bounds {
    const b = this.boundsCache.get(url);
    if (b) return b;
    const fallback: Bounds = {
      size: new THREE.Vector3(1, 1, 1),
      min: new THREE.Vector3(-0.5, 0, -0.5),
      center: new THREE.Vector3(0, 0.5, 0),
    };
    this.boundsCache.set(url, fallback);
    return fallback;
  }

  // Fresh clone of a loaded template (or a magenta fallback box if missing).
  instance(url: string): THREE.Object3D {
    const tpl = this.templates.get(url);
    if (!tpl) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0xff00ff }),
      );
      mesh.position.y = 0.5;
      return mesh;
    }
    return tpl.clone(true);
  }
}
