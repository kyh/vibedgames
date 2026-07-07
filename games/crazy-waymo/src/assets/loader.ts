import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
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

  constructor() {
    // Bundled GLBs are meshopt-compressed (EXT_meshopt_compression).
    this.loader.setMeshoptDecoder(MeshoptDecoder);
  }

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
    const clone = tpl.clone(true);
    // Tag every mesh with its source (url + stable child index) so the
    // city-rest cache can serialize batch items as references instead of
    // geometry, and resolve them back to the loaded GLB on a cache hit.
    let idx = 0;
    clone.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.userData.src = { url, idx };
        idx++;
      }
    });
    return clone;
  }

  // Reverse lookup: which template (url, idx) owns this material instance?
  // Merged meshes keep the shared GLB material but lose per-mesh userData —
  // this lets the city-rest cache serialize them as a source reference.
  private matSrc: Map<THREE.Material, { url: string; idx: number }> | null = null;
  srcOfMaterial(mat: THREE.Material): { url: string; idx: number } | null {
    if (!this.matSrc) {
      this.matSrc = new Map();
      for (const [url, tpl] of this.templates) {
        let i = 0;
        tpl.traverse((c) => {
          if (c instanceof THREE.Mesh) {
            if (!Array.isArray(c.material) && !this.matSrc?.has(c.material)) {
              this.matSrc?.set(c.material, { url, idx: i });
            }
            i++;
          }
        });
      }
    }
    return this.matSrc.get(mat) ?? null;
  }

  // Resolve a src tag back to the template's mesh (geometry lookup for the
  // city-rest cache rebuild path). Tags may come from a build with a
  // different vite base ("/models/x.glb" vs "models/x.glb") — normalize.
  private canonMap: Map<string, THREE.Object3D> | null = null;
  srcMesh(url: string, idx: number): THREE.Mesh | null {
    let tpl = this.templates.get(url);
    if (!tpl) {
      // Baked artifacts may come from a build with a different vite base
      // ("/models/x" vs "./models/x") — match on the canonical tail.
      if (!this.canonMap) {
        this.canonMap = new Map();
        const canon = (u: string): string => u.replace(/^(\.\/|\/)+/, "");
        for (const [k, v] of this.templates) this.canonMap.set(canon(k), v);
      }
      tpl = this.canonMap.get(url.replace(/^(\.\/|\/)+/, ""));
    }
    if (!tpl) return null;
    let i = 0;
    let found: THREE.Mesh | null = null;
    tpl.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        if (i === idx && !found) found = c;
        i++;
      }
    });
    return found;
  }
}
