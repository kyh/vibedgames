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

function loadGltf(url: string): Promise<GLTF> {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, (err) =>
      reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

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
    const scene = gltf.scene;
    const graded = new Set<THREE.Material>();
    scene.traverse((o) => {
      if (opts && o instanceof THREE.Mesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!(m instanceof THREE.MeshStandardMaterial) || graded.has(m)) continue;
          graded.add(m);
          if (opts.matte) {
            m.roughness = Math.max(m.roughness, 0.82);
            m.envMapIntensity = 0.35;
          }
          if (opts.tint !== undefined) m.color.setHex(opts.tint);
        }
      }
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        // characters ground themselves with blob shadows — keeping them out of
        // the shadow map lets the whole map render its shadows ONCE (static)
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        // skinned bounds are bind-pose; inflate them generously so real frustum
        // culling is safe (233 skinned meshes × no culling was the #1 call sink)
        const geo = mesh.geometry;
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        if (geo.boundingSphere)
          geo.boundingSphere.radius = Math.max(geo.boundingSphere.radius * 2.5, 2.5);
        mesh.frustumCulled = true;
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
      if (!this.clips.has(prefix + clip.name)) this.clips.set(prefix + clip.name, clip);
    }
  }

  clipNames(): string[] {
    return [...this.clips.keys()].sort();
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
        new THREE.MeshStandardMaterial({ color: 0xff00ff }),
      );
      box.position.y = 0.8;
      return box;
    }
    return cloneSkinned(tpl);
  }
}

// The Rig_Large library is much smaller than Rig_Medium's — map the Medium
// clip names the game plays onto their closest Large equivalent. A fallback
// must resolve to a LARGE clip (never cross-rig: the rest proportions differ).
const RIG_LARGE_FALLBACK: Record<string, string> = {
  Hit_B: "Hit_A",
  Death_B: "Death_A",
  Dodge_Backward: "Dodge_Backwards", // Large lib pluralizes this one clip name
  Jump_Full_Long: "Dodge_Forward",
  Jump_Full_Short: "Dodge_Forward",
  Walking_B: "Walking_A",
  Walking_C: "Walking_A",
  Running_B: "Running_A",
  Idle_B: "Idle_A",
  Spawn_Ground: "Idle_A",
  Spawn_Air: "Idle_A",
  PickUp: "Idle_A",
  Interact: "Idle_A",
  Use_Item: "Melee_Block",
  Throw: "Melee_2H_Attack",
  Melee_1H_Attack_Chop: "Melee_1H_Slash",
  Melee_1H_Attack_Slice_Horizontal: "Melee_1H_Slash",
  Melee_1H_Attack_Slice_Diagonal: "Melee_1H_Slash",
  Melee_1H_Attack_Stab: "Melee_1H_Stab",
  Melee_1H_Attack_Jump_Chop: "Melee_1H_Slash",
  Melee_2H_Attack_Chop: "Melee_2H_Attack",
  Melee_2H_Attack_Slice: "Melee_2H_Attack",
  Melee_2H_Attack_Stab: "Melee_2H_Attack",
  Melee_2H_Attack_Spin: "Melee_2H_Slam",
  Melee_2H_Attack_Spinning: "Melee_2H_Slam",
  Melee_Unarmed_Attack_Punch_A: "Melee_Unarmed_Punch",
  Melee_Unarmed_Attack_Kick: "Melee_Unarmed_Kick",
  Ranged_Magic_Spellcasting: "Melee_2H_Attack",
  Ranged_Magic_Shoot: "Melee_2H_Attack",
  Skeletons_Taunt: "Flexing",
  Skeletons_Idle: "Idle_B",
  // camp-creep spawn path: Large bodies (frostgolem elite) have no skeleton
  // rise-from-the-ground clip — resolve to idle instead of T-posing (a play()
  // miss no-ops and HOLDS whatever pose the rig is in)
  Skeletons_Spawn_Ground: "Idle_B",
};

