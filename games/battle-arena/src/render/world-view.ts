// Bridges the authoritative sim World → Three.js. Maintains one visual per
// entity, creates/removes them as the World changes, and picks each champion's
// animation clip from its unit state. Never mutates the sim.
import * as THREE from "three";
import { CHAMP_BY_ID } from "../data/champions";
import type { DamageType } from "../data/config";
import { BOSS_HEIGHT, BOSS_POS } from "../data/map";
import type { AbilityKey, Projectile, Unit, World } from "../sim/types";
import { AnimatedCharacter, ModelLibrary } from "./models";
import { WeaponTrail } from "./weapon-trail";
import { terrainHeight } from "../data/terrain";
import type { Fx } from "./fx";
import { LOCAL_COLOR, teamColor } from "./palette";

// Per-ability cast clips — uses the breadth of the KayKit library so each
// ability reads distinctly (bash/spin/leap/blink/summon…), not one generic cast.
const ABILITY_CLIPS: Record<string, Partial<Record<AbilityKey, string>>> = {
  knight: { Q: "Melee_Block_Attack", W: "Melee_1H_Attack_Jump_Chop", E: "Melee_Blocking", R: "Melee_2H_Attack_Spinning" },
  ranger: { Q: "Ranged_Bow_Release_Up", W: "Dodge_Forward", E: "PickUp", R: "Ranged_Bow_Release_Up" },
  mage: { Q: "Ranged_Magic_Shoot", W: "Ranged_Magic_Raise", E: "Ranged_Magic_Raise", R: "Ranged_Magic_Summon" },
  rogue: { Q: "Melee_Dualwield_Attack_Stab", W: "Dodge_Forward", E: "Dodge_Backward", R: "Melee_Dualwield_Attack_Slice" },
  barbarian: { Q: "Melee_2H_Attack_Slice", W: "Melee_2H_Attack_Chop", E: "Use_Item", R: "Melee_2H_Attack_Spin" },
  necromancer: { Q: "Ranged_Magic_Shoot", W: "Ranged_Magic_Raise", E: "Ranged_Magic_Spellcasting", R: "Ranged_Magic_Summon" },
};

// Basic-attack clip rotations — swings vary shot-to-shot instead of repeating.
// melee swing order = slice-horizontal → chop → slice-diagonal
const ATTACK_SETS: Record<string, string[]> = {
  knight: ["Melee_1H_Attack_Slice_Horizontal", "Melee_1H_Attack_Chop", "Melee_1H_Attack_Slice_Diagonal"],
  rogue: ["Melee_Dualwield_Attack_Slice", "Melee_Dualwield_Attack_Chop"],
  barbarian: ["Melee_2H_Attack_Slice", "Melee_2H_Attack_Chop"],
  ranger: ["Ranged_Bow_Release", "Ranged_Bow_Release_Up"],
  mage: ["Ranged_Magic_Shoot"],
  necromancer: ["Ranged_Magic_Shoot"],
  skwarrior: ["Melee_1H_Attack_Chop", "Melee_1H_Attack_Stab"],
  skminion: ["Melee_Unarmed_Attack_Punch_A", "Melee_1H_Attack_Chop"],
  skmage: ["Ranged_Magic_Shoot"],
};

// KayKit medium characters face +Z; sim aim is (cos facing, sin facing) on (x,z).
const MODEL_YAW = 0;

const ATTACK_ANIM_MS = 340; // snappy swing window
const ATTACK_TIMESCALE = 1.45; // play the swing clip faster so it fits the window
const CAST_ANIM_MS = 520;
const HIT_ANIM_MS = 280;
const JUMP_ANIM_MS = 600;
const JUMP_RENDER_MS = 620; // mirrors sim JUMP_MS — drives the hop-arc height
const HOP_HEIGHT = 1.4; // peak lift of the jump arc (world units)
const DODGE_ANIM_MS = 360; // mirrors sim DODGE_MS

