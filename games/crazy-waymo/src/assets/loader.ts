import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { createSfTreeModel } from "./sf-trees";

export interface Bounds {
  readonly size: THREE.Vector3;
  readonly min: THREE.Vector3;
  readonly center: THREE.Vector3;
}

export const geoLayoutKey = (geo: THREE.BufferGeometry) => {
  const parts: string[] = [];

  for (const [name, attr] of Object.entries(geo.attributes)) {
    const arrType = "array" in attr && attr.array ? attr.array.constructor.name : "gl";
    parts.push(`${name}:${attr.itemSize}:${attr.normalized ? 1 : 0}:${arrType}`);
  }

  parts.sort();

  return `${parts.join(",")}|${geo.index ? "i" : "n"}`;
};

const computeMeshBounds = (obj: THREE.Object3D) => {
  const box = new THREE.Box3();
  let found = false;
  obj.updateWorldMatrix(true, true);
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry instanceof THREE.BufferGeometry) {
      child.geometry.computeBoundingBox();
      const bb = child.geometry.boundingBox;

      if (!bb) {
        return;
      }

      const mb = bb.clone();
      mb.applyMatrix4(child.matrixWorld);
      box.union(mb);
      found = true;
    }
  });

  if (!found) {
    box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  return { center, min: box.min.clone(), size };
};

const canonTag = (u: string) => u.replace(/^(?:\.\/|\/)+/u, "");

export class ModelCache {
  private loader = new GLTFLoader();
  private templates = new Map<string, THREE.Object3D>();
  private boundsCache = new Map<string, Bounds>();
  private canonMats = new Map<string, THREE.Material>();
  private texFingerprints = new Map<THREE.Texture, string>();
  private fpCtx: CanvasRenderingContext2D | null = null;

  constructor() {
    this.loader.setMeshoptDecoder(MeshoptDecoder);
  }

  private textureFingerprint(tex: THREE.Texture) {
    const cached = this.texFingerprints.get(tex);

    if (cached) {
      return cached;
    }

    let fp = tex.uuid;
    const img: unknown = tex.image;
    const FP = 32;

    if (
      (globalThis.ImageBitmap !== undefined && img instanceof ImageBitmap) ||
      (globalThis.HTMLImageElement !== undefined && img instanceof HTMLImageElement) ||
      (globalThis.HTMLCanvasElement !== undefined && img instanceof HTMLCanvasElement)
    ) {
      try {
        if (!this.fpCtx) {
          const canvas = document.createElement("canvas");
          canvas.width = FP;
          canvas.height = FP;
          this.fpCtx = canvas.getContext("2d", { willReadFrequently: true });
        }

        const ctx = this.fpCtx;

        if (ctx) {
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, FP, FP);
          ctx.drawImage(img, 0, 0, FP, FP);
          const { data } = ctx.getImageData(0, 0, FP, FP);
          let h1 = 2_166_136_261;
          let h2 = 5381;

          /* oxlint-disable no-bitwise, unicorn/prefer-math-trunc -- FNV-1a/djb2: the xor and the int32 wrap ARE the algorithm */
          for (const b of data) {
            h1 = Math.imul(h1 ^ b, 16_777_619);
            h2 = (Math.imul(h2, 33) + b) | 0;
          }

          fp = [
            img.width,
            img.height,
            h1 >>> 0,
            h2 >>> 0,
            /* oxlint-enable no-bitwise, unicorn/prefer-math-trunc */
            tex.colorSpace,
            tex.channel,
            tex.flipY ? 1 : 0,
            tex.wrapS,
            tex.wrapT,
            tex.magFilter,
            tex.minFilter,
            tex.rotation,
            tex.repeat.x,
            tex.repeat.y,
            tex.offset.x,
            tex.offset.y,
          ].join("|");
        }
      } catch {
        fp = tex.uuid;
      }
    }

    this.texFingerprints.set(tex, fp);

