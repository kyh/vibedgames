import * as THREE from "three";
import type { ModelLibrary } from "./models";

// The Rig_Large library is much smaller than Rig_Medium's — map the Medium
// clip names the game plays onto their closest Large equivalent. A fallback
// must resolve to a LARGE clip (never cross-rig: the rest proportions differ).
const RIG_LARGE_FALLBACK = new Map<string, string>(
  Object.entries({
    Death_B: "Death_A",
    // Large lib pluralizes this one clip name
    Dodge_Backward: "Dodge_Backwards",
    Hit_B: "Hit_A",
    Idle_B: "Idle_A",
    Interact: "Idle_A",
    Jump_Full_Long: "Dodge_Forward",
    Jump_Full_Short: "Dodge_Forward",
    Melee_1H_Attack_Chop: "Melee_1H_Slash",
    Melee_1H_Attack_Jump_Chop: "Melee_1H_Slash",
    Melee_1H_Attack_Slice_Diagonal: "Melee_1H_Slash",
    Melee_1H_Attack_Slice_Horizontal: "Melee_1H_Slash",
    Melee_1H_Attack_Stab: "Melee_1H_Stab",
    Melee_2H_Attack_Chop: "Melee_2H_Attack",
    Melee_2H_Attack_Slice: "Melee_2H_Attack",
    Melee_2H_Attack_Spin: "Melee_2H_Slam",
    Melee_2H_Attack_Spinning: "Melee_2H_Slam",
    Melee_2H_Attack_Stab: "Melee_2H_Attack",
    Melee_Unarmed_Attack_Kick: "Melee_Unarmed_Kick",
    Melee_Unarmed_Attack_Punch_A: "Melee_Unarmed_Punch",
    PickUp: "Idle_A",
    Ranged_Magic_Shoot: "Melee_2H_Attack",
    Ranged_Magic_Spellcasting: "Melee_2H_Attack",
    Running_B: "Running_A",
    Skeletons_Idle: "Idle_B",
    // camp-creep spawn path: Large bodies (frostgolem elite) have no skeleton
    // rise-from-the-ground clip — resolve to idle instead of T-posing (a play()
    // miss no-ops and HOLDS whatever pose the rig is in)
    Skeletons_Spawn_Ground: "Idle_B",
    Skeletons_Taunt: "Flexing",
    Spawn_Air: "Idle_A",
    Spawn_Ground: "Idle_A",
    Throw: "Melee_2H_Attack",
    Use_Item: "Melee_Block",
    Walking_B: "Walking_A",
    Walking_C: "Walking_A",
  } satisfies Record<string, string>),
);

export interface PlayOpts {
  fade?: number;
  loop?: boolean;
  /** Hold the final frame when a one-shot finishes. */
  clamp?: boolean;
  /** Playback rate multiplier. */
  timeScale?: number;
  /** Authored clip seconds already elapsed when an accepted snapshot arrives. */
  offset?: number;
}

// The universal fallback pose — every rig (Medium + Large) resolves Idle_B, so
// a missing clip lands here instead of the bind T-pose.
const FALLBACK_IDLE = "Idle_B";

/** Wraps one character instance + its mixer; crossfades named clips. */
export class AnimatedCharacter {
  readonly root: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<
    THREE.AnimationClip,
    { first: THREE.AnimationAction; second: THREE.AnimationAction | null }
  >();
  private current: THREE.AnimationAction | null = null;
  private currentName = "";
  private fading: { action: THREE.AnimationAction; left: number } | null = null;

  private lib: ModelLibrary;
  /** Clip-pool key prefix for this character's rig (e.g. "Large/"). */
  private clipPrefix: string;

  constructor(lib: ModelLibrary, modelName: string, clipPrefix = "") {
    this.lib = lib;
    this.clipPrefix = clipPrefix;
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
        ? this.lib.getClip(this.clipPrefix + (RIG_LARGE_FALLBACK.get(clipName) ?? ""))
        : this.lib.getClip(clipName))
    );
  }

  /** Duration (seconds) of a resolved clip, or 0 if it isn't loaded. Used to
   *  size one-shot windows so a swing/cast always plays through its strike. */
  clipDuration(clipName: string): number {
    return this.resolveClip(clipName)?.duration ?? 0;
  }

  private action(clipName: string): THREE.AnimationAction | null {
    const clip = this.resolveClip(clipName);
    if (!clip) {
      return null;
    }
    let pair = this.actions.get(clip);
    if (!pair) {
      pair = { first: this.mixer.clipAction(clip), second: null };
      this.actions.set(clip, pair);
    }
    if (pair.first !== this.current) {
      return pair.first;
    }
    // Two actions let a repeated shot blend out of its previous pose instead
    // of resetting that same action. Tracks stay shared and immutable.
    if (!pair.second) {
      const alternate = new THREE.AnimationClip(
        clip.name,
        clip.duration,
        clip.tracks,
        clip.blendMode,
      );
      pair.second = this.mixer.clipAction(alternate);
    }
    return pair.second;
  }

  /** Crossfade to a clip. No-op if already the current clip (unless one-shot). */
  play(clipName: string, opts: PlayOpts = {}): void {
    const { fade = 0.2, loop = true, clamp = false, timeScale = 1, offset = 0 } = opts;
    if (this.currentName === clipName && loop) {
      return;
    }
    const next = this.action(clipName);
    if (!next) {
      // Clip missing on this rig — NEVER leave the character in its bind T-pose.
      // Fall back to a neutral idle (if that resolves; else give up silently).
      if (clipName !== FALLBACK_IDLE && this.resolveClip(FALLBACK_IDLE)) {
        this.play(FALLBACK_IDLE, { fade, loop: true });
      }
      return;
    }
    // At most the current pose and one outgoing pose are active. A third
    // interruption retires the old fade, never a newly reused incoming action.
    this.fading?.action.stop();
    this.fading = null;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(timeScale);
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = clamp;
    next.time = Math.max(0, Math.min(next.getClip().duration, offset));
    next.play();
    if (this.current && this.current !== next) {
      if (fade > 0) {
        this.current.crossFadeTo(next, fade, false);
        this.fading = { action: this.current, left: fade };
      } else {
        this.current.stop();
      }
    }
    this.current = next;
    this.currentName = clipName;
  }

  /** Fire a one-shot (attack/cast/hit) then resolve when it finishes. */
  playOnce(clipName: string, opts: PlayOpts = {}): void {
    this.play(clipName, { ...opts, clamp: opts.clamp ?? false, loop: false });
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
    const key = boneName.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
    const found: THREE.Object3D[] = [];
    this.root.traverse((o) => {
      if (o.name.replaceAll(/[^a-z0-9]/giu, "").toLowerCase() === key) {
        found.push(o);
      }
    });
    const [bone] = found;
    if (!bone) {
      return false;
    }
    obj.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.castShadow = true;
        c.frustumCulled = false;
      }
    });
    bone.add(obj);
    return true;
  }

  update(dt: number): void {
    this.mixer.update(dt);
    if (this.fading) {
      this.fading.left -= dt;
      if (this.fading.left <= 0) {
        this.fading.action.stop();
        this.fading = null;
      }
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.actions.clear();
    this.current = null;
    this.fading = null;
  }
}
