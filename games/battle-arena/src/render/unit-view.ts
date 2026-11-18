import * as THREE from "three";
import { CHAMP_BY_ID } from "../data/champions";
import { ABILITY_CLIPS, TWO_H_SPEED, clipSpeed, swingClip } from "../data/clip-timing";
import { HOP_HEIGHT, JUMP_MS } from "../data/config";
import type { DamageType } from "../data/config";
import type { Unit } from "../sim/types";
import { effectiveAttackSpeed } from "../sim/stats";
import type { ModelLibrary } from "./models";
import { AnimatedCharacter } from "./animated-character";
import { WeaponTrail } from "./weapon-trail";
import type { TrailOverride } from "./weapon-trail";
import { terrainHeight } from "../data/terrain";
import { CHAMP_FX } from "./fx";
import type { Fx } from "./fx";
import { applyDissolve } from "./dissolve";
import type { DissolveHandle } from "./dissolve";
import { StatusFx } from "./status-fx";
import type { PlateAnchor } from "./hud-readability";
import { LOCAL_COLOR } from "./palette";
import { AnimationEvents, animationWindow } from "./animation-events";
import type { AnimationEvent } from "./animation-events";
import { cloneMats, disposeMat } from "./instance-mats";

const TRAIL_OVERRIDE = new Map<string, TrailOverride>([
  ["paladin_hammer", { axis: "y", base: 0.48, opacity: 0.62, tip: 1.15 }],
  ["sword_2handed", { axis: "y", base: 0.34, tip: 1.05 }],
]);

const TRAIL_COLOR = new Map<string, number>([
  ["blackknight", 0xff_c2_4a],
  ["knight", 0x6a_9a_ff],
  ["rogue", 0xff_70_90],
]);

const CREEP_TRAIL_COLOR = 0x9f_b8_e0;

const MODEL_YAW = 0;

const WEAPON_MOUNT = new Map<string, { rx?: number; ry?: number; rz?: number }>([
  ["bow", { ry: Math.PI }],
  ["paladin_hammer", { ry: Math.PI / 2 }],
]);

const mountWeapon = (obj: THREE.Object3D, name: string) => {
  const m = WEAPON_MOUNT.get(name);

  if (!m) {
    return;
  }

  obj.rotation.set(m.rx ?? 0, m.ry ?? 0, m.rz ?? 0);
};

const ONE_SHOT_MIN_MS = 240;
const ONE_SHOT_CAP_MS = 2500;
const SPIN_LOOP_CLIP = "Melee_2H_Attack_Spinning";

const clipWindowMs = (durSec: number, speed = 1) =>
  Math.min(ONE_SHOT_CAP_MS, Math.max(ONE_SHOT_MIN_MS, (durSec / speed) * 1000));

const HIT_ANIM_MS = 300;
const JUMP_START_CLIP = "Jump_Start";
const JUMP_IDLE_CLIP = "Jump_Idle";
const JUMP_LAND_CLIP = "Jump_Land";
const JUMP_START_MS = 340;
const JUMP_LAND_MS = 340;
const GOLD = new THREE.Color(0xff_d2_4a);

const jumpPhaseAt: (remain: number, elapsed: number) => "land" | "start" | "idle" = (
  remain,
  elapsed,
) => {
  if (remain <= JUMP_LAND_MS) {
    return "land";
  }

  return elapsed < JUMP_START_MS ? "start" : "idle";
};

export interface ViewDef {
  id: string;
  model: string;
  attackType: "melee" | "ranged";
  attackDamageType: DamageType;
  weaponR?: string;
  weaponL?: string;
  rig?: "large";
  scale?: number;
  twoHanded?: boolean;
}

let blobTexCache: THREE.Texture | null = null;

