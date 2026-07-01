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

  /** Load a character GLB (self-contained skinned mesh, no clips). */
  async loadCharacter(name: string, url: string): Promise<void> {
    const gltf = await loadGltf(url);
    const scene = gltf.scene;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false; // skinned bounds are bind-pose; avoid wrong-cull popping
      }
    });
    this.templates.set(name, scene);
  }

  /** Harvest every clip from an animation-library GLB into the shared pool. */
  async loadClips(url: string): Promise<void> {
    const gltf = await loadGltf(url);
    for (const clip of gltf.animations) {
      if (!this.clips.has(clip.name)) this.clips.set(clip.name, clip);
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
    const clip = this.lib.getClip(clipName);
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