// minimal descriptor a UnitView needs (ChampDef satisfies it; so do creeps)
type ViewDef = {
  id: string;
  model: string;
  attackType: "melee" | "ranged";
  attackDamageType: DamageType;
  weaponR?: string;
  weaponL?: string;
};

const CREEP_VIEW: Record<string, ViewDef> = {
  skwarrior: { id: "skwarrior", model: "Skeleton_Warrior", attackType: "melee", attackDamageType: "physical" },
  skmage: { id: "skmage", model: "Skeleton_Mage", attackType: "ranged", attackDamageType: "magic", weaponR: "Skeleton_Staff" },
  skminion: { id: "skminion", model: "Skeleton_Minion", attackType: "melee", attackDamageType: "physical" },
};

// shared soft radial texture for blob contact-shadows
let blobTexCache: THREE.Texture | null = null;
function blobTex(): THREE.Texture {
  if (blobTexCache) return blobTexCache;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
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
}

function locomotion(u: Unit): string {
  const speed = Math.hypot(u.vx, u.vy);
  if (speed > u.moveSpeed * 0.55) return "Running_A";
  if (speed > 0.4) return "Walking_A";
  return "Idle_A";
}

function attackClip(def: ViewDef): string {
  if (def.attackType === "ranged") return def.attackDamageType === "magic" ? "Ranged_Magic_Shoot" : "Ranged_Bow_Release";
  if (def.id === "barbarian") return "Melee_2H_Attack_Chop"; // 2H axe
  return def.id === "rogue" ? "Melee_1H_Attack_Slice_Diagonal" : "Melee_1H_Attack_Chop";
}

function castClip(def: ViewDef): string {
  if (def.attackDamageType === "magic") return "Ranged_Magic_Spellcasting";
  // physical champs "cast" with a weapon-appropriate swing, not a throw
  return attackClip(def);
}

/** Pick the directional dodge clip from the roll velocity vs the facing. */
function dodgeClip(u: Unit): string {
  const rollAng = Math.atan2(u.dashVy, u.dashVx);
  const rel = Math.atan2(Math.sin(rollAng - u.facing), Math.cos(rollAng - u.facing));
  const a = Math.abs(rel);
  if (a < Math.PI / 4) return "Dodge_Forward";
  if (a > (3 * Math.PI) / 4) return "Dodge_Backward";
  return rel > 0 ? "Dodge_Left" : "Dodge_Right";
}

class UnitView {
  readonly group = new THREE.Group();
  private char: AnimatedCharacter;
  private ring: THREE.Mesh;
  private def: ViewDef;
  private deadShown = false;
  private placed = false;
  private wasAlive = true;
  private yaw = 0;
  private lastAttackShown = -1;
  private lastCastShown = -1;
  private lastHitShown = -1;
  private lastFlinchAt = -1;
  private lastJumpShown = -1;
  private lastDodgeShown = -1;
  private oneShotUntil = 0;
  private deadAt = -1;
  private lastDustAt = 0;
  private attackIdx = 0;
  private hitIdx = 0;
  private recoilX = 0; // render-only knockback lurch (decays); shadow stays put
  private recoilZ = 0;
  private weapons: THREE.Object3D[] = [];
  private mats: THREE.MeshStandardMaterial[] = [];
  private trails: WeaponTrail[] = [];
  private blob: THREE.Mesh; // contact shadow (scene sibling, decoupled from hopY)

