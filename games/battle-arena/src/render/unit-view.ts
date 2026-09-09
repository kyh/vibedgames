// One hero/creep visual: the animated character, its weapons + blade trails,
// selection ring, contact shadow, and the clip picked from its unit state.
// Never mutates the sim.
import * as THREE from "three";
import { CHAMP_BY_ID } from "../data/champions";
import { ABILITY_CLIPS, TWO_H_SPEED, clipSpeed, swingClip } from "../data/clip-timing";
import { HOP_HEIGHT, JUMP_MS } from "../data/config";
import type { DamageType } from "../data/config";
import { terrainHeight } from "../data/terrain";
import { effectiveAttackSpeed } from "../sim/stats";
import type { Unit } from "../sim/types";
import { applyDissolve } from "./dissolve";
import type { DissolveHandle } from "./dissolve";
import { CHAMP_FX } from "./fx";
import type { Fx } from "./fx";
import { cloneMats, disposeMat } from "./instance-mats";
import { AnimatedCharacter } from "./animated-character";
import type { ModelLibrary } from "./models";
import { LOCAL_COLOR } from "./palette";
import { StatusFx } from "./status-fx";
import { WeaponTrail } from "./weapon-trail";
import type { TrailOverride } from "./weapon-trail";

// Clip choices + strike timing live in data/clip-timing.ts (ABILITY_CLIPS /
// ATTACK_SETS / clipSpeed) — ONE table shared with the sim, so the damage tick
// and the animation's contact frame can never drift apart.

// 2H/hammer blades whose bbox longest-axis heuristic degenerates (the head is
// wider than the shaft, so the ribbon sweeps sideways off the head instead of
// tracing the swing). Force the swing axis + blade extents so the arc reads.
// `base` = fraction up the weapon where the ribbon starts (skip the handle).
const TRAIL_OVERRIDE = new Map<string, TrailOverride>([
  // thin head — runs a touch hotter
  ["paladin_hammer", { axis: "y", base: 0.48, opacity: 0.62, tip: 1.15 }],
  ["sword_2handed", { axis: "y", base: 0.34, tip: 1.05 }],
]);

// Blade-trail tint per champ, in REAL color (a near-white tint reads as a plain
// white sheet once the hot edge is layered on top). Creeps: cold bone-steel.
const TRAIL_COLOR = new Map<string, number>([
  // Aurelius — dawn gold
  ["blackknight", 0xff_c2_4a],
  // Garran — steel blue
  ["knight", 0x6a_9a_ff],
  // Vesper — crimson
  ["rogue", 0xff_70_90],
]);
const CREEP_TRAIL_COLOR = 0x9f_b8_e0;

// KayKit medium characters face +Z; sim aim is (cos facing, sin facing) on (x,z).
const MODEL_YAW = 0;

// Per-weapon mount corrections (radians), applied to the instance before it
// parents to the handslot bone. Most KayKit weapons are authored to sit right
// in the hand as-is; the bow ships pointing backwards.
const WEAPON_MOUNT = new Map<string, { rx?: number; ry?: number; rz?: number }>([
  ["bow", { ry: Math.PI }],
  // ships head-sideways; face the head forward
  ["paladin_hammer", { ry: Math.PI / 2 }],
]);

/** Apply a weapon's mount correction (no-op for unlisted weapons). */
const mountWeapon = (obj: THREE.Object3D, name: string): void => {
  const m = WEAPON_MOUNT.get(name);
  if (!m) {
    return;
  }
  obj.rotation.set(m.rx ?? 0, m.ry ?? 0, m.rz ?? 0);
};

// Animation timing (render only). Clips play at their NATURAL speed (or their
// data/clip-timing speed override) and each one-shot's window is the clip's
// own length (clamped), so a swing/cast plays through its full motion instead
// of being cut at the wind-up. When a faster attack or a new cast arrives it
// interrupts naturally.
// floor so a very short clip still holds a beat
const ONE_SHOT_MIN_MS = 240;
// ceiling so nothing locks the character forever
const ONE_SHOT_CAP_MS = 2500;
// whirlwind ult — a looping channel
const SPIN_LOOP_CLIP = "Melee_2H_Attack_Spinning";
/** Natural one-shot window (ms) for a clip playing at `speed`: its own duration
 *  divided by the rate, clamped. */