export type PlayOpts = {
  fade?: number;
  loop?: boolean;
  /** Hold the final frame when a one-shot finishes. */
  clamp?: boolean;
  /** Playback rate multiplier. */
  timeScale?: number;
};

// The universal fallback pose — every rig (Medium + Large) resolves Idle_B, so
// a missing clip lands here instead of the bind T-pose.
const FALLBACK_IDLE = "Idle_B";

/** Wraps one character instance + its mixer; crossfades named clips. */
export class AnimatedCharacter {
  readonly root: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName = "";

  constructor(
    private lib: ModelLibrary,
    modelName: string,
    /** Clip-pool key prefix for this character's rig (e.g. "Large/"). */
    private clipPrefix = "",
  ) {
    this.root = lib.instance(modelName);
    this.mixer = new THREE.AnimationMixer(this.root);
  }

  get playing(): string {
    return this.currentName;
  }

  /** Resolve a clip name to its loaded THREE.AnimationClip (prefixed exact →
   *  prefixed fallback → unprefixed), or null. */
  private resolveClip(clipName: string): THREE.AnimationClip | undefined {
    return (
      this.lib.getClip(this.clipPrefix + clipName) ??
      (this.clipPrefix
        ? this.lib.getClip(this.clipPrefix + (RIG_LARGE_FALLBACK[clipName] ?? ""))
        : this.lib.getClip(clipName))
    );
  }

  /** Duration (seconds) of a resolved clip, or 0 if it isn't loaded. Used to
   *  size one-shot windows so a swing/cast always plays through its strike. */
  clipDuration(clipName: string): number {
    return this.resolveClip(clipName)?.duration ?? 0;
  }

  private action(clipName: string): THREE.AnimationAction | null {
    const existing = this.actions.get(clipName);
    if (existing) return existing;
    const clip = this.resolveClip(clipName);
    if (!clip) return null;
    const action = this.mixer.clipAction(clip);
    this.actions.set(clipName, action);
    return action;
  }

  /** Crossfade to a clip. No-op if already the current clip (unless one-shot). */
  play(clipName: string, opts: PlayOpts = {}): void {
    const { fade = 0.2, loop = true, clamp = false, timeScale = 1 } = opts;
    if (this.currentName === clipName && loop) return;
    const next = this.action(clipName);
    if (!next) {
      // Clip missing on this rig — NEVER leave the character in its bind T-pose.
      // Fall back to a neutral idle (if that resolves; else give up silently).
      if (clipName !== FALLBACK_IDLE && this.action(FALLBACK_IDLE)) {
        this.play(FALLBACK_IDLE, { fade, loop: true });
      }
      return;
    }
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(timeScale);
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = clamp;
    next.play();
    if (this.current && this.current !== next) this.current.crossFadeTo(next, fade, false);
    this.current = next;
    this.currentName = clipName;
  }

  /** Fire a one-shot (attack/cast/hit) then resolve when it finishes. */
  playOnce(clipName: string, opts: PlayOpts = {}): void {
    this.play(clipName, { ...opts, loop: false, clamp: opts.clamp ?? false });
  }

  /** Live playback-rate control for the current action (viewer speed slider —
   *  play()'s timeScale only applies at clip start). */
  setTimeScale(s: number): void {
    this.current?.setEffectiveTimeScale(s);
  }

  /** Attach an object to a named bone (e.g. "handslot.r") so it follows the
   *  hand through animations. Matches on a normalized name because GLTFLoader
   *  strips reserved chars (handslot.r → handslotr). Returns false if not found. */
  attach(obj: THREE.Object3D, boneName: string): boolean {
    const key = boneName.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const found: THREE.Object3D[] = [];
    this.root.traverse((o) => {
      if (o.name.replace(/[^a-z0-9]/gi, "").toLowerCase() === key) found.push(o);
    });
    const bone = found[0];
    if (!bone) return false;
    obj.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.frustumCulled = false;
      }
    });
    bone.add(obj);
    return true;
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}