  constructor(
    private scene: THREE.Scene,
    lib: ModelLibrary,
    def: ViewDef,
    color: number,
    isLocal: boolean,
  ) {
    this.def = def;
    this.char = new AnimatedCharacter(lib, def.model);
    this.group.add(this.char.root);

    // clone materials per-instance so hit-flash / stealth / team-tint don't
    // bleed across units that share a model (SkeletonUtils.clone shares mats).
    const tint = new THREE.Color(isLocal ? LOCAL_COLOR : color);
    this.char.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (Array.isArray(m.material)) m.material = m.material.map((mm) => mm.clone());
      else m.material = m.material.clone();
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
      if (mat) {
        mat.color.lerp(tint, 0.18); // subtle team/identity hue
        this.mats.push(mat);
      }
    });

    // give the champion their weapon(s), bound to the hand bones
    if (def.weaponR) {
      const wr = lib.instance(def.weaponR);
      // a blade trail on the main weapon (melee only) — computed pre-attach so
      // the blade segment is in local space
      const trail = def.attackType === "melee" ? new WeaponTrail(wr, isLocal ? 0xfff4d8 : 0xdbe8ff) : null;
      if (this.char.attach(wr, "handslot.r")) {
        this.weapons.push(wr);
        if (trail) {
          this.trails.push(trail);
          this.scene.add(trail.mesh);
        }
      } else trail?.dispose();
    }
    if (def.weaponL) {
      const wl = lib.instance(def.weaponL);
      if (this.char.attach(wl, "handslot.l")) this.weapons.push(wl);
    }

    const ringColor = isLocal ? LOCAL_COLOR : color;
    // local ring is larger + fainter so it reads as a clean circle on the ground
    // around your feet — a tight ring gets occluded by the body into "floating"
    // slivers. Non-local stays a small footprint tag.
    const innerR = isLocal ? 1.15 : 0.7;
    const outerR = isLocal ? 1.35 : 0.95;
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(innerR, outerR, 48),
      new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: isLocal ? 0.55 : 0.6, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.04;
    this.group.add(this.ring);

    // soft blob contact-shadow on the ground (its own scene mesh so it stays on
    // the terrain when the unit jumps, instead of lifting with the body)
    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.85, 20),
      new THREE.MeshBasicMaterial({ map: blobTex(), transparent: true, opacity: 0.42, depthWrite: false, color: 0x000000 }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = -0.5; // under additive VFX
    this.scene.add(this.blob);

    this.char.play("Idle_A", { fade: 0 });
  }

  update(u: Unit, now: number, dt: number, fx: Fx | null): void {
    // smooth toward the sim position; snap on first appearance, respawn, or a
    // big jump (blink/teleport) so the character doesn't slide across the map.
    const respawned = u.alive && !this.wasAlive;
    const jumped = (u.x - this.group.position.x) ** 2 + (u.y - this.group.position.z) ** 2 > 36;
    // vertical hop arc while airborne (sin 0→π over the jump window) + the
    // terrain height under the unit (render-only; the sim stays flat)
    const hopY = u.alive && u.jumpUntil > now ? Math.sin((1 - (u.jumpUntil - now) / JUMP_RENDER_MS) * Math.PI) * HOP_HEIGHT : 0;
    const groundY = terrainHeight(u.x, u.y);
    if (!this.placed || respawned || jumped) {
      this.group.position.set(u.x, groundY + hopY, u.y);
      this.yaw = Math.atan2(u.aimX, u.aimY) + MODEL_YAW;
      this.placed = true;
    } else {
      const a = Math.min(1, 26 * dt);
      this.group.position.x += (u.x - this.group.position.x) * a;
      this.group.position.z += (u.y - this.group.position.z) * a;
      this.group.position.y = groundY + hopY;
    }
    // render-only knockback lurch: the model recoils in the hit direction and
    // springs back while the shadow stays planted (physical "enemy reaction")
    this.recoilX *= Math.max(0, 1 - dt * 9);
    this.recoilZ *= Math.max(0, 1 - dt * 9);
    this.group.position.x += this.recoilX;
    this.group.position.z += this.recoilZ;
    // blob contact-shadow rides the terrain (never the hop), shrinking as the
    // unit rises so it reads as a cast shadow
    this.blob.position.set(u.x, groundY + 0.02, u.y);
    this.blob.visible = u.alive;
    this.blob.scale.setScalar(Math.max(0.45, 1 - hopY * 0.28));

    // shortest-arc yaw smoothing (no instant 180° snaps)
    const targetYaw = Math.atan2(u.aimX, u.aimY) + MODEL_YAW;
    const d = Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw));
    this.yaw += d * Math.min(1, 16 * dt);
    this.group.rotation.y = this.yaw;
    this.wasAlive = u.alive;

    if (!u.alive) {
      if (!this.deadShown) {
        this.char.play("Death_A", { fade: 0.12, loop: false, clamp: true });
        this.deadShown = true;
        this.deadAt = now;
        this.oneShotUntil = 0;
        // rising soul wisps + a ground ring on the death frame
        const soul = new THREE.Color(this.def.attackDamageType === "magic" ? 0x9a7bff : 0x9fd0ff);
        fx?.fountain(u.x, u.y, 12, soul.getHex());
      }
      this.ring.visible = false;
      // dissolve: fade to a faint cold ghost over ~600ms, then hold
      const k = Math.min(1, (now - this.deadAt) / 600);
      const op = 1 - k * 0.82;
      const glow = (1 - k) * 0.25;
      for (const m of this.mats) {
        m.transparent = true;
        m.opacity = op;
        m.emissive.setRGB(glow * 0.5, glow * 0.6, glow);
      }
      this.char.update(dt);
      this.updateTrails(now, dt); // let any lingering trail fade out
      return;
    }
    if (this.deadShown) {
      // respawned — restore the material state the dissolve clobbered
      for (const m of this.mats) {
        m.opacity = 1;
        m.transparent = false;
        m.emissive.setRGB(0, 0, 0);
      }
    }
    this.deadShown = false;
    this.ring.visible = true;

    // one-shots are triggered ON THE EVENT (delta), never per-frame — otherwise
    // play() would reset the clip to frame 0 every frame and freeze it.
    if (u.lastCastAt !== this.lastCastShown) {
      this.lastCastShown = u.lastCastAt;
      if (now - u.lastCastAt < CAST_ANIM_MS) {
        const byKey = u.lastCastKey ? ABILITY_CLIPS[this.def.id]?.[u.lastCastKey] : undefined;
        this.char.play(byKey ?? castClip(this.def), { loop: false, fade: 0.06 });
        this.oneShotUntil = now + CAST_ANIM_MS;
        this.emitTrails(now, CAST_ANIM_MS);
      }
    } else if (u.lastAttackAt !== this.lastAttackShown) {
      this.lastAttackShown = u.lastAttackAt;
      if (now - u.lastAttackAt < ATTACK_ANIM_MS) {
        const set = ATTACK_SETS[this.def.id] ?? [attackClip(this.def)];
        const clip = set[this.attackIdx++ % set.length]!;
        this.char.play(clip, { loop: false, fade: 0.04, timeScale: ATTACK_TIMESCALE });
        this.oneShotUntil = now + ATTACK_ANIM_MS;
        this.emitTrails(now, ATTACK_ANIM_MS); // weapon-trail ribbon traces the blade
      }
    }
    // get-hit flinch — when freshly damaged and not mid-swing/cast (throttled so
    // a flurry of hits doesn't lock the character in permanent flinch)
    if (u.lastHitAt !== this.lastHitShown) {
      this.lastHitShown = u.lastHitAt;
      // knockback lurch on every fresh hit (even when the flinch anim is throttled)
      if (u.alive && now - u.lastHitAt < 180) {
        this.recoilX = u.lastHitDx * 0.34;
        this.recoilZ = u.lastHitDy * 0.34;
      }
      if (u.alive && now - u.lastHitAt < 180 && now >= this.oneShotUntil && now - this.lastFlinchAt > 420) {
        this.char.play(this.hitIdx++ % 2 ? "Hit_B" : "Hit_A", { loop: false, fade: 0.05 });
        this.oneShotUntil = now + HIT_ANIM_MS;
        this.lastFlinchAt = now;
      }
    }
    // jump takeoff — plays a full hop clip; cancels a swing/flinch (evasive)
    if (u.jumpUntil !== this.lastJumpShown) {
      this.lastJumpShown = u.jumpUntil;
      if (u.jumpUntil > now) {
        this.char.play("Jump_Full_Long", { loop: false, fade: 0.05 });
        this.oneShotUntil = now + JUMP_ANIM_MS;
      }
    }
    // dodge-roll — directional roll clip; overrides any swing (evasive)
    if (u.lastDodgeAt !== this.lastDodgeShown) {
      this.lastDodgeShown = u.lastDodgeAt;
      if (u.alive && now - u.lastDodgeAt < 200) {
        this.char.play(dodgeClip(u), { loop: false, fade: 0.05 });
        this.oneShotUntil = now + DODGE_ANIM_MS;
      }
    }
    // an active one-shot (attack/cast/ability incl. dash-abilities) plays out;
    // otherwise a dash shows the run, else normal locomotion
    if (now < this.oneShotUntil) {
      // hold the current one-shot
    } else if (now < u.dashUntil) {
      this.char.play("Running_A", { fade: 0.1 });
    } else {
      this.char.play(locomotion(u), { fade: 0.16 });
    }
    this.char.update(dt);
    this.updateTrails(now, dt); // sample the blade AFTER the pose updates

    // footstep dust on fast ground movement (grounds the run cycle)
    const spd = Math.hypot(u.vx, u.vy);
    if (fx && spd > u.moveSpeed * 0.55 && u.jumpUntil <= now && now - this.lastDustAt > 170) {
      this.lastDustAt = now;
      fx.footDust(u.x, u.y, -u.vx, -u.vy);
    }

    // hit flash (white pulse on damage) + stealth dim — on cloned materials
    const flash = Math.max(0, 1 - (now - u.lastHitAt) / 110);
    const stealthed = u.statuses.some((s) => s.kind === "stealth");
    for (const m of this.mats) {
      m.emissive.setRGB(flash, flash * 0.85, flash * 0.7);
      m.transparent = stealthed;
      m.opacity = stealthed ? 0.4 : 1;
    }
  }

  /** Begin a weapon trail on every melee weapon for the next `dur` ms. */
  private emitTrails(now: number, dur: number): void {
    for (const t of this.trails) t.emit(now, dur);
  }

  private updateTrails(now: number, dt: number): void {
    for (const t of this.trails) t.update(now, dt);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    scene.remove(this.blob);
    this.blob.geometry.dispose();
    (this.blob.material as THREE.Material).dispose();
    for (const t of this.trails) {
      scene.remove(t.mesh);
      t.dispose();
    }
    this.char.dispose();
    // free per-instance GPU resources (shared skinned geometry stays with the template)
    for (const m of this.mats) m.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    for (const w of this.weapons) {
      w.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          const mat = m.material;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose();
        }
      });
    }
  }
}

