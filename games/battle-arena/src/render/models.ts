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

const MIRROR_SUFFIX = "@mirror";

/** The mirror-pair bone name (limb bones end in 'l'/'r'; central bones — root,
 *  hips, spine, chest, head — don't and stay put). Only swaps when the paired
 *  bone actually exists in the clip. GLTFLoader strips the '.' so bones read
 *  "upperarml" / "handslotr" etc. */
function mirrorBone(bone: string, present: Set<string>): string {
  if (bone.endsWith("l")) {
    const m = `${bone.slice(0, -1)}r`;
    if (present.has(m)) return m;
  } else if (bone.endsWith("r")) {
    const m = `${bone.slice(0, -1)}l`;
    if (present.has(m)) return m;
  }
  return bone;
}

/** Reflect a clip across the sagittal (X=0) plane so a swing sweeps the other
 *  way: swap l/r bone tracks, negate position-X, and negate the quaternion's
 *  y,z (matrix conjugation M·R·M with M = diag(-1,1,1) → (x, −y, −z, w)). */
function mirrorClip(base: THREE.AnimationClip, name: string): THREE.AnimationClip {
  const bones = new Set<string>();
  for (const t of base.tracks) bones.add(t.name.slice(0, Math.max(0, t.name.indexOf("."))));
  const tracks: THREE.KeyframeTrack[] = [];
  for (const t of base.tracks) {
    const dot = t.name.indexOf(".");
    const prop = t.name.slice(dot + 1);
    const trackName = `${mirrorBone(t.name.slice(0, dot), bones)}.${prop}`;
    const times = Array.from(t.times);
    const values = Array.from(t.values);
    if (prop === "position") {
      for (let i = 0; i < values.length; i += 3) values[i] = -(values[i] ?? 0);
      tracks.push(new THREE.VectorKeyframeTrack(trackName, times, values));
    } else if (prop === "quaternion") {
      for (let i = 0; i < values.length; i += 4) {
        values[i + 1] = -(values[i + 1] ?? 0);
        values[i + 2] = -(values[i + 2] ?? 0);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(trackName, times, values));
    } else {
      tracks.push(new THREE.VectorKeyframeTrack(trackName, times, values)); // scale: unchanged
    }
  }
  return new THREE.AnimationClip(name, base.duration, tracks);
}

export class ModelLibrary {
  private templates = new Map<string, THREE.Object3D>();
  private clips = new Map<string, THREE.AnimationClip>();

  /** Load a character/prop GLB or gltf (no clips). `matte` kills the glossy
   *  KayKit default (roughness ~0.45 + full IBL = plastic sheen); `tint`
   *  multiplies the atlas (the dungeon pack's pale mortar swatch reads as
   *  glowing seams without a warm-dark grade). */
  async loadCharacter(name: string, url: string, opts?: { matte?: boolean; tint?: number }): Promise<void> {
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
        if (geo.boundingSphere) geo.boundingSphere.radius = Math.max(geo.boundingSphere.radius * 2.5, 2.5);
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
    const cached = this.clips.get(name);
    if (cached) return cached;
    // "<clip>@mirror" = the clip reflected left↔right, built + cached on demand.
    // A right-to-left slice becomes a clean backhand left-to-right one, time
    // still forward (no un-swing). Keyed WITH the rig prefix so Large mirrors
    // never collide with Medium ones.
    if (name.endsWith(MIRROR_SUFFIX)) {
      const base = this.clips.get(name.slice(0, -MIRROR_SUFFIX.length));
      if (!base) return undefined;
      const mirrored = mirrorClip(base, name);
      this.clips.set(name, mirrored);
      return mirrored;
    }
    return undefined;
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
  Hit_B: "Hit_A", Death_B: "Death_A",
  Dodge_Backward: "Dodge_Backwards", // Large lib pluralizes this one clip name
  Jump_Full_Long: "Dodge_Forward", Jump_Full_Short: "Dodge_Forward",
  Walking_B: "Walking_A", Walking_C: "Walking_A", Running_B: "Running_A", Idle_B: "Idle_A",
  Spawn_Ground: "Idle_A", Spawn_Air: "Idle_A", PickUp: "Idle_A", Interact: "Idle_A",
  Use_Item: "Melee_Block", Throw: "Melee_2H_Attack",
  Melee_1H_Attack_Chop: "Melee_1H_Slash", Melee_1H_Attack_Slice_Horizontal: "Melee_1H_Slash",
  Melee_1H_Attack_Slice_Diagonal: "Melee_1H_Slash", Melee_1H_Attack_Stab: "Melee_1H_Stab",
  Melee_1H_Attack_Jump_Chop: "Melee_1H_Slash",
  Melee_2H_Attack_Chop: "Melee_2H_Attack", Melee_2H_Attack_Slice: "Melee_2H_Attack",
  Melee_2H_Attack_Stab: "Melee_2H_Attack", Melee_2H_Attack_Spin: "Melee_2H_Slam",
  Melee_2H_Attack_Spinning: "Melee_2H_Slam",
  Melee_Unarmed_Attack_Punch_A: "Melee_Unarmed_Punch", Melee_Unarmed_Attack_Kick: "Melee_Unarmed_Kick",
  Ranged_Magic_Spellcasting: "Melee_2H_Attack", Ranged_Magic_Shoot: "Melee_2H_Attack",
  Skeletons_Taunt: "Flexing", Skeletons_Idle: "Idle_B",
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

  private action(clipName: string): THREE.AnimationAction | null {
    const existing = this.actions.get(clipName);
    if (existing) return existing;
    // Resolve: prefixed exact → prefixed fallback → unprefixed (Medium rig only).
    const clip =
      this.lib.getClip(this.clipPrefix + clipName) ??
      (this.clipPrefix
        ? this.lib.getClip(this.clipPrefix + (RIG_LARGE_FALLBACK[clipName] ?? ""))
        : this.lib.getClip(clipName));
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
    if (!next) return;
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