const blobTex = () => {
  if (blobTexCache) {
    return blobTexCache;
  }

  const c = document.createElement("canvas");
  c.height = 64;
  c.width = 64;
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

const locomotion = (u: Unit, twoHanded: boolean) => {
  const speed = Math.hypot(u.vx, u.vy);

  if (speed > u.moveSpeed * 0.55) {
    return "Running_B";
  }

  if (speed > 0.4) {
    return "Walking_A";
  }

  return twoHanded ? "Melee_2H_Idle" : "Idle_B";
};

const attackClip = (def: ViewDef) => {
  if (def.attackType === "ranged") {
    return def.attackDamageType === "magic" ? "Ranged_Magic_Shoot" : "Ranged_Bow_Release";
  }

  if (def.twoHanded) {
    return "Melee_2H_Attack_Chop";
  }

  return def.id === "rogue" ? "Melee_1H_Attack_Slice_Diagonal" : "Melee_1H_Attack_Chop";
};

const castClip = (def: ViewDef) => {
  if (def.attackDamageType === "magic") {
    return "Ranged_Magic_Spellcasting";
  }

  return attackClip(def);
};

export class UnitView {
  readonly group = new THREE.Group();
  private readonly platePoint: PlateAnchor = { x: 0, y: 0, z: 0 };
  private readonly plateHeight: number;
  private pose = new THREE.Group();
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
  private groundY = 0;
  private actionEvents = new AnimationEvents();
  private lastHitShown = -1;
  private lastFlinchAt = -1;
  private jumpPhase = "";
  private oneShotUntil = 0;
  private deadAt = -1;
  private lastDustAt = 0;
  private hitIdx = 0;
  private recoilX = 0;
  private recoilZ = 0;
  private weapons: THREE.Object3D[] = [];
  private mats: THREE.MeshStandardMaterial[] = [];
  private weaponMats: THREE.MeshStandardMaterial[] = [];
  private trails: WeaponTrail[] = [];
  private blob: THREE.Mesh;
  private dissolve: DissolveHandle;
  private statusFx: StatusFx | null = null;
  private prevHop = 0;
  private squash = 0;
  private wasDashing = false;
  private lastDashTrailAt = 0;
  private lastDashDustAt = 0;
  private lastGhostAt = 0;
  private lastUltMoteAt = 0;
  private spawnClipPending = false;
  private mushroom: THREE.Object3D | null = null;
  private mushScale = 1;
  private hexShown = false;

  private scene: THREE.Scene;
  private lib: ModelLibrary;
  private color: number;
  private isLocal: boolean;
  private isCreep: boolean;
  private identity: { champId: string; team: string };

  constructor(
    scene: THREE.Scene,
    lib: ModelLibrary,
    def: ViewDef,
    color: number,
    isLocal: boolean,
    isCreep: boolean,
    identity: { champId: string; team: string },
  ) {
    this.scene = scene;
    this.lib = lib;
    this.color = color;
    this.isLocal = isLocal;
    this.isCreep = isCreep;
    this.identity = identity;
    this.def = def;
    this.baseScale = def.scale ?? 1;
    this.char = new AnimatedCharacter(lib, def.model, def.rig === "large" ? "Large/" : "");
    this.char.root.scale.setScalar(this.baseScale);
    this.group.add(this.pose);
    this.pose.add(this.char.root);
    this.char.root.updateWorldMatrix(true, true);
    const bodyBounds = new THREE.Box3().setFromObject(this.char.root);
    this.plateHeight = Math.max(0.8, Number.isFinite(bodyBounds.max.y) ? bodyBounds.max.y : 1.4);

    const tint = new THREE.Color(isLocal ? LOCAL_COLOR : color);
    this.mats = cloneMats(this.char.root, tint);

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
      this.mountHand(
        def.weaponL,
        "handslot.l",
        melee && Boolean(def.weaponR),
        def.id === "rogue" ? 0xff_70_90 : CREEP_TRAIL_COLOR,
      );
    }

    const ringColor = isLocal ? LOCAL_COLOR : color;
    this.dissolve = applyDissolve(this.mats);
    this.dissolve.setEdge(isCreep ? 0xcf_d8_e0 : ringColor);

    const innerR = (isLocal ? 1.15 : 0.7) * this.baseScale;
    const outerR = (isLocal ? 1.35 : 0.95) * this.baseScale;
    this.ringBase = new THREE.Color(ringColor);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: ringColor,
      depthWrite: false,
      opacity: isLocal ? 0.55 : 0.6,
      side: THREE.DoubleSide,
      transparent: true,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(innerR, outerR, 48), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.1;
    this.group.add(this.ring);

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
    this.blob.renderOrder = -0.5;
    this.scene.add(this.blob);

    this.char.play("Idle_B", { fade: 0 });
    this.spawnClipPending = true;
  }

  private mountHand(name: string, bone: string, withTrail: boolean, trailColor: number) {
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

  matches(u: Unit, isLocal: boolean) {
    return (
      this.identity.champId === u.champId &&
      this.identity.team === u.team &&
      this.isLocal === isLocal
    );
  }

  update(
    u: Unit,
    now: number,
    dt: number,
    fx: Fx | null,
    opts: { spinning: boolean; smooth: boolean },
  ) {
    const { spinning } = opts;
    const respawned = u.alive && !this.wasAlive;
    const jumped = (u.x - this.group.position.x) ** 2 + (u.y - this.group.position.z) ** 2 > 36;

    const hopY =
      u.alive && u.jumpUntil > now
        ? Math.sin((1 - (u.jumpUntil - now) / JUMP_MS) * Math.PI) * HOP_HEIGHT
        : 0;

    const groundY = terrainHeight(u.x, u.y);
    this.place(u, dt, respawned || jumped, !opts.smooth, hopY, groundY);
    this.wasAlive = u.alive;

    if (!u.alive) {
      this.updateDead(u, now, dt, fx, groundY);

      return;
    }

    this.revive();
    this.playSpawnClips(u, now, fx, respawned);
    this.updateHex(u, now);

    this.playEventOneShots(u, now, fx);
    this.playHitFlinch(u, now, spinning, respawned || jumped);
    this.playBaseClip(u, now, spinning);
    this.char.update(dt);
    this.updateTrails(dt);

    this.updateSquash(u, dt, fx, hopY);
    this.updateDashFx(u, now, fx);

    if (fx) {
      this.updateFootDust(u, now, fx);
    }

    if (this.isLocal) {
      this.updateUltRing(u, now, fx);
    }

    this.updateHitGlow(u, now);
    this.updateStatusFx(u, now, dt, fx);
  }

  private updateFootDust(u: Unit, now: number, fx: Fx) {
    const spd = Math.hypot(u.vx, u.vy);

    if (spd > u.moveSpeed * 0.55 && u.jumpUntil <= now && now - this.lastDustAt > 170) {
      this.lastDustAt = now;
      fx.footDust(u.x, u.y, -u.vx, -u.vy);
    }
  }

  private updateHitGlow(u: Unit, now: number) {
    const flash = Math.max(0, 1 - (now - u.lastHitAt) / 110);

    for (const m of this.mats) {
      m.emissive.setRGB(flash, flash * 0.85, flash * 0.7);
    }

    const glint = u.pendingAttack ? 0.35 : 0;

    for (const m of this.weaponMats) {
      m.emissive.setRGB(glint, glint, glint);
    }
  }

  private updateStatusFx(u: Unit, now: number, dt: number, fx: Fx | null) {
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

  private place(u: Unit, dt: number, snap: boolean, exact: boolean, hopY: number, groundY: number) {
    if (!this.placed || snap) {
      this.recoilZ = 0;
      this.recoilX = 0;
      this.pose.position.set(0, 0, 0);
      this.groundY = groundY;
      this.group.position.set(u.x, groundY + hopY, u.y);
      this.yaw = Math.atan2(u.aimX, u.aimY) + MODEL_YAW;
      this.placed = true;
    } else {
      const a = exact ? 1 : Math.min(1, 26 * dt);
      this.group.position.x += (u.x - this.group.position.x) * a;
      this.group.position.z += (u.y - this.group.position.z) * a;
      this.groundY += (groundY - this.groundY) * Math.min(1, 18 * dt);
      this.group.position.y = this.groundY + hopY;
    }

    this.recoilX *= Math.max(0, 1 - dt * 9);
    this.recoilZ *= Math.max(0, 1 - dt * 9);
    this.blob.position.set(u.x, this.groundY + 0.08, u.y);
    this.blob.visible = u.alive;
    this.blob.scale.setScalar(this.baseScale * Math.max(0.45, 1 - hopY * 0.28));

    const targetYaw = Math.atan2(u.aimX, u.aimY) + MODEL_YAW;
    const d = Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw));
    this.yaw += d * Math.min(1, 16 * dt);
    this.group.rotation.y = this.yaw;
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    this.pose.position.set(
      c * this.recoilX - sn * this.recoilZ,
      0,
      sn * this.recoilX + c * this.recoilZ,
    );
  }

  private updateDead(u: Unit, now: number, dt: number, fx: Fx | null, groundY: number) {
    this.recoilZ = 0;
    this.recoilX = 0;
    this.pose.position.set(0, 0, 0);

    if (this.hexShown) {
      this.setHex(false);
    }

    if (!this.deadShown) {
      this.char.play("Death_A", { clamp: true, fade: 0.12, loop: false });
      this.deadShown = true;
      this.deadAt = now;
      this.oneShotUntil = 0;
      const soul = new THREE.Color(this.def.attackDamageType === "magic" ? 0x9a_7b_ff : 0x9f_d0_ff);
      fx?.fountain(u.x, u.y, 12, soul.getHex());
    }

    this.ring.visible = false;
    const k = Math.min(1, (now - this.deadAt) / 600);

    if (this.isCreep) {
      this.dissolve.set(k);
      this.group.position.y = groundY - 0.4 * k;
    } else {
      this.dissolve.set(0.55 * k);
      const op = 1 - k * 0.82;
      const glow = (1 - k) * 0.25;

      for (const m of this.mats) {
        m.transparent = true;
        m.opacity = op;
        m.emissive.setRGB(glow * 0.5, glow * 0.6, glow);
      }
    }

    this.statusFx?.update(u, dt, now);
    this.char.update(dt);
    this.updateTrails(dt);
  }

  private revive() {
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

  private playSpawnClips(u: Unit, now: number, fx: Fx | null, respawned: boolean) {
    if (respawned && !this.isCreep) {
      fx?.respawnBurst(u.x, u.y, this.isLocal ? LOCAL_COLOR : this.color, this.isLocal);
      this.char.play("Spawn_Air", { fade: 0.05, loop: false });
      this.oneShotUntil = now + clipWindowMs(this.char.clipDuration("Spawn_Air"));
    }

    if (this.spawnClipPending) {
      this.spawnClipPending = false;
      const spawnClip = this.isCreep ? "Skeletons_Awaken_Floor" : "Spawn_Air";
      this.char.play(spawnClip, { fade: 0, loop: false });
      this.oneShotUntil = now + clipWindowMs(this.char.clipDuration(spawnClip));
      fx?.dust(u.x, u.y, 4);
    }
  }

  private updateHex(u: Unit, now: number) {
    const hexed = u.statuses.some((st) => st.kind === "hex");

    if (hexed !== this.hexShown) {
      this.setHex(hexed);
    }

    if (this.mushroom && this.hexShown) {
      const b = Math.sin(now * 0.009);
      this.mushroom.scale.set(
        this.mushScale * (1 - 0.07 * b),
        this.mushScale * (1 + 0.12 * b),
        this.mushScale * (1 - 0.07 * b),
      );
      this.mushroom.position.y = Math.max(0, b) * 0.14;
    }
  }

  private playEventOneShots(u: Unit, now: number, fx: Fx | null) {
    const action = this.actionEvents.observe(u, now);

    if (action?.kind === "cast") {
      this.playCast(u, action);
    } else if (action?.kind === "attack") {
      this.playAttack(u, action, fx);
    }
  }

  private playCast(u: Unit, action: AnimationEvent) {
    const ch = this.char;

    const clip =
      (u.lastCastKey ? ABILITY_CLIPS.get(this.def.id)?.[u.lastCastKey] : undefined) ??
      castClip(this.def);

    if (clip === SPIN_LOOP_CLIP) {
      return;
    }

    const ts = clipSpeed(clip);
    const window = animationWindow(ch.clipDuration(clip), ts, action);

    if (window.remaining > 0) {
      ch.play(clip, { fade: 0.06, loop: false, offset: window.offset, timeScale: ts });
      this.oneShotUntil = window.until;
      this.emitTrails(window.remaining);
    }
  }

  private playAttack(u: Unit, action: AnimationEvent, fx: Fx | null) {
    const ch = this.char;
    const clip = swingClip(this.def.id, u.swingCount);
    const clipDur = ch.clipDuration(clip);
    const rhythm = CHAMP_BY_ID[this.def.id]?.basicRhythm;
    const swing = Math.max(0, u.swingCount - 1);
    const timeMult = rhythm && rhythm.length ? (rhythm[swing % rhythm.length]?.timeMult ?? 1) : 1;
    const intervalMs = (timeMult * 1000) / Math.max(0.1, effectiveAttackSpeed(u));

    const ts =
      clipDur > 0 ? Math.max(clipSpeed(clip), (clipDur * 1000) / intervalMs) : clipSpeed(clip);

    const window = animationWindow(clipDur, ts, action);

    if (window.remaining > 0) {
      ch.play(clip, { fade: 0.04, loop: false, offset: window.offset, timeScale: ts });
      this.oneShotUntil = window.until;
      this.emitTrails(window.remaining);
      fx?.attackSound(this.def.id, u.x, u.y, this.isLocal);
    }
  }

  private playHitFlinch(u: Unit, now: number, spinning: boolean, snapped: boolean) {
    if (u.lastHitAt === this.lastHitShown) {
      return;
    }

    this.lastHitShown = u.lastHitAt;

    if (u.alive && !snapped && now - u.lastHitAt < 180) {
      const magnitude = Math.max(1, Math.hypot(u.lastHitDx, u.lastHitDy));
      this.recoilX = (u.lastHitDx / magnitude) * 0.34;
      this.recoilZ = (u.lastHitDy / magnitude) * 0.34;
    }

    if (
      !spinning &&
      u.alive &&
      now - u.lastHitAt < 180 &&
      now >= this.oneShotUntil &&
      now - this.lastFlinchAt > 420
    ) {
      const flinch = this.hitIdx % 2 ? "Hit_B" : "Hit_A";
      this.hitIdx += 1;
      const fts = Math.max(1, (this.char.clipDuration(flinch) * 1000) / HIT_ANIM_MS);
      this.char.play(flinch, { fade: 0.05, loop: false, timeScale: fts });
      this.oneShotUntil = now + HIT_ANIM_MS;
      this.lastFlinchAt = now;
    }
  }

  private playBaseClip(u: Unit, now: number, spinning: boolean) {
    const ch = this.char;
    const airborne = u.jumpUntil > now;

    if (!airborne && this.jumpPhase) {
      this.jumpPhase = "";
    }

    if (now < this.oneShotUntil) {
      return;
    }

    if (airborne) {
      this.playJumpPhase(u, now);
    } else if (spinning) {
      ch.play(SPIN_LOOP_CLIP, { fade: 0.1, loop: true, timeScale: TWO_H_SPEED });
      this.emitTrails(150);
    } else if (now < u.dashUntil) {
      ch.play("Running_B", { fade: 0.1 });
    } else {
      ch.play(locomotion(u, this.def.twoHanded ?? false), { fade: 0.16 });
    }
  }

  private playJumpPhase(u: Unit, now: number) {
    const ch = this.char;
    const remain = u.jumpUntil - now;
    const elapsed = JUMP_MS - remain;
    const phase = jumpPhaseAt(remain, elapsed);

    if (phase === this.jumpPhase) {
      return;
    }

    this.jumpPhase = phase;

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

  private updateSquash(u: Unit, dt: number, fx: Fx | null, hopY: number) {
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

  private updateDashFx(u: Unit, now: number, fx: Fx | null) {
    const dashing = now < u.dashUntil;

    if (dashing && fx) {
      const primary = CHAMP_FX.get(this.def.id)?.primary ?? 0x9f_d0_ff;

      if (now - this.lastDashTrailAt > 40) {
        this.lastDashTrailAt = now;
        fx.castStreak(u.x, u.y, -u.dashVx, -u.dashVy, primary, 6, 2, 0.35);
      }

      if (now - this.lastGhostAt > 70) {
        this.lastGhostAt = now;
        fx.ghost(this.group.position.x, this.group.position.z, primary);

        if (this.def.id === "witch") {
          fx.crossGlint(u.x, 1, u.y, -u.dashVy, u.dashVx, 0xb9_8a_e0, 0.6);
        }
      }

      if (now - this.lastDashDustAt > 80) {
        this.lastDashDustAt = now;
        fx.footDust(u.x, u.y, -u.dashVx, -u.dashVy);
      }
    }

    if (this.wasDashing && !dashing && fx) {
      fx.impactRing(u.x, u.y, CHAMP_FX.get(this.def.id)?.primary ?? 0x9f_d0_ff, 1.6);
    }

    this.wasDashing = dashing;
  }

  private updateUltRing(u: Unit, now: number, fx: Fx | null) {
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

  plateAnchor() {
    this.platePoint.x = this.group.position.x;
    this.platePoint.y = this.group.position.y + (this.hexShown ? 1.2 : this.plateHeight) + 0.12;
    this.platePoint.z = this.group.position.z;

    return this.platePoint;
  }

  private setHex(on: boolean) {
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
      this.pose.add(pivot);
      this.mushroom = pivot;
    }

    if (this.mushroom) {
      this.mushroom.visible = on;
    }

    this.char.root.visible = !on;
  }

  private emitTrails(dur: number) {
    if (this.hexShown) {
      return;
    }

    for (const t of this.trails) {
      t.emit(dur);
    }
  }

  private updateTrails(dt: number) {
    for (const t of this.trails) {
      t.update(dt);
    }
  }

  dispose(scene: THREE.Scene) {
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