const clipWindowMs = (durSec: number, speed = 1): number =>
  Math.min(ONE_SHOT_CAP_MS, Math.max(ONE_SHOT_MIN_MS, (durSec / speed) * 1000));
// an attack event older than this is stale — skip
const ATTACK_RECENCY_MS = 340;
// recency window for detecting a fresh cast event
const CAST_ANIM_MS = 520;
// flinch beat — Hit_A/B are SPED to fit (never cut)
const HIT_ANIM_MS = 300;
// Jump animation is a 3-phase state machine: takeoff → airborne float → land.
const JUMP_START_CLIP = "Jump_Start";
const JUMP_IDLE_CLIP = "Jump_Idle";
const JUMP_LAND_CLIP = "Jump_Land";
// takeoff clip plays over the first slice of airtime
const JUMP_START_MS = 340;
// land clip plays over the last slice (Idle floats the middle)
const JUMP_LAND_MS = 340;
const GOLD = new THREE.Color(0xff_d2_4a);

type JumpPhase = "" | "start" | "idle" | "land";

// minimal descriptor a UnitView needs (ChampDef satisfies it; so do creeps)
export interface ViewDef {
  id: string;
  model: string;
  attackType: "melee" | "ranged";
  attackDamageType: DamageType;
  weaponR?: string;
  weaponL?: string;
  rig?: "large";
  scale?: number;
  // rests + idles holding a 2H weapon (Melee_2H_Idle)
  twoHanded?: boolean;
}