export class WorldView {
  private units = new Map<string, UnitView>();
  private projectiles = new Map<string, THREE.Object3D>();
  private coins = new Map<string, THREE.Mesh>();
  private deliveries = new Map<string, THREE.Group>();
  private grounds = new Map<string, THREE.Mesh>();
  private boss: AnimatedCharacter | null = null;
  private seenCoins = new Set<string>();
  private bossReturnAt = 0;
  private bossNextTaunt = 6000;
  fx: Fx | null = null; // set by the scene, for projectile trails
  localId = "";

  constructor(
    private scene: THREE.Scene,
    private lib: ModelLibrary,
  ) {}

  setupBoss(): void {
    this.boss = new AnimatedCharacter(this.lib, "Skeleton_Golem");
    this.boss.root.position.set(BOSS_POS.x, terrainHeight(BOSS_POS.x, BOSS_POS.y) + BOSS_HEIGHT, BOSS_POS.y);
    this.boss.root.scale.setScalar(1.5);
    this.scene.add(this.boss.root);
    this.boss.play("Idle_A", { fade: 0 });
  }

  sync(w: World, dt: number): void {
    const now = w.now;

    // units (heroes + neutral skeletons)
    const seen = new Set<string>();
    for (const u of w.units.values()) {
      if (u.kind !== "hero" && u.kind !== "creep") continue;
      seen.add(u.id);
      let view = this.units.get(u.id);
      if (!view) {
        const isCreep = u.kind === "creep";
        const def = (isCreep ? CREEP_VIEW[u.champId] : CHAMP_BY_ID[u.champId]) ?? CHAMP_BY_ID["knight"]!;
        const color = isCreep ? 0x9aa3b5 : teamColor(u.team);
        view = new UnitView(this.scene, this.lib, def, color, !isCreep && u.id === this.localId);
        this.units.set(u.id, view);
        this.scene.add(view.group);
      }
      view.update(u, now, dt, this.fx);
    }
    for (const [id, view] of this.units) {
      if (!seen.has(id)) {
        view.dispose(this.scene);
        this.units.delete(id);
      }
    }

    // projectiles
    const seenP = new Set<string>();
    for (const p of w.projectiles.values()) {
      seenP.add(p.id);
      let mesh = this.projectiles.get(p.id);
      if (!mesh) {
        mesh = makeProjectileMesh(p);
        this.projectiles.set(p.id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.set(p.x, 1.1, p.y);
      mesh.rotation.y = Math.atan2(p.vx, p.vy);
      // additive trail behind the projectile
      const tc = p.kind === "fireball" ? 0xff7a2c : p.kind === "bolt" ? 0xb070ff : p.kind === "arrow" ? 0xffe6a0 : 0xffffff;
      this.fx?.trail(p.x, p.y, tc);
    }
    for (const [id, mesh] of this.projectiles) {
      if (!seenP.has(id)) {
        this.scene.remove(mesh);
        this.projectiles.delete(id);
      }
    }

    this.syncCoins(w, now);
    this.syncDeliveries(w, now);
    this.syncGrounds(w, now);

    if (this.boss) {
      this.boss.update(dt);
      if (this.bossReturnAt && now >= this.bossReturnAt) {
        this.boss.play("Idle_A", { fade: 0.2 });
        this.bossReturnAt = 0;
      } else if (!this.bossReturnAt && now >= this.bossNextTaunt) {
        this.boss.play("Skeletons_Taunt", { fade: 0.2, loop: false });
        this.bossReturnAt = now + 2200;
        this.bossNextTaunt = now + 13000;
      }
    }
  }

  private syncCoins(w: World, now: number): void {
    const seen = new Set<string>();
    for (const c of w.coins) {
      seen.add(c.id);
      // a freshly-spawned, still-flying coin = the boss just hurled it → animate
      if (!this.seenCoins.has(c.id)) {
        this.seenCoins.add(c.id);
        if (now < c.landAt && this.boss) {
          this.boss.play("Throw", { fade: 0.08, loop: false });
          this.bossReturnAt = now + 800;
        }
      }
      let mesh = this.coins.get(c.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.45, 0.45, 0.14, 18),
          new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0xffaa20, emissiveIntensity: 1.0, metalness: 0.4, roughness: 0.4 }),
        );
        mesh.castShadow = true;
        this.coins.set(c.id, mesh);
        this.scene.add(mesh);
      }
      // parabolic arc while flying, then bob+spin on the ground
      if (now < c.landAt) {
        const t = 1 - (c.landAt - now) / 900;
        const x = c.fromX + (c.x - c.fromX) * t;
        const z = c.fromY + (c.y - c.fromY) * t;
        const arc = Math.sin(t * Math.PI) * 6 + BOSS_HEIGHT * (1 - t);
        mesh.position.set(x, 0.5 + arc, z);
      } else {
        mesh.position.set(c.x, terrainHeight(c.x, c.y) + 0.6 + Math.sin(now * 0.004) * 0.15, c.y);
      }
      mesh.rotation.y = now * 0.005;
      mesh.rotation.x = Math.PI / 2;
    }
    for (const [id, mesh] of this.coins) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.coins.delete(id);
        this.seenCoins.delete(id);
      }
    }
  }

  private syncDeliveries(w: World, now: number): void {
    const seen = new Set<string>();
    for (const d of w.deliveries) {
      seen.add(d.id);
      let group = this.deliveries.get(d.id);
      if (!group) {
        group = new THREE.Group();
        const crate = new THREE.Mesh(
          new THREE.BoxGeometry(1.1, 1.1, 1.1),
          new THREE.MeshStandardMaterial({ color: 0x66ffcc, emissive: 0x22cc88, emissiveIntensity: 0.5, roughness: 0.6 }),
        );
        crate.position.y = 0.7;
        crate.castShadow = true;
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.7, 1.3, 9, 16, 1, true),
          new THREE.MeshBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }),
        );
        beam.position.y = 4.5;
        group.add(crate, beam);
        this.deliveries.set(d.id, group);
        this.scene.add(group);
      }
      group.position.set(d.x, terrainHeight(d.x, d.y), d.y);
      group.rotation.y = now * 0.0015;
      group.children[0]!.position.y = 0.7 + Math.sin(now * 0.003) * 0.18;
    }
    for (const [id, group] of this.deliveries) {
      if (!seen.has(id)) {
        this.scene.remove(group);
        this.deliveries.delete(id);
      }
    }
  }

  private syncGrounds(w: World, now: number): void {
    const seen = new Set<string>();
    for (const g of w.grounds) {
      seen.add(g.id);
      let mesh = this.grounds.get(g.id);
      if (!mesh) {
        const color = groundColor(g.effect);
        mesh = new THREE.Mesh(
          new THREE.CircleGeometry(g.radius, 28),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
        );
        mesh.rotation.x = -Math.PI / 2;
        this.grounds.set(g.id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.set(g.x, terrainHeight(g.x, g.y) + 0.07, g.y);
      const mat = mesh.material as THREE.MeshBasicMaterial;
      // telegraphs pulse urgently; damage zones glow steadily
      mat.opacity = g.telegraph ? 0.3 + Math.abs(Math.sin(now * 0.012)) * 0.4 : 0.22 + Math.sin(now * 0.008) * 0.08;
    }
    for (const [id, mesh] of this.grounds) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.grounds.delete(id);
      }
    }
  }
}

