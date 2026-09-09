// GLB model library + animated-character wrapper.
//
// KayKit ships character meshes with ZERO embedded clips; the whole animation
// library lives in separate Mannequin GLBs that share the SAME 23-joint
// "Rig_Medium" skeleton (identical bone names). So we load the clip library
// once, then bind any clip onto any character instance by bone name.
//
// Skinned meshes MUST be cloned with SkeletonUtils.clone (a plain Object3D
// clone reuses the source bones and every instance collapses onto the original).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

const loader = new GLTFLoader();

const loadGltf = async (url: string): Promise<GLTF> => {
  try {
    return await loader.loadAsync(url);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export class ModelLibrary {
  private templates = new Map<string, THREE.Object3D>();
  private clips = new Map<string, THREE.AnimationClip>();

  /** Load a character/prop GLB or gltf (no clips). `matte` kills the glossy
   *  KayKit default (roughness ~0.45 + full IBL = plastic sheen); `tint`
   *  multiplies the atlas (the dungeon pack's pale mortar swatch reads as
   *  glowing seams without a warm-dark grade). */
  async loadCharacter(
    name: string,
    url: string,
    opts?: { matte?: boolean; tint?: number },
  ): Promise<void> {
    const gltf = await loadGltf(url);
    const { scene } = gltf;
    const graded = new Set<THREE.Material>();
    scene.traverse((o) => {
      if (opts && o instanceof THREE.Mesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!(m instanceof THREE.MeshStandardMaterial) || graded.has(m)) {
            continue;
          }
          graded.add(m);
          if (opts.matte) {
            m.roughness = Math.max(m.roughness, 0.82);
            m.envMapIntensity = 0.35;
          }
          if (opts.tint !== undefined) {
            m.color.setHex(opts.tint);
          }
        }
      }
      if (o instanceof THREE.Mesh) {
        // characters ground themselves with blob shadows — keeping them out of
        // the shadow map lets the whole map render its shadows ONCE (static)
        o.castShadow = false;
        o.receiveShadow = true;
        // skinned bounds are bind-pose; inflate them generously so real frustum
        // culling is safe (233 skinned meshes × no culling was the #1 call sink)
        const geo = o.geometry;
        if (!geo.boundingSphere) {
          geo.computeBoundingSphere();
        }
        if (geo.boundingSphere) {
          geo.boundingSphere.radius = Math.max(geo.boundingSphere.radius * 2.5, 2.5);
        }
        o.frustumCulled = true;
      }
    });
    this.templates.set(name, scene);
  }

  /** Harvest every clip from an animation-library GLB into the shared pool.
   *  Rig_Large clip names collide with Rig_Medium (Idle_A, Running_A, …), so
   *  Large libraries load under a key prefix (e.g. "Large/") and characters on
   *  that rig resolve through AnimatedCharacter's clipPrefix. */
  async loadClips(url: string, prefix = ""): Promise<void> {
    const gltf = await loadGltf(url);
    for (const clip of gltf.animations) {
      if (!this.clips.has(prefix + clip.name)) {
        this.clips.set(prefix + clip.name, clip);
      }
    }
  }

  clipNames(): string[] {
    return [...this.clips.keys()].toSorted();
  }

  getClip(name: string): THREE.AnimationClip | undefined {
    return this.clips.get(name);
  }

  /** A fresh, independently-animatable copy of a loaded character. */
  instance(name: string): THREE.Object3D {
    const tpl = this.templates.get(name);
    if (!tpl) {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 1.6, 0.6),
        new THREE.MeshStandardMaterial({ color: 0xff_00_ff }),
      );
      box.position.y = 0.8;
      return box;
    }
    return cloneSkinned(tpl);
  }
}