// shared soft radial texture for blob contact-shadows
let blobTexCache: THREE.Texture | null = null;
const blobTex = (): THREE.Texture => {
  if (blobTexCache) {
    return blobTexCache;
  }
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d");
  if (!g) {
    blobTexCache = new THREE.Texture();
    return blobTexCache;
  }
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(0,0,0,0.85)");
  grad.addColorStop(0.6, "rgba(0,0,0,0.4)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  blobTexCache = new THREE.CanvasTexture(c);
  return blobTexCache;
};

const locomotion = (u: Unit, twoHanded: boolean): string => {
  const speed = Math.hypot(u.vx, u.vy);
  if (speed > u.moveSpeed * 0.55) {
    return "Running_B";
  }
  if (speed > 0.4) {
    return "Walking_A";
  }
  // 2H wielders rest holding the weapon (KayKit has no 2H run — walk/run stay
  // generic); the 2H idle only kicks in when effectively stationary
  return twoHanded ? "Melee_2H_Idle" : "Idle_B";
};

const attackClip = (def: ViewDef): string => {
  if (def.attackType === "ranged") {
    return def.attackDamageType === "magic" ? "Ranged_Magic_Shoot" : "Ranged_Bow_Release";
  }
  // Garran (2H greatsword) swings the Melee_2H set; Aurelius (1H hammer) + the
  // dagger rogue keep their 1H/dualwield clips.
  if (def.twoHanded) {
    return "Melee_2H_Attack_Chop";
  }
  return def.id === "rogue" ? "Melee_1H_Attack_Slice_Diagonal" : "Melee_1H_Attack_Chop";
};

const castClip = (def: ViewDef): string => {
  if (def.attackDamageType === "magic") {
    return "Ranged_Magic_Spellcasting";
  }
  // physical champs "cast" with a weapon-appropriate swing, not a throw
  return attackClip(def);
};

/** Which of the 3 hop clips owns this instant of airtime. */
const jumpPhaseAt = (remain: number): JumpPhase => {
  if (remain <= JUMP_LAND_MS) {
    return "land";
  }
  return JUMP_MS - remain < JUMP_START_MS ? "start" : "idle";
};

export class UnitView {
  readonly group = new THREE.Group();
  private scene: THREE.Scene;
  private lib: ModelLibrary;
  private color: number;
  private isLocal: boolean;
  private isCreep: boolean;
  private char: AnimatedCharacter;
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private ringBase: THREE.Color;
  private def: ViewDef;
  private baseScale: number;
  private deadShown = false;
  private placed = false;
  private wasAlive = true;
  private yaw = 0;
  // smoothed ground under the feet (see update)
  private groundY = 0;
  private lastAttackShown = -1;
  private lastCastShown = -1;
  private lastHitShown = -1;
  private lastFlinchAt = -1;
  private jumpPhase: JumpPhase = "";
  private oneShotUntil = 0;
  private deadAt = -1;
  private lastDustAt = 0;
  private hitIdx = 0;
  // render-only knockback lurch (decays); shadow stays put
  private recoilX = 0;
  private recoilZ = 0;
  private weapons: THREE.Object3D[] = [];
  private mats: THREE.MeshStandardMaterial[] = [];
  // windup glint + StatusFx empower / dispose
  private weaponMats: THREE.MeshStandardMaterial[] = [];
  private trails: WeaponTrail[] = [];
  // contact shadow (scene sibling, decoupled from hopY)
  private blob: THREE.Mesh;
  private dissolve: DissolveHandle;
  private statusFx: StatusFx | null = null;
  // landing squash & dash-trail state
  private prevHop = 0;
  private squash = 0;
  private wasDashing = false;
  private lastDashTrailAt = 0;
  private lastDashDustAt = 0;
  private lastGhostAt = 0;
  private lastUltMoteAt = 0;
  private spawnClipPending = false;
  // witch hex: character swaps to a hopping mushroom while the status lives
  private mushroom: THREE.Object3D | null = null;
  private mushScale = 1;
  private hexShown = false;

  constructor(
    scene: THREE.Scene,
    lib: ModelLibrary,
    def: ViewDef,
    color: number,
    isLocal: boolean,
    isCreep: boolean,
  ) {
    this.scene = scene;
    this.lib = lib;
    this.color = color;
    this.isLocal = isLocal;
    this.isCreep = isCreep;
    this.def = def;
    this.baseScale = def.scale ?? 1;
    this.char = new AnimatedCharacter(lib, def.model, def.rig === "large" ? "Large/" : "");
    this.char.root.scale.setScalar(this.baseScale);
    this.group.add(this.char.root);

    const identity = isLocal ? LOCAL_COLOR : color;
    // clone materials per-instance so hit-flash / stealth / team-tint don't
    // bleed across units that share a model (SkeletonUtils.clone shares mats).
    this.mats = cloneMats(this.char.root, new THREE.Color(identity));

    // give the champion their weapon(s), bound to the hand bones. Weapon mats
    // are ALSO cloned per-instance (windup glint / empower glow must not bleed).
    const melee = def.attackType === "melee";
    if (def.weaponR) {
      this.mountHand(
        def.weaponR,
        "handslot.r",
        melee,
        TRAIL_COLOR.get(def.id) ?? CREEP_TRAIL_COLOR,
      );
    }
    if (def.weaponL) {
      // dual-wielders slash with BOTH blades — the off-hand gets its own ribbon
      this.mountHand(
        def.weaponL,
        "handslot.l",
        melee && Boolean(def.weaponR),
        def.id === "rogue" ? 0xff_70_90 : CREEP_TRAIL_COLOR,
      );
    }

    // death dissolve — patched ONCE at construction on the per-instance mats
    this.dissolve = applyDissolve(this.mats);
    this.dissolve.setEdge(isCreep ? 0xcf_d8_e0 : identity);

    // local ring is larger + fainter so it reads as a clean circle on the ground
    // around your feet — a tight ring gets occluded by the body into "floating"
    // slivers. Non-local stays a small footprint tag.
    const innerR = (isLocal ? 1.15 : 0.7) * this.baseScale;
    const outerR = (isLocal ? 1.35 : 0.95) * this.baseScale;
    this.ringBase = new THREE.Color(identity);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: identity,
      depthWrite: false,
      opacity: isLocal ? 0.55 : 0.6,
      side: THREE.DoubleSide,
      transparent: true,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(innerR, outerR, 48), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    // 0.10: the flagstone tile tops are authored at +0.05 — anything ≤0.05
    // clips into (or z-fights) the stones
    this.ring.position.y = 0.1;
    this.group.add(this.ring);

    // soft blob contact-shadow on the ground (its own scene mesh so it stays on
    // the terrain when the unit jumps, instead of lifting with the body)
    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.85, 20),
      new THREE.MeshBasicMaterial({
        color: 0x00_00_00,
        depthWrite: false,
        map: blobTex(),
        opacity: 0.42,
        transparent: true,
      }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    // under additive VFX
    this.blob.renderOrder = -0.5;
    this.scene.add(this.blob);

    // bind a base idle IMMEDIATELY — a unit must never render its bind T-pose,
    // even for the frame(s) before the first sync-driven clip lands
    this.char.play("Idle_B", { fade: 0 });
    // heroes drop in (Spawn_Air); skeletons awaken from the floor
    this.spawnClipPending = true;
  }

  /** Instance a weapon into a hand bone, with its blade trail (melee only) —
   *  built pre-attach so the blade segment is in local space. */
  private mountHand(name: string, bone: string, withTrail: boolean, trailColor: number): void {
    const w = this.lib.instance(name);
    mountWeapon(w, name);
    const trail = withTrail ? new WeaponTrail(w, trailColor, TRAIL_OVERRIDE.get(name)) : null;
    if (this.char.attach(w, bone)) {
      this.weapons.push(w);
      this.weaponMats.push(...cloneMats(w, null));
      if (trail) {
        this.trails.push(trail);
        this.scene.add(trail.mesh);
      }
    } else {
      trail?.dispose();
    }
  }

  update(u: Unit, now: number, dt: number, fx: Fx | null, spinning: boolean): void {
    const respawned = u.alive && !this.wasAlive;
    // vertical hop arc while airborne (sin 0→π over the jump window) + the
    // terrain height under the unit (render-only; the sim stays flat)
    const hopY =
      u.alive && u.jumpUntil > now
        ? Math.sin((1 - (u.jumpUntil - now) / JUMP_MS) * Math.PI) * HOP_HEIGHT
        : 0;
    const groundY = terrainHeight(u.x, u.y);
    this.place(u, dt, respawned, hopY, groundY);
    this.wasAlive = u.alive;

    if (!u.alive) {
      this.updateDead(u, now, dt, fx, groundY);
      return;
    }
    this.revive();
    this.playSpawnClips(u, now, fx, respawned);
    this.updateHex(u, now);

    this.playEventOneShots(u, now, fx);
    this.playHitFlinch(u, now, spinning);
    this.playBaseClip(u, now, spinning);
    this.char.update(dt);
    // sample the blade AFTER the pose updates
    this.updateTrails(dt);

    this.updateSquash(u, dt, fx, hopY);
    this.updateDashFx(u, now, fx);

    // footstep dust on fast ground movement (grounds the run cycle)
    const spd = Math.hypot(u.vx, u.vy);
    if (fx && spd > u.moveSpeed * 0.55 && u.jumpUntil <= now && now - this.lastDustAt > 170) {
      this.lastDustAt = now;
      fx.footDust(u.x, u.y, -u.vx, -u.vy);
    }

    if (this.isLocal) {
      this.updateUltRing(u, now, fx);
    }

    // hit flash (white pulse on damage) — on this unit's cloned materials
    const flash = Math.max(0, 1 - (now - u.lastHitAt) / 110);
    for (const m of this.mats) {
      m.emissive.setRGB(flash, flash * 0.85, flash * 0.7);
    }
    // melee windup glint — micro-anticipation while a swing charges (90–140ms)
    const glint = u.pendingAttack ? 0.35 : 0;
    for (const m of this.weaponMats) {
      m.emissive.setRGB(glint, glint, glint);
    }

    // ── status indicators (stun star / shield dome / slow tint / embers…) ──
    // built lazily on the first status; StatusFx owns stealth opacity + empower
    // weapon glow (per-frame, AFTER the glint baseline above).
    if (fx && !this.statusFx && (u.statuses.length > 0 || u.empowerNext > 0)) {
      this.statusFx = new StatusFx(
        {
          accent: CHAMP_FX.get(this.def.id)?.accent ?? 0x9f_d0_ff,
          bodyMats: this.mats,
          group: this.group,
          isLocal: this.isLocal,
          weaponMats: this.weaponMats,
        },
        fx.pools,
      );
    }
    this.statusFx?.update(u, dt, now);
  }

  /** Position, ground-settle, knockback lurch, shadow and yaw. */
  private place(u: Unit, dt: number, respawned: boolean, hopY: number, groundY: number): void {
    // smooth toward the sim position; snap on first appearance, respawn, or a
    // big jump (blink/teleport) so the character doesn't slide across the map.
    const jumped = (u.x - this.group.position.x) ** 2 + (u.y - this.group.position.z) ** 2 > 36;
    if (!this.placed || respawned || jumped) {
      this.groundY = groundY;
      this.group.position.set(u.x, groundY + hopY, u.y);
      this.yaw = Math.atan2(u.aimX, u.aimY) + MODEL_YAW;
      this.placed = true;
    } else {
      const a = Math.min(1, 26 * dt);
      this.group.position.x += (u.x - this.group.position.x) * a;
      this.group.position.z += (u.y - this.group.position.z) * a;
      // feet settle onto the ground rather than teleporting to it: the stair ramp
      // is continuous, but a blink/knockback across the cliff still steps a whole
      // level in one tick — smooth it (the hop arc stays authored on top).
      this.groundY += (groundY - this.groundY) * Math.min(1, 18 * dt);
      this.group.position.y = this.groundY + hopY;
    }
    // render-only knockback lurch: the model recoils in the hit direction and
    // springs back while the shadow stays planted (physical "enemy reaction")
    this.recoilX *= Math.max(0, 1 - dt * 9);
    this.recoilZ *= Math.max(0, 1 - dt * 9);
    this.group.position.x += this.recoilX;
    this.group.position.z += this.recoilZ;
    // blob contact-shadow rides the terrain (never the hop), shrinking as the
    // unit rises so it reads as a cast shadow
    // clear the 0.05 tile tops
    this.blob.position.set(u.x, this.groundY + 0.08, u.y);
    this.blob.visible = u.alive;
    this.blob.scale.setScalar(this.baseScale * Math.max(0.45, 1 - hopY * 0.28));

    // shortest-arc yaw smoothing (no instant 180° snaps)
    const targetYaw = Math.atan2(u.aimX, u.aimY) + MODEL_YAW;
    const d = Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw));
    this.yaw += d * Math.min(1, 16 * dt);
    this.group.rotation.y = this.yaw;
  }

  private updateDead(u: Unit, now: number, dt: number, fx: Fx | null, groundY: number): void {
    if (this.hexShown) {
      this.setHex(false);
    }
    if (!this.deadShown) {
      this.char.play("Death_A", { clamp: true, fade: 0.12, loop: false });
      this.deadShown = true;
      this.deadAt = now;
      this.oneShotUntil = 0;
      // rising soul wisps on the death frame
      const soul = new THREE.Color(this.def.attackDamageType === "magic" ? 0x9a_7b_ff : 0x9f_d0_ff);
      fx?.fountain(u.x, u.y, 12, soul.getHex());
    }
    this.ring.visible = false;
    const k = Math.min(1, (now - this.deadAt) / 600);
    if (this.isCreep) {
      // creeps dissolve away completely, sinking as they go (bone-white edge)
      this.dissolve.set(k);
      this.group.position.y = groundY - 0.4 * k;
    } else {
      // heroes dissolve partway (cap 0.55) into the cold-ghost hold — the
      // corpse stays readable until the respawn
      this.dissolve.set(0.55 * k);
      const op = 1 - k * 0.82;
      const glow = (1 - k) * 0.25;
      for (const m of this.mats) {
        m.transparent = true;
        m.opacity = op;
        m.emissive.setRGB(glow * 0.5, glow * 0.6, glow);
      }
    }
    // clears status writes for the dissolve
    this.statusFx?.update(u, dt, now);
    this.char.update(dt);
    // let any lingering trail fade out
    this.updateTrails(dt);
  }

  /** Alive frame: undo whatever the death dissolve clobbered. */
  private revive(): void {
    if (this.deadShown) {
      this.dissolve.set(0);
      for (const m of this.mats) {
        m.opacity = 1;
        m.transparent = false;
        m.emissive.setRGB(0, 0, 0);
      }
    }
    this.deadShown = false;
    this.ring.visible = true;
  }

  private playSpawnClips(u: Unit, now: number, fx: Fx | null, respawned: boolean): void {
    // hero respawn: beam + converge + Spawn_Air drop-in
    if (respawned && !this.isCreep) {
      fx?.respawnBurst(u.x, u.y, this.isLocal ? LOCAL_COLOR : this.color, this.isLocal);
      this.char.play("Spawn_Air", { fade: 0.05, loop: false });
      this.oneShotUntil = now + clipWindowMs(this.char.clipDuration("Spawn_Air"));
    }
    // first frame: heroes drop from the air (Spawn_Air), skeletons awaken from
    // the floor (Skeletons_Awaken_Floor) — the full clip at natural speed
    if (this.spawnClipPending) {
      this.spawnClipPending = false;
      const spawnClip = this.isCreep ? "Skeletons_Awaken_Floor" : "Spawn_Air";
      this.char.play(spawnClip, { fade: 0, loop: false });
      this.oneShotUntil = now + clipWindowMs(this.char.clipDuration(spawnClip));
      fx?.dust(u.x, u.y, 4);
    }
  }

  /** Render-only status swap (synced statuses → identical on guests). */
  private updateHex(u: Unit, now: number): void {
    const hexed = u.statuses.some((s) => s.kind === "hex");
    if (hexed !== this.hexShown) {
      this.setHex(hexed);
    }
    if (this.mushroom && this.hexShown) {
      // hop-squash idle: volume-conserving wobble + a tiny bounce
      const b = Math.sin(now * 0.009);
      this.mushroom.scale.set(
        this.mushScale * (1 - 0.07 * b),
        this.mushScale * (1 + 0.12 * b),
        this.mushScale * (1 - 0.07 * b),
      );
      this.mushroom.position.y = Math.max(0, b) * 0.14;
    }
  }

  // one-shots are triggered ON THE EVENT (delta), never per-frame — otherwise
  // play() would reset the clip to frame 0 every frame and freeze it.
  private playEventOneShots(u: Unit, now: number, fx: Fx | null): void {
    if (u.lastCastAt !== this.lastCastShown) {
      this.lastCastShown = u.lastCastAt;
      if (now - u.lastCastAt < CAST_ANIM_MS) {
        this.playCast(u, now);
      }
    } else if (u.lastAttackAt !== this.lastAttackShown) {
      this.lastAttackShown = u.lastAttackAt;
      if (now - u.lastAttackAt < ATTACK_RECENCY_MS) {
        this.playAttack(u, now, fx);
      }
    }
  }

  private playCast(u: Unit, now: number): void {
    const ch = this.char;
    const clip =
      (u.lastCastKey ? ABILITY_CLIPS.get(this.def.id)?.[u.lastCastKey] : undefined) ??
      castClip(this.def);
    // The whirlwind's clip is a LOOP (the `spinning` branch drives it) — don't
    // fire it as a one-shot here or it plays once and freezes.
    if (clip === SPIN_LOOP_CLIP) {
      return;
    }
    // shared table — the sim's strike waits for this exact contact frame
    const ts = clipSpeed(clip);
    const winMs = clipWindowMs(ch.clipDuration(clip), ts);
    ch.play(clip, { fade: 0.06, loop: false, timeScale: ts });
    this.oneShotUntil = now + winMs;
    // weapon-trail ribbon on the ability swing
    this.emitTrails(winMs);
  }

  private playAttack(u: Unit, now: number, fx: Fx | null): void {
    const ch = this.char;
    // pick by the SYNCED swing counter so the clip matches the sim rhythm
    // (the slow swing that hits harder plays its heavy clip). Same
    // swingClip() call the sim used to schedule this swing's damage.
    const clip = swingClip(this.def.id, u.swingCount);
    const clipDur = ch.clipDuration(clip);
    // NO SWING EVER CLIPS: speed each swing just enough that the WHOLE clip
    // plays within its actual interval (base rate × this swing's rhythm
    // timeMult — so a slowed swing like Vesper's plays at natural speed, and
    // a fast one is sped to fit). Mirrors sim/combat.ts strikeMs(): using
    // the status-folded attack speed keeps the contact frame aligned even
    // under Hunter's-Focus-style haste.
    const rhythm = CHAMP_BY_ID[this.def.id]?.basicRhythm;
    const swing = Math.max(0, u.swingCount - 1);
    const timeMult = rhythm && rhythm.length ? (rhythm[swing % rhythm.length]?.timeMult ?? 1) : 1;
    const intervalMs = (timeMult * 1000) / Math.max(0.1, effectiveAttackSpeed(u));
    const ts =
      clipDur > 0 ? Math.max(clipSpeed(clip), (clipDur * 1000) / intervalMs) : clipSpeed(clip);
    const winMs = clipWindowMs(clipDur, ts);
    ch.play(clip, { fade: 0.04, loop: false, timeScale: ts });
    this.oneShotUntil = now + winMs;
    // weapon-trail ribbon traces the blade — the slash VFX is the shader ribbon
    // in weapon-trail.ts, tracing the real animated blade across the WHOLE
    // swing; no billboard stamp
    this.emitTrails(winMs);
    fx?.attackSound(this.def.id, u.x, u.y);
  }

  // get-hit flinch — when freshly damaged and not mid-swing/cast (throttled so
  // a flurry of hits doesn't lock the character in permanent flinch)
  private playHitFlinch(u: Unit, now: number, spinning: boolean): void {
    if (u.lastHitAt === this.lastHitShown) {
      return;
    }
    this.lastHitShown = u.lastHitAt;
    // knockback lurch on every fresh hit (even when the flinch anim is throttled)
    if (u.alive && now - u.lastHitAt < 180) {
      this.recoilX = u.lastHitDx * 0.34;
      this.recoilZ = u.lastHitDy * 0.34;
    }
    if (
      !spinning &&
      u.alive &&
      now - u.lastHitAt < 180 &&
      now >= this.oneShotUntil &&
      now - this.lastFlinchAt > 420
    ) {
      const ch = this.char;
      // fit the flinch clip INTO its short beat (sped, not cut)
      const flinch = this.hitIdx % 2 ? "Hit_B" : "Hit_A";
      this.hitIdx += 1;
      const fts = Math.max(1, (ch.clipDuration(flinch) * 1000) / HIT_ANIM_MS);
      ch.play(flinch, { fade: 0.05, loop: false, timeScale: fts });
      this.oneShotUntil = now + HIT_ANIM_MS;
      this.lastFlinchAt = now;
    }
  }

  // Priority: an active one-shot (attack/cast/hit/dash-ability/jump-attack)
  // plays out; then a mid-air hop runs its 3-phase state machine; then a live
  // whirlwind loops; then a dash shows the run; else locomotion. (Death
  // outranks all via the early return in update.) Shift casts the champ's
  // DASH, which plays Dodge_Forward through the cast one-shot via lastCastKey;
  // a jump ATTACK is the JUMP cast — Melee_1H_Attack_Jump_Chop via lastCastKey.
  private playBaseClip(u: Unit, now: number, spinning: boolean): void {
    const ch = this.char;
    const airborne = u.jumpUntil > now;
    if (!airborne && this.jumpPhase) {
      // grounded → reset
      this.jumpPhase = "";
    }
    if (now < this.oneShotUntil) {
      // hold the current one-shot
      return;
    }
    if (airborne) {
      this.playJumpPhase(u, now);
    } else if (spinning) {
      ch.play(SPIN_LOOP_CLIP, { fade: 0.1, loop: true, timeScale: TWO_H_SPEED });
      // the ult ribbons for its WHOLE duration, not just the cast
      this.emitTrails(150);
    } else if (now < u.dashUntil) {
      ch.play("Running_B", { fade: 0.1 });
    } else {
      ch.play(locomotion(u, this.def.twoHanded ?? false), { fade: 0.16 });
    }
  }

  /** takeoff → float → land, keyed to airtime; trigger each clip ONCE. */
  private playJumpPhase(u: Unit, now: number): void {
    const phase = jumpPhaseAt(u.jumpUntil - now);
    if (phase === this.jumpPhase) {
      return;
    }
    this.jumpPhase = phase;
    const ch = this.char;
    // takeoff/land clips are SPED to fit their airtime slice — the whole
    // motion plays inside its phase instead of being chopped by the next
    if (phase === "start") {
      ch.play(JUMP_START_CLIP, {
        fade: 0.06,
        loop: false,
        timeScale: Math.max(1, (ch.clipDuration(JUMP_START_CLIP) * 1000) / JUMP_START_MS),
      });
    } else if (phase === "idle") {
      ch.play(JUMP_IDLE_CLIP, { fade: 0.12, loop: true });
    } else {
      ch.play(JUMP_LAND_CLIP, {
        fade: 0.06,
        loop: false,
        timeScale: Math.max(1, (ch.clipDuration(JUMP_LAND_CLIP) * 1000) / JUMP_LAND_MS),
      });
    }
  }

  /** Landing squash & stretch (volume-conserving, ~150ms recover). */
  private updateSquash(u: Unit, dt: number, fx: Fx | null, hopY: number): void {
    if (this.prevHop > 0.2 && hopY === 0) {
      this.squash = 1;
      fx?.landJuice(u.x, u.y);
    }
    this.prevHop = hopY;
    this.squash *= Math.max(0, 1 - 9 * dt);
    const bs = this.baseScale;
    this.char.root.scale.set(
      bs * (1 + 0.12 * this.squash),
      bs * (1 - 0.18 * this.squash),
      bs * (1 + 0.12 * this.squash),
    );
  }

  /** Dash trail: afterimages + streaks + dust shed behind any ability dash. */
  private updateDashFx(u: Unit, now: number, fx: Fx | null): void {
    const dashing = now < u.dashUntil;
    if (dashing && fx) {
      const primary = CHAMP_FX.get(this.def.id)?.primary ?? 0x9f_d0_ff;
      if (now - this.lastDashTrailAt > 40) {
        this.lastDashTrailAt = now;
        fx.castStreak(u.x, u.y, -u.dashVx, -u.dashVy, primary, 6, 2, 0.35);
      }
      if (now - this.lastGhostAt > 70) {
        this.lastGhostAt = now;
        // Hades-dash afterimage
        fx.ghost(this.group.position.x, this.group.position.z, primary);
        if (this.def.id === "witch") {
          // broom sparkle
          fx.crossGlint(u.x, 1, u.y, -u.dashVy, u.dashVx, 0xb9_8a_e0, 0.6);
        }
      }
      if (now - this.lastDashDustAt > 80) {
        this.lastDashDustAt = now;
        fx.footDust(u.x, u.y, -u.dashVx, -u.dashVy);
      }
    }
    if (this.wasDashing && !dashing && fx) {
      // dash-expiry pop
      fx.impactRing(u.x, u.y, CHAMP_FX.get(this.def.id)?.primary ?? 0x9f_d0_ff, 1.6);
    }
    this.wasDashing = dashing;
  }

  /** Ult-ready ring: your selection ring turns molten gold (1.2Hz pulse). */
  private updateUltRing(u: Unit, now: number, fx: Fx | null): void {
    const rReady = u.abilities.R.rank >= 1 && u.abilities.R.readyAt <= now;
    if (!rReady) {
      this.ringMat.color.copy(this.ringBase);
      this.ringMat.opacity = 0.55;
      return;
    }
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.0075);
    this.ringMat.color.copy(this.ringBase).lerp(GOLD, 0.55 + 0.4 * pulse);
    this.ringMat.opacity = 0.55 + 0.2 * pulse;
    if (fx && now - this.lastUltMoteAt > 500) {
      this.lastUltMoteAt = now;
      fx.mote(
        u.x + (Math.random() - 0.5),
        0.3,
        u.y + (Math.random() - 0.5),
        0xff_d2_4a,
        1.5,
        0.6,
        0.2,
      );
    }
  }

  /** Swap the character for a hopping mushroom (witch's Grand Hex). */
  private setHex(on: boolean): void {
    this.hexShown = on;
    if (on && !this.mushroom) {
      const inst = this.lib.instance("mushroom");
      const box = new THREE.Box3().setFromObject(inst);
      const h = Math.max(0.1, box.max.y - box.min.y);
      this.mushScale = 1.2 / h;
      inst.position.y = -box.min.y;
      const pivot = new THREE.Group();
      pivot.add(inst);
      pivot.scale.setScalar(this.mushScale);
      this.group.add(pivot);
      this.mushroom = pivot;
    }
    if (this.mushroom) {
      this.mushroom.visible = on;
    }
    this.char.root.visible = !on;
  }

  /** Begin a weapon trail on every melee weapon for the next `dur` ms. */
  private emitTrails(dur: number): void {
    // no blade arcs off a mushroom
    if (this.hexShown) {
      return;
    }
    for (const t of this.trails) {
      t.emit(dur);
    }
  }

  private updateTrails(dt: number): void {
    for (const t of this.trails) {
      t.update(dt);
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    scene.remove(this.blob);
    this.blob.geometry.dispose();
    disposeMat(this.blob.material);
    for (const t of this.trails) {
      scene.remove(t.mesh);
      t.dispose();
    }
    this.statusFx?.dispose();
    this.char.dispose();
    // free per-instance materials (shared skinned geometry stays with the template)
    for (const m of this.mats) {
      m.dispose();
    }
    for (const m of this.weaponMats) {
      m.dispose();
    }
    this.ring.geometry.dispose();
    this.ringMat.dispose();
  }
}