function groundColor(effect: string): number {
  switch (effect) {
    case "meteor":
      return 0xff4422;
    case "frost":
      return 0x7fd4ff;
    case "trap":
      return 0x9affc0;
    case "rain":
      return 0xffe08a;
    case "whirlwind":
      return 0xffffff;
    default:
      return 0xffaa44;
  }
}

function makeProjectileMesh(p: Projectile): THREE.Object3D {
  const color =
    p.kind === "fireball" ? 0xff7a2c : p.kind === "bolt" ? 0xb070ff : p.kind === "arrow" ? 0xffe6a0 : 0xffffff;
  const g = new THREE.Group();
  const coreR = p.kind === "fireball" ? 0.34 : 0.18;

  if (p.kind === "arrow") {
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6),
      new THREE.MeshBasicMaterial({ color: 0xcfa15a }),
    );
    shaft.rotation.x = Math.PI / 2;
    g.add(shaft);
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 8, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    tip.position.z = 0.5;
    g.add(tip);
  } else if (p.kind === "bolt") {
    // bone spear — an elongated glowing shard along its travel direction
    const shard = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 1.1, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, opacity: 0.95, depthWrite: false }),
    );
    shard.rotation.x = Math.PI / 2; // point along +z (velocity)
    g.add(shard);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 10, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, opacity: 0.3, depthWrite: false }),
    );
    g.add(glow);
  } else {
    // bright core (HDR >1 so it blooms) + soft additive halo (energy/magic glow)
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(coreR, 12, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.0, 2.0, 2.2), blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(coreR * 2.1, 12, 12),
      new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    g.add(core, halo);
  }
  return g;
}