    return fp;
  }

  private dedupMaterial(mat: THREE.Material) {
    if (!(mat instanceof THREE.MeshStandardMaterial)) {
      return mat;
    }

    if (
      mat.normalMap ||
      mat.roughnessMap ||
      mat.metalnessMap ||
      mat.emissiveMap ||
      mat.aoMap ||
      mat.alphaMap ||
      mat.bumpMap ||
      mat.displacementMap ||
      mat.lightMap
    ) {
      return mat;
    }

    const key = [
      mat.color.getHex(),
      mat.roughness,
      mat.metalness,
      mat.emissive.getHex(),
      mat.emissiveIntensity,
      mat.transparent ? 1 : 0,
      mat.opacity,
      mat.alphaTest,
      mat.side,
      mat.depthWrite ? 1 : 0,
      mat.flatShading ? 1 : 0,
      mat.vertexColors ? 1 : 0,
      mat.map ? this.textureFingerprint(mat.map) : "none",
    ].join("|");

    const canon = this.canonMats.get(key);

    if (canon) {
      return canon;
    }

    this.canonMats.set(key, mat);

    return mat;
  }

  private storeTemplate(url: string, scene: THREE.Object3D) {
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;

        if (!Array.isArray(child.material)) {
          child.material = this.dedupMaterial(child.material);
        }
      }
    });
    this.templates.set(url, scene);
    this.boundsCache.set(url, computeMeshBounds(scene));
    this.matSrc = null;
    this.canonMap = null;
  }

  private loadOne(url: string) {
    if (url.endsWith("/props/tree-large.glb") || url.endsWith("/props/tree-small.glb")) {
      const kind = url.endsWith("/tree-large.glb") ? "cypress" : "broadleaf";
      this.storeTemplate(url, createSfTreeModel(kind));

      return Promise.resolve() satisfies Promise<void>;
    }

    /* oxlint-disable-next-line promise/avoid-new -- GLTFLoader only reports through success/error callbacks */
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => {
          this.storeTemplate(url, gltf.scene);
          resolve();
        },
        undefined,
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- GLTFLoader reports failure only through this callback
        (err) => reject(err instanceof Error ? err : new Error(String(err))),
      );
    }) satisfies Promise<void>;
  }

  /** Loaded and instanceable right now (no fallback box). */
  has(url: string) {
    return this.templates.has(url);
  }

  private inFlight = new Map<string, Promise<void>>();
  ensure(url: string) {
    if (this.templates.has(url)) {
      return Promise.resolve();
    }

    const pending = this.inFlight.get(url);

    if (pending) {
      return pending;
    }

    const load = this.loadSettled(url);
    this.inFlight.set(url, load);

    return load;
  }

  private async loadSettled(url: string) {
    try {
      await this.loadOne(url);
    } catch (error) {
      console.warn("[assets] failed to load", url, error);
    }
  }

  async preload(urls: readonly string[], onProgress: (frac: number) => void) {
    let done = 0;
    const total = urls.length;
    await Promise.all(
      urls.map(async (url) => {
        await this.ensure(url);
        done += 1;
        onProgress(done / total);
      }),
    );
  }

  bounds(url: string) {
    const b = this.boundsCache.get(url);

    if (b) {
      return b;
    }

    const fallback: Bounds = {
      center: new THREE.Vector3(0, 0.5, 0),
      min: new THREE.Vector3(-0.5, 0, -0.5),
      size: new THREE.Vector3(1, 1, 1),
    };

    this.boundsCache.set(url, fallback);

    return fallback;
  }

  instance(url: string) {
    const tpl = this.templates.get(url);

    if (!tpl) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0xff_00_ff }),
      );

      mesh.position.y = 0.5;

      return mesh;
    }

    const clone = tpl.clone(true);
    let idx = 0;
    clone.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.userData.src = { idx, url };
        idx += 1;
      }
    });

    return clone;
  }

  private matSrc: Map<THREE.Material, { url: string; idx: number }> | null = null;
  srcOfMaterial(mat: THREE.Material) {
    if (!this.matSrc) {
      this.matSrc = new Map();

      for (const [url, tpl] of this.templates) {
        let i = 0;
        tpl.traverse((c) => {
          if (c instanceof THREE.Mesh) {
            if (!Array.isArray(c.material) && !this.matSrc?.has(c.material)) {
              this.matSrc?.set(c.material, { idx: i, url });
            }

            i += 1;
          }
        });
      }
    }

    return this.matSrc.get(mat) ?? null;
  }

  private canonMap: Map<string, THREE.Object3D> | null = null;
  srcMesh(url: string, idx: number) {
    let tpl = this.templates.get(url);

    if (!tpl) {
      if (!this.canonMap) {
        this.canonMap = new Map();

        for (const [k, v] of this.templates) {
          this.canonMap.set(canonTag(k), v);
        }
      }

      tpl = this.canonMap.get(canonTag(url));
    }

    if (!tpl) {
      return null;
    }

    const meshes: THREE.Mesh[] = [];
    tpl.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        meshes.push(c);
      }
    });

    return meshes[idx] ?? null;
  }
}
