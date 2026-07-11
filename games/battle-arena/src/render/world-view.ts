// Bridges the authoritative sim World → Three.js. Maintains one visual per
// entity, creates/removes them as the World changes, and picks each champion's
// animation clip from its unit state. Never mutates the sim.
import * as THREE from "three";
import { CHAMP_BY_ID } from "../data/champions";
import { ABILITY_CLIPS, TWO_H_SPEED, clipSpeed, swingClip } from "../data/clip-timing";
import { JUMP_MS, type DamageType } from "../data/config";
import { BOSS_HEIGHT, BOSS_POS } from "../data/map";
import { destructibleProps, type PropSpec } from "../data/props";
import type { Projectile, Unit, World } from "../sim/types";
import { effectiveAttackSpeed } from "../sim/stats";
import { AnimatedCharacter, ModelLibrary } from "./models";
import { WeaponTrail, type TrailOverride } from "./weapon-trail";
import { terrainHeight } from "../data/terrain";
import { CHAMP_FX, type Fx } from "./fx";
import { energyBallMaterial } from "./fx-shaders";
import { applyDissolve, type DissolveHandle } from "./dissolve";
import { StatusFx } from "./status-fx";
import { groundFxColor } from "./telegraph";
import { LOCAL_COLOR, teamColor } from "./palette";

// Clip choices + strike timing live in data/clip-timing.ts (ABILITY_CLIPS /
// ATTACK_SETS / clipSpeed) — ONE table shared with the sim, so the damage tick
// and the animation's contact frame can never drift apart.

// 2H/hammer blades whose bbox longest-axis heuristic degenerates (the head is
// wider than the shaft, so the ribbon sweeps sideways off the head instead of
// tracing the swing). Force the swing axis + blade extents so the arc reads.
// `base` = fraction up the weapon where the ribbon starts (skip the handle).
const TRAIL_OVERRIDE: Record<string, TrailOverride> = {
  paladin_hammer: { axis: "y", base: 0.48, tip: 1.15, opacity: 0.62 }, // thin head — runs a touch hotter
  sword_2handed: { axis: "y", base: 0.34, tip: 1.05 },
};

// KayKit medium characters face +Z; sim aim is (cos facing, sin facing) on (x,z).
const MODEL_YAW = 0;

// Per-weapon mount corrections (radians), applied to the instance before it
// parents to the handslot bone. Most KayKit weapons are authored to sit right
// in the hand as-is; the bow ships pointing backwards.
const WEAPON_MOUNT: Record<string, { rx?: number; ry?: number; rz?: number }> = {
  bow: { ry: Math.PI },
  paladin_hammer: { ry: Math.PI / 2 }, // ships head-sideways; face the head forward
};

/** Apply a weapon's mount correction (no-op for unlisted weapons). */
function mountWeapon(obj: THREE.Object3D, name: string): void {
  const m = WEAPON_MOUNT[name];
  if (!m) return;
  obj.rotation.set(m.rx ?? 0, m.ry ?? 0, m.rz ?? 0);
}

// Animation timing (render only). Clips play at their NATURAL speed (or their
// data/clip-timing speed override) and each one-shot's window is the clip's
// own length (clamped), so a swing/cast plays through its full motion instead
// of being cut at the wind-up. When a faster attack or a new cast arrives it
// interrupts naturally.
const ONE_SHOT_MIN_MS = 240; // floor so a very short clip still holds a beat
const ONE_SHOT_CAP_MS = 2500; // ceiling so nothing locks the character forever
const SPIN_LOOP_CLIP = "Melee_2H_Attack_Spinning"; // whirlwind ult — a looping channel
/** Natural one-shot window (ms) for a clip playing at `speed`: its own duration
 *  divided by the rate, clamped. */
function clipWindowMs(durSec: number, speed = 1): number {
  return Math.min(ONE_SHOT_CAP_MS, Math.max(ONE_SHOT_MIN_MS, (durSec / speed) * 1000));
}
const ATTACK_RECENCY_MS = 340; // an attack event older than this is stale — skip
const CAST_ANIM_MS = 520; // recency window for detecting a fresh cast event
const HIT_ANIM_MS = 300; // flinch beat — Hit_A/B are SPED to fit (never cut)
const HOP_HEIGHT = 2.8; // peak lift of the jump arc (world units) — a high, floaty hop
// Jump animation is a 3-phase state machine: takeoff → airborne float → land.
const JUMP_START_CLIP = "Jump_Start";
const JUMP_IDLE_CLIP = "Jump_Idle";
const JUMP_LAND_CLIP = "Jump_Land";
const JUMP_START_MS = 340; // takeoff clip plays over the first slice of airtime
const JUMP_LAND_MS = 340; // land clip plays over the last slice (Idle floats the middle)
const GOLD = new THREE.Color(0xffd24a);

// minimal descriptor a UnitView needs (ChampDef satisfies it; so do creeps)
type ViewDef = {
  id: string;
  model: string;
  attackType: "melee" | "ranged";
  attackDamageType: DamageType;
  weaponR?: string;
  weaponL?: string;
  rig?: "large";
  scale?: number;
  twoHanded?: boolean; // rests + idles holding a 2H weapon (Melee_2H_Idle)
};

const CREEP_VIEW: Record<string, ViewDef> = {
  skwarrior: {
    id: "skwarrior",
    model: "Skeleton_Warrior",
    attackType: "melee",
    attackDamageType: "physical",
  },
  skmage: {
    id: "skmage",
    model: "Skeleton_Mage",
    attackType: "ranged",
    attackDamageType: "magic",
    weaponR: "Skeleton_Staff",
  },
  skminion: {
    id: "skminion",
    model: "Skeleton_Minion",
    attackType: "melee",
    attackDamageType: "physical",
  },
  frostgolem: {
    id: "frostgolem",
    model: "FrostGolem",
    attackType: "melee",
    attackDamageType: "physical",
    weaponR: "FrostGolem_Axe_Large",
    rig: "large",
    scale: 1.45,
  },
};

// ── creep loot pickups (Fantasy Weapons Bits) ────────────────────────────────
// A creep drop (coin.loot) renders as a spinning weapon piece instead of a boss
// coin. The piece is picked by hashing the synced coin id, so every client
// shows the same weapon without another wire field (and no Math.random).
const LOOT_WEAPONS = [
  "sword_A",
  "sword_D",
  "axe_A",
  "hammer_B",
  "dagger_A",
  "spear_A",
  "staff_B",
  "wand_B",
];
const LOOT_HEIGHT = 0.9; // world units for the piece's largest dimension

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** Build a loot pickup: the hashed weapon piece, centered, small, laid at a
 *  jaunty angle inside a pivot group (the pivot spins/bobs like a coin). */
function makeLootPickup(lib: ModelLibrary, id: string): THREE.Group {
  const h = hashId(id);
  const piece = lib.instance(LOOT_WEAPONS[h % LOOT_WEAPONS.length]!);
  const box = new THREE.Box3().setFromObject(piece);
  const size = new THREE.Vector3();
  box.getSize(size);
  const s = LOOT_HEIGHT / Math.max(0.1, Math.max(size.x, size.y, size.z));
  piece.scale.setScalar(s);
  const center = new THREE.Vector3();
  box.getCenter(center);
  piece.position.set(-center.x * s, -center.y * s, -center.z * s);
  // jaunty display angle — leaned over like it stuck in the ground sideways
  const tilt = new THREE.Group();
  tilt.add(piece);
  tilt.rotation.z = 0.55 + (h % 3) * 0.12;
  tilt.rotation.x = 0.25;
  const pivot = new THREE.Group();
  pivot.add(tilt);
  return pivot;
}

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

function locomotion(u: Unit, twoHanded: boolean): string {
  const speed = Math.hypot(u.vx, u.vy);
  if (speed > u.moveSpeed * 0.55) return "Running_B";
  if (speed > 0.4) return "Walking_A";
  // 2H wielders rest holding the weapon (KayKit has no 2H run — walk/run stay
  // generic); the 2H idle only kicks in when effectively stationary
  return twoHanded ? "Melee_2H_Idle" : "Idle_B";
}

function attackClip(def: ViewDef): string {
  if (def.attackType === "ranged")
    return def.attackDamageType === "magic" ? "Ranged_Magic_Shoot" : "Ranged_Bow_Release";
  // Garran (2H greatsword) swings the Melee_2H set; Aurelius (1H hammer) + the
  // dagger rogue keep their 1H/dualwield clips.
  if (def.twoHanded) return "Melee_2H_Attack_Chop";
  return def.id === "rogue" ? "Melee_1H_Attack_Slice_Diagonal" : "Melee_1H_Attack_Chop";
}

function castClip(def: ViewDef): string {
  if (def.attackDamageType === "magic") return "Ranged_Magic_Spellcasting";
  // physical champs "cast" with a weapon-appropriate swing, not a throw
  return attackClip(def);
}

class UnitView {
  readonly group = new THREE.Group();
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
  private lastAttackShown = -1;
  private lastCastShown = -1;
  private lastHitShown = -1;
  private lastFlinchAt = -1;
  private jumpPhase = ""; // "" | "start" | "idle" | "land" — 3-phase hop state
  private oneShotUntil = 0;
  private deadAt = -1;
  private lastDustAt = 0;
  private hitIdx = 0;
  private recoilX = 0; // render-only knockback lurch (decays); shadow stays put
  private recoilZ = 0;
  private weapons: THREE.Object3D[] = [];
  private mats: THREE.MeshStandardMaterial[] = [];
  private weaponMats: THREE.MeshStandardMaterial[] = []; // windup glint + StatusFx empower / dispose
  private trails: WeaponTrail[] = [];
  private blob: THREE.Mesh; // contact shadow (scene sibling, decoupled from hopY)
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
    private scene: THREE.Scene,
    private lib: ModelLibrary,
    def: ViewDef,
    private color: number,
    private isLocal: boolean,
    private isCreep: boolean,
  ) {
    this.def = def;
    this.baseScale = def.scale ?? 1;
    this.char = new AnimatedCharacter(lib, def.model, def.rig === "large" ? "Large/" : "");
    this.char.root.scale.setScalar(this.baseScale);
    this.group.add(this.char.root);

    // clone materials per-instance so hit-flash / stealth / team-tint don't
    // bleed across units that share a model (SkeletonUtils.clone shares mats).
    const tint = new THREE.Color(isLocal ? LOCAL_COLOR : color);
    this.mats = cloneMats(this.char.root, tint);

    // give the champion their weapon(s), bound to the hand bones. Weapon mats
    // are ALSO cloned per-instance (windup glint / empower glow must not bleed).
    if (def.weaponR) {
      const wr = lib.instance(def.weaponR);
      mountWeapon(wr, def.weaponR);
      // a blade trail on the main weapon (melee only) — computed pre-attach so
      // the blade segment is in local space. Tinted per champ with REAL color
      // (a near-white tint reads as a plain white sheet once the hot edge is
      // layered on top) + a per-weapon axis override for the 2H/hammer bits.
      const trailColor =
        def.id === "blackknight"
          ? 0xffc24a // Aurelius — dawn gold
          : def.id === "knight"
            ? 0x6a9aff // Garran — steel blue
            : def.id === "rogue"
              ? 0xff7090 // Vesper — crimson
              : 0x9fb8e0; // creeps — cold bone-steel
      const trail =
        def.attackType === "melee"
          ? new WeaponTrail(wr, trailColor, TRAIL_OVERRIDE[def.weaponR])
          : null;
      if (this.char.attach(wr, "handslot.r")) {
        this.weapons.push(wr);
        this.weaponMats.push(...cloneMats(wr, null));
        if (trail) {
          this.trails.push(trail);
          this.scene.add(trail.mesh);
        }
      } else trail?.dispose();
    }
    if (def.weaponL) {
      const wl = lib.instance(def.weaponL);
      mountWeapon(wl, def.weaponL);
      // dual-wielders slash with BOTH blades — the off-hand gets its own ribbon
      const trailL =
        def.attackType === "melee" && def.weaponR
          ? new WeaponTrail(
              wl,
              def.id === "rogue" ? 0xff7090 : 0x9fb8e0,
              TRAIL_OVERRIDE[def.weaponL],
            )
          : null;
      if (this.char.attach(wl, "handslot.l")) {
        this.weapons.push(wl);
        this.weaponMats.push(...cloneMats(wl, null));
        if (trailL) {
          this.trails.push(trailL);
          this.scene.add(trailL.mesh);
        }
      } else trailL?.dispose();
    }

    // death dissolve — patched ONCE at construction on the per-instance mats
    this.dissolve = applyDissolve(this.mats);
    this.dissolve.setEdge(isCreep ? 0xcfd8e0 : isLocal ? LOCAL_COLOR : color);

    const ringColor = isLocal ? LOCAL_COLOR : color;
    // local ring is larger + fainter so it reads as a clean circle on the ground
    // around your feet — a tight ring gets occluded by the body into "floating"
    // slivers. Non-local stays a small footprint tag.
    const innerR = (isLocal ? 1.15 : 0.7) * this.baseScale;
    const outerR = (isLocal ? 1.35 : 0.95) * this.baseScale;
    this.ringBase = new THREE.Color(ringColor);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: ringColor,
      transparent: true,
      opacity: isLocal ? 0.55 : 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
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
        map: blobTex(),
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        color: 0x000000,
      }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = -0.5; // under additive VFX
    this.scene.add(this.blob);

    // bind a base idle IMMEDIATELY — a unit must never render its bind T-pose,
    // even for the frame(s) before the first sync-driven clip lands
    this.char.play("Idle_B", { fade: 0 });
    this.spawnClipPending = true; // heroes drop in (Spawn_Air); skeletons awaken from the floor
  }

  update(u: Unit, now: number, dt: number, fx: Fx | null, spinning: boolean): void {
    // smooth toward the sim position; snap on first appearance, respawn, or a
    // big jump (blink/teleport) so the character doesn't slide across the map.
    const respawned = u.alive && !this.wasAlive;
    const jumped = (u.x - this.group.position.x) ** 2 + (u.y - this.group.position.z) ** 2 > 36;
    // vertical hop arc while airborne (sin 0→π over the jump window) + the
    // terrain height under the unit (render-only; the sim stays flat)
    const hopY =
      u.alive && u.jumpUntil > now
        ? Math.sin((1 - (u.jumpUntil - now) / JUMP_MS) * Math.PI) * HOP_HEIGHT
        : 0;
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
    this.blob.position.set(u.x, groundY + 0.08, u.y); // clear the 0.05 tile tops
    this.blob.visible = u.alive;
    this.blob.scale.setScalar(this.baseScale * Math.max(0.45, 1 - hopY * 0.28));

    // shortest-arc yaw smoothing (no instant 180° snaps)
    const targetYaw = Math.atan2(u.aimX, u.aimY) + MODEL_YAW;
    const d = Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw));
    this.yaw += d * Math.min(1, 16 * dt);
    this.group.rotation.y = this.yaw;
    this.wasAlive = u.alive;

    if (!u.alive) {
      if (this.hexShown) this.setHex(false);
      if (!this.deadShown) {
        this.char.play("Death_A", { fade: 0.12, loop: false, clamp: true });
        this.deadShown = true;
        this.deadAt = now;
        this.oneShotUntil = 0;
        // rising soul wisps on the death frame
        const soul = new THREE.Color(this.def.attackDamageType === "magic" ? 0x9a7bff : 0x9fd0ff);
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
      this.statusFx?.update(u, dt, now); // clears status writes for the dissolve
      this.char.update(dt);
      this.updateTrails(dt); // let any lingering trail fade out
      return;
    }
    if (this.deadShown) {
      // respawned — restore the material state the dissolve clobbered
      this.dissolve.set(0);
      for (const m of this.mats) {
        m.opacity = 1;
        m.transparent = false;
        m.emissive.setRGB(0, 0, 0);
      }
    }
    this.deadShown = false;
    this.ring.visible = true;

    // hero respawn: beam + converge + Spawn_Air drop-in
    if (respawned && !this.isCreep) {
      fx?.respawnBurst(u.x, u.y, this.isLocal ? LOCAL_COLOR : this.color, this.isLocal);
      this.char.play("Spawn_Air", { loop: false, fade: 0.05 });
      this.oneShotUntil = now + clipWindowMs(this.char.clipDuration("Spawn_Air"));
    }
    // first frame: heroes drop from the air (Spawn_Air), skeletons awaken from
    // the floor (Skeletons_Awaken_Floor) — the full clip at natural speed
    if (this.spawnClipPending) {
      this.spawnClipPending = false;
      const spawnClip = this.isCreep ? "Skeletons_Awaken_Floor" : "Spawn_Air";
      this.char.play(spawnClip, { loop: false, fade: 0 });
      this.oneShotUntil = now + clipWindowMs(this.char.clipDuration(spawnClip));
      fx?.dust(u.x, u.y, 4);
    }

    // ── render-only status swaps (synced statuses → identical on guests) ──
    const hexed = u.statuses.some((s) => s.kind === "hex");
    if (hexed !== this.hexShown) this.setHex(hexed);
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
    const ch = this.char;

    // one-shots are triggered ON THE EVENT (delta), never per-frame — otherwise
    // play() would reset the clip to frame 0 every frame and freeze it.
    if (u.lastCastAt !== this.lastCastShown) {
      this.lastCastShown = u.lastCastAt;
      if (now - u.lastCastAt < CAST_ANIM_MS) {
        const clip =
          (u.lastCastKey ? ABILITY_CLIPS[this.def.id]?.[u.lastCastKey] : undefined) ??
          castClip(this.def);
        // The whirlwind's clip is a LOOP (the `spinning` branch drives it) — don't
        // fire it as a one-shot here or it plays once and freezes.
        if (clip !== SPIN_LOOP_CLIP) {
          const ts = clipSpeed(clip); // shared table — the sim's strike waits for this exact contact frame
          const winMs = clipWindowMs(ch.clipDuration(clip), ts);
          ch.play(clip, { loop: false, fade: 0.06, timeScale: ts });
          this.oneShotUntil = now + winMs;
          this.emitTrails(winMs); // weapon-trail ribbon on the ability swing
        }
      }
    } else if (u.lastAttackAt !== this.lastAttackShown) {
      this.lastAttackShown = u.lastAttackAt;
      if (now - u.lastAttackAt < ATTACK_RECENCY_MS) {
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
        const timeMult =
          rhythm && rhythm.length ? (rhythm[swing % rhythm.length]?.timeMult ?? 1) : 1;
        const intervalMs = (timeMult * 1000) / Math.max(0.1, effectiveAttackSpeed(u));
        const ts =
          clipDur > 0 ? Math.max(clipSpeed(clip), (clipDur * 1000) / intervalMs) : clipSpeed(clip);
        const winMs = clipWindowMs(clipDur, ts);
        ch.play(clip, { loop: false, fade: 0.04, timeScale: ts });
        this.oneShotUntil = now + winMs;
        this.emitTrails(winMs); // weapon-trail ribbon traces the blade
        fx?.attackSound(this.def.id, u.x, u.y);
        // (the slash VFX is the shader ribbon in weapon-trail.ts — it traces
        // the real animated blade across the WHOLE swing; no billboard stamp)
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
      if (
        !spinning &&
        u.alive &&
        now - u.lastHitAt < 180 &&
        now >= this.oneShotUntil &&
        now - this.lastFlinchAt > 420
      ) {
        // fit the flinch clip INTO its short beat (sped, not cut)
        const flinch = this.hitIdx++ % 2 ? "Hit_B" : "Hit_A";
        const fts = Math.max(1, (ch.clipDuration(flinch) * 1000) / HIT_ANIM_MS);
        ch.play(flinch, { loop: false, fade: 0.05, timeScale: fts });
        this.oneShotUntil = now + HIT_ANIM_MS;
        this.lastFlinchAt = now;
      }
    }
    // (dodge-roll removed — Shift now casts the champ's DASH, which plays
    //  Dodge_Forward through the cast one-shot above via lastCastKey. A jump
    //  ATTACK is the JUMP cast — Melee_1H_Attack_Jump_Chop via lastCastKey.)
    // Priority: an active one-shot (attack/cast/hit/dash-ability/jump-attack)
    // plays out; then a mid-air hop runs its 3-phase state machine; then a live
    // whirlwind loops; then a dash shows the run; else locomotion. (Death
    // outranks all via the early return.)
    const airborne = u.jumpUntil > now;
    if (!airborne && this.jumpPhase) this.jumpPhase = ""; // grounded → reset
    if (now < this.oneShotUntil) {
      // hold the current one-shot
    } else if (airborne) {
      // takeoff → float → land, keyed to airtime; trigger each clip ONCE
      const remain = u.jumpUntil - now;
      const elapsed = JUMP_MS - remain;
      const phase = remain <= JUMP_LAND_MS ? "land" : elapsed < JUMP_START_MS ? "start" : "idle";
      if (phase !== this.jumpPhase) {
        this.jumpPhase = phase;
        // takeoff/land clips are SPED to fit their airtime slice — the whole
        // motion plays inside its phase instead of being chopped by the next
        if (phase === "start")
          ch.play(JUMP_START_CLIP, {
            loop: false,
            fade: 0.06,
            timeScale: Math.max(1, (ch.clipDuration(JUMP_START_CLIP) * 1000) / JUMP_START_MS),
          });
        else if (phase === "idle") ch.play(JUMP_IDLE_CLIP, { loop: true, fade: 0.12 });
        else
          ch.play(JUMP_LAND_CLIP, {
            loop: false,
            fade: 0.06,
            timeScale: Math.max(1, (ch.clipDuration(JUMP_LAND_CLIP) * 1000) / JUMP_LAND_MS),
          });
      }
    } else if (spinning) {
      ch.play(SPIN_LOOP_CLIP, { loop: true, fade: 0.1, timeScale: TWO_H_SPEED });
      this.emitTrails(150); // the ult ribbons for its WHOLE duration, not just the cast
    } else if (now < u.dashUntil) {
      ch.play("Running_B", { fade: 0.1 });
    } else {
      ch.play(locomotion(u, this.def.twoHanded ?? false), { fade: 0.16 });
    }
    ch.update(dt);
    this.updateTrails(dt); // sample the blade AFTER the pose updates

    // ── landing squash & stretch (volume-conserving, ~150ms recover) ──
    if (this.prevHop > 0.2 && hopY === 0) {
      this.squash = 1;
      fx?.landJuice(u.x, u.y);
    }
    this.prevHop = hopY;
    this.squash *= Math.max(0, 1 - 9 * dt);
    const bs = this.baseScale;
    ch.root.scale.set(
      bs * (1 + 0.12 * this.squash),
      bs * (1 - 0.18 * this.squash),
      bs * (1 + 0.12 * this.squash),
    );

    // ── dash trail: afterimages + streaks + dust shed behind any ability dash ──
    const dashing = now < u.dashUntil;
    if (dashing && fx) {
      const primary = CHAMP_FX[this.def.id]?.primary ?? 0x9fd0ff;
      if (now - this.lastDashTrailAt > 40) {
        this.lastDashTrailAt = now;
        fx.castStreak(u.x, u.y, -u.dashVx, -u.dashVy, primary, 6, 2, 0.35);
      }
      if (now - this.lastGhostAt > 70) {
        this.lastGhostAt = now;
        fx.ghost(this.group.position.x, this.group.position.z, primary); // Hades-dash afterimage
        if (this.def.id === "witch")
          fx.crossGlint(u.x, 1.0, u.y, -u.dashVy, u.dashVx, 0xb98ae0, 0.6); // broom sparkle
      }
      if (now - this.lastDashDustAt > 80) {
        this.lastDashDustAt = now;
        fx.footDust(u.x, u.y, -u.dashVx, -u.dashVy);
      }
    }
    if (this.wasDashing && !dashing && fx) {
      fx.impactRing(u.x, u.y, CHAMP_FX[this.def.id]?.primary ?? 0x9fd0ff, 1.6); // dash-expiry pop
    }
    this.wasDashing = dashing;

    // footstep dust on fast ground movement (grounds the run cycle)
    const spd = Math.hypot(u.vx, u.vy);
    if (fx && spd > u.moveSpeed * 0.55 && u.jumpUntil <= now && now - this.lastDustAt > 170) {
      this.lastDustAt = now;
      fx.footDust(u.x, u.y, -u.vx, -u.vy);
    }

    // ── ult-ready ring: your selection ring turns molten gold (1.2Hz pulse) ──
    if (this.isLocal) {
      const rReady = u.abilities.R.rank >= 1 && u.abilities.R.readyAt <= now;
      if (rReady) {
        const pulse = 0.5 + 0.5 * Math.sin(now * 0.0075);
        this.ringMat.color.copy(this.ringBase).lerp(GOLD, 0.55 + 0.4 * pulse);
        this.ringMat.opacity = 0.55 + 0.2 * pulse;
        if (fx && now - this.lastUltMoteAt > 500) {
          this.lastUltMoteAt = now;
          fx.mote(
            u.x + (Math.random() - 0.5),
            0.3,
            u.y + (Math.random() - 0.5),
            0xffd24a,
            1.5,
            0.6,
            0.2,
          );
        }
      } else {
        this.ringMat.color.copy(this.ringBase);
        this.ringMat.opacity = 0.55;
      }
    }

    // hit flash (white pulse on damage) — on this unit's cloned materials
    const flash = Math.max(0, 1 - (now - u.lastHitAt) / 110);
    for (const m of this.mats) m.emissive.setRGB(flash, flash * 0.85, flash * 0.7);
    // melee windup glint — micro-anticipation while a swing charges (90–140ms)
    const glint = u.pendingAttack ? 0.35 : 0;
    for (const m of this.weaponMats) m.emissive.setRGB(glint, glint, glint);

    // ── status indicators (stun star / shield dome / slow tint / embers…) ──
    // built lazily on the first status; StatusFx owns stealth opacity + empower
    // weapon glow (per-frame, AFTER the glint baseline above).
    if (fx && !this.statusFx && (u.statuses.length > 0 || u.empowerNext > 0)) {
      this.statusFx = new StatusFx(
        {
          group: this.group,
          bodyMats: this.mats,
          weaponMats: this.weaponMats,
          accent: CHAMP_FX[this.def.id]?.accent ?? 0x9fd0ff,
          isLocal: this.isLocal,
        },
        fx.pools,
      );
    }
    this.statusFx?.update(u, dt, now);
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
    if (this.mushroom) this.mushroom.visible = on;
    this.char.root.visible = !on;
  }

  /** Begin a weapon trail on every melee weapon for the next `dur` ms. */
  private emitTrails(dur: number): void {
    if (this.hexShown) return; // no blade arcs off a mushroom
    for (const t of this.trails) t.emit(dur);
  }

  private updateTrails(dt: number): void {
    for (const t of this.trails) t.update(dt);
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
    for (const m of this.mats) m.dispose();
    for (const m of this.weaponMats) m.dispose();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
  }
}

/** A destructible prop (barrel/crate/keg): the sim unit is authoritative for
 *  alive/hp; this shows the model, a hit flash + squash bounce, and hides the
 *  body on break (the shatter itself is the propBreak fx event). */
class PropView {
  readonly group = new THREE.Group();
  private mats: THREE.MeshStandardMaterial[];
  private baseScale: number;
  private wasAlive = true;
  private squash = 0;
  private lastHitShown = -1;

  constructor(scene: THREE.Scene, lib: ModelLibrary, u: Unit, spec: PropSpec | undefined) {
    const inst = lib.instance(spec?.model ?? u.champId);
    this.group.add(inst);
    this.mats = cloneMats(inst, null);
    this.baseScale = spec?.scale ?? 1;
    this.group.position.set(u.x, terrainHeight(u.x, u.y), u.y);
    this.group.rotation.y = spec?.rot ?? 0;
    this.group.scale.setScalar(this.baseScale);
    scene.add(this.group);
  }

  update(u: Unit, now: number, dt: number, fx: Fx | null): void {
    if (!this.wasAlive && u.alive) fx?.dust(u.x, u.y, 4); // respawn pop
    this.wasAlive = u.alive;
    this.group.visible = u.alive;
    if (!u.alive) return;
    if (u.lastHitAt !== this.lastHitShown) {
      this.lastHitShown = u.lastHitAt;
      if (now - u.lastHitAt < 150) this.squash = 1;
    }
    this.squash *= Math.max(0, 1 - 8 * dt);
    const bs = this.baseScale;
    this.group.scale.set(
      bs * (1 + 0.1 * this.squash),
      bs * (1 - 0.16 * this.squash),
      bs * (1 + 0.1 * this.squash),
    );
    const flash = Math.max(0, 1 - (now - u.lastHitAt) / 110);
    for (const m of this.mats) m.emissive.setRGB(flash, flash * 0.85, flash * 0.6);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const m of this.mats) m.dispose();
  }
}

/** Clone every mesh material under `root` per-instance (optionally tinting),
 *  returning the standard-material list for emissive/opacity writes. */
function cloneMats(root: THREE.Object3D, tint: THREE.Color | null): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (Array.isArray(o.material)) o.material = o.material.map((mm) => mm.clone());
    else o.material = o.material.clone();
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of list) {
      if (mat instanceof THREE.MeshStandardMaterial) {
        if (tint) mat.color.lerp(tint, 0.18); // subtle team/identity hue
        out.push(mat);
      }
    }
  });
  return out;
}

function disposeMat(m: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(m)) for (const mm of m) mm.dispose();
  else m.dispose();
}

export class WorldView {
  private units = new Map<string, UnitView>();
  private props = new Map<string, PropView>();
  private propSpecs = destructibleProps(); // slot-indexed placement lookup
  private projectiles = new Map<string, THREE.Object3D>();
  private coins = new Map<string, THREE.Object3D>();
  private deliveries = new Map<string, THREE.Group>();
  private boss: AnimatedCharacter | null = null;
  private seenCoins = new Set<string>();
  private flyingCoins = new Set<string>();
  private coinTrailAt = new Map<string, number>();
  private coinSparkleAt = new Map<string, number>();
  private deliveryEmitAt = new Map<string, number>();
  private emberNext = new Map<string, number>(); // unit id → next zone-ember ms
  private spinners = new Set<string>(); // unit ids owning a live whirlwind zone
  private bossReturnAt = 0;
  private bossNextTaunt = 6000;
  private fireballFlip = false;
  fx: Fx | null = null; // set by the scene, for projectile trails
  localId = "";

  constructor(
    private scene: THREE.Scene,
    private lib: ModelLibrary,
  ) {}

  setupBoss(): void {
    // the throne golem is a Rig_Large body — bind the Large clip set (the
    // Medium clips squash its proportions)
    this.boss = new AnimatedCharacter(this.lib, "Skeleton_Golem", "Large/");
    this.boss.root.position.set(
      BOSS_POS.x,
      terrainHeight(BOSS_POS.x, BOSS_POS.y) + BOSS_HEIGHT,
      BOSS_POS.y,
    );
    this.boss.root.scale.setScalar(1.5);
    this.scene.add(this.boss.root);
    this.boss.play("Idle_B", { fade: 0 });
  }

  sync(w: World, dt: number): void {
    const now = w.now;

    // units owning a live whirlwind loop their spin clip (knight R keeps
    // spinning visually for the zone's whole duration, not just the cast)
    this.spinners.clear();
    for (const g of w.grounds) {
      if (g.effect === "whirlwind" && g.until > now) this.spinners.add(g.ownerId);
    }

    // units (heroes + neutral creeps + destructible props)
    const seen = new Set<string>();
    const seenProps = new Set<string>();
    for (const u of w.units.values()) {
      if (u.kind === "prop") {
        seenProps.add(u.id);
        let pv = this.props.get(u.id);
        if (!pv) {
          pv = new PropView(this.scene, this.lib, u, this.propSpecs[u.slot]);
          this.props.set(u.id, pv);
        }
        pv.update(u, now, dt, this.fx);
        continue;
      }
      if (u.kind !== "hero" && u.kind !== "creep") continue;
      seen.add(u.id);
      let view = this.units.get(u.id);
      if (!view) {
        const isCreep = u.kind === "creep";
        const def =
          (isCreep ? CREEP_VIEW[u.champId] : CHAMP_BY_ID[u.champId]) ?? CHAMP_BY_ID["knight"]!;
        const color = isCreep ? 0x9aa3b5 : teamColor(u.team);
        view = new UnitView(
          this.scene,
          this.lib,
          def,
          color,
          !isCreep && u.id === this.localId,
          isCreep,
        );
        this.units.set(u.id, view);
        this.scene.add(view.group);
      }
      view.update(u, now, dt, this.fx, this.spinners.has(u.id));
    }
    for (const [id, view] of this.units) {
      if (!seen.has(id)) {
        view.dispose(this.scene);
        this.units.delete(id);
        this.emberNext.delete(id);
      }
    }
    for (const [id, pv] of this.props) {
      if (!seenProps.has(id)) {
        pv.dispose(this.scene);
        this.props.delete(id);
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
      // hexbolt wobbles drunkenly across its travel line (render-only — the
      // sim path stays straight); everything else flies true
      if (p.kind === "hexbolt") {
        const spd = Math.hypot(p.vx, p.vy) || 1;
        const wob = Math.sin(w.now * 0.02 + hashId(p.id) * 0.7) * 0.22;
        mesh.position.x += (-p.vy / spd) * wob;
        mesh.position.z += (p.vx / spd) * wob;
        mesh.position.y += Math.sin(w.now * 0.013 + hashId(p.id)) * 0.12;
      }
      // additive trail behind the projectile
      this.fx?.trail(mesh.position.x, mesh.position.z, projectileColor(p.kind));
      // fireballs drag a smoke tracer — matter under the energy
      if (p.kind === "fireball") {
        this.fireballFlip = !this.fireballFlip;
        if (this.fireballFlip) this.fx?.smokePuff(p.x, 1.1, p.y);
      }
    }
    for (const [id, mesh] of this.projectiles) {
      if (!seenP.has(id)) {
        this.scene.remove(mesh);
        this.projectiles.delete(id);
      }
    }

    // grounds BEFORE coins: Telegraphs.sync advances the frame stamp that the
    // coin-landing marks (telegraphs.mark) must be stamped with.
    this.syncGrounds(w, now);
    this.syncCoins(w, now);
    this.syncDeliveries(w, now);

    if (this.boss) {
      this.boss.update(dt);
      if (this.bossReturnAt && now >= this.bossReturnAt) {
        this.boss.play("Idle_B", { fade: 0.2 });
        this.bossReturnAt = 0;
      } else if (!this.bossReturnAt && now >= this.bossNextTaunt) {
        this.boss.play("Skeletons_Taunt", { fade: 0.2, loop: false });
        // return to idle when the clip actually ends (don't freeze on its last frame)
        this.bossReturnAt = now + this.boss.clipDuration("Skeletons_Taunt") * 1000;
        this.bossNextTaunt = now + 13000;
      }
    }
  }

  private syncCoins(w: World, now: number): void {
    const seen = new Set<string>();
    for (const c of w.coins) {
      seen.add(c.id);
      // a freshly-spawned, still-flying coin = the boss just hurled it → animate;
      // a fresh loot drop (lands instantly) gets its landing pop right away
      if (!this.seenCoins.has(c.id)) {
        this.seenCoins.add(c.id);
        if (now < c.landAt && this.boss) {
          this.boss.play("Throw", { fade: 0.08, loop: false });
          this.bossReturnAt = now + this.boss.clipDuration("Throw") * 1000; // full wind-up, no cut
        } else if (c.loot) {
          this.fx?.impactRing(c.x, c.y, 0xffd24a, 1.0);
          this.fx?.sparks(c.x, 0.6, c.y, 0, 1, 5, 0xfff2b0);
          this.fx?.dust(c.x, c.y, 2);
        }
      }
      let mesh = this.coins.get(c.id);
      if (!mesh) {
        // no castShadow on either shape: the shadow map is static (rendered
        // once) — a moving pickup would leave a stale silhouette
        mesh = c.loot
          ? makeLootPickup(this.lib, c.id)
          : new THREE.Mesh(
              new THREE.CylinderGeometry(0.45, 0.45, 0.14, 18),
              new THREE.MeshStandardMaterial({
                color: 0xffd24a,
                emissive: 0xffaa20,
                emissiveIntensity: 1.0,
                metalness: 0.4,
                roughness: 0.4,
              }),
            );
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
        this.flyingCoins.add(c.id);
        if (this.fx) {
          // landing telegraph: a gold sweep races the coin down — contest signal
          this.fx.telegraphs.mark(
            `coin:${c.id}`,
            c.x,
            c.y,
            1.2,
            0xffd24a,
            Math.min(1, Math.max(0, t)),
          );
          const lastTrail = this.coinTrailAt.get(c.id) ?? 0;
          if (now - lastTrail > 40) {
            this.coinTrailAt.set(c.id, now);
            this.fx.trailAt(x, 0.5 + arc, z, 0xffd24a, 0.35);
          }
        }
      } else {
        if (this.flyingCoins.has(c.id)) {
          // landing frame: thump + sparks
          this.flyingCoins.delete(c.id);
          this.fx?.impactRing(c.x, c.y, 0xffd24a, 1.2);
          this.fx?.sparks(c.x, 0.6, c.y, 0, 1, 6, 0xffd24a);
          this.fx?.dust(c.x, c.y, 2);
        }
        mesh.position.set(c.x, terrainHeight(c.x, c.y) + 0.6 + Math.sin(now * 0.004) * 0.15, c.y);
        // grounded pickups wink — a cheap "come get me"
        const lastSparkle = this.coinSparkleAt.get(c.id) ?? 0;
        if (this.fx && now - lastSparkle > 700) {
          this.coinSparkleAt.set(c.id, now);
          this.fx.crossGlint(c.x, terrainHeight(c.x, c.y) + 0.9, c.y, 1, 0, 0xfff2b0, 0.5);
        }
      }
      if (c.loot) {
        // weapon piece: slow showcase spin (tilt lives on the inner group)
        mesh.rotation.y = now * 0.0022 + (hashId(c.id) % 7);
      } else {
        mesh.rotation.y = now * 0.005;
        mesh.rotation.x = Math.PI / 2;
      }
    }
    for (const [id, mesh] of this.coins) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.coins.delete(id);
        this.seenCoins.delete(id);
        this.flyingCoins.delete(id);
        this.coinTrailAt.delete(id);
        this.coinSparkleAt.delete(id);
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
          new THREE.MeshStandardMaterial({
            color: 0x66ffcc,
            emissive: 0x22cc88,
            emissiveIntensity: 0.5,
            roughness: 0.6,
          }),
        );
        crate.position.y = 0.7; // no castShadow — static shadow map
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.7, 1.3, 9, 16, 1, true),
          new THREE.MeshBasicMaterial({
            color: 0x66ffcc,
            transparent: true,
            opacity: 0.14,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        beam.position.y = 4.5;
        group.add(crate, beam);
        this.deliveries.set(d.id, group);
        this.scene.add(group);
      }
      group.position.set(d.x, terrainHeight(d.x, d.y), d.y);
      group.rotation.y = now * 0.0015;
      group.children[0]!.position.y = 0.7 + Math.sin(now * 0.003) * 0.18;
      // beacon pulse + a double-helix of motes climbing the beam
      group.children[1]!.scale.setScalar(1 + 0.06 * (0.5 + 0.5 * Math.sin(now * 0.004)));
      if (this.fx) {
        const last = this.deliveryEmitAt.get(d.id) ?? 0;
        if (now - last > 120) {
          this.deliveryEmitAt.set(d.id, now);
          const a = now * 0.004;
          for (const off of [0, Math.PI]) {
            this.fx.mote(
              d.x + Math.cos(a + off) * 0.9,
              0.4,
              d.y + Math.sin(a + off) * 0.9,
              0x66ffcc,
              2.4,
              0.7,
              0.22,
            );
          }
        }
      }
    }
    for (const [id, group] of this.deliveries) {
      if (!seen.has(id)) {
        this.scene.remove(group);
        this.deliveries.delete(id);
        this.deliveryEmitAt.delete(id);
      }
    }
  }

  private syncGrounds(w: World, now: number): void {
    const fx = this.fx;
    if (!fx) return;
    const localTeam = w.units.get(this.localId)?.team ?? "";
    fx.telegraphs.sync(w.grounds, localTeam, now);
    for (const g of w.grounds) {
      fx.zoneAmbient(g, now);
      // ambient-ize silent tick damage: units standing in a hostile dps zone
      // shed embers in the zone color (throttled per unit)
      if (!g.enemyDps) continue;
      const r2 = g.radius * g.radius;
      for (const u of w.units.values()) {
        if (!u.alive || u.team === g.team) continue;
        if (u.kind !== "hero" && u.kind !== "creep") continue;
        if ((u.x - g.x) ** 2 + (u.y - g.y) ** 2 > r2) continue;
        const next = this.emberNext.get(u.id) ?? 0;
        if (now < next) continue;
        this.emberNext.set(u.id, now + 250);
        fx.zoneEmber(u.x, u.y, groundFxColor(g.effect));
      }
    }
  }
}

function projectileColor(kind: string): number {
  return kind === "fireball"
    ? 0xff7a2c
    : kind === "bolt"
      ? 0xb070ff
      : kind === "arrow"
        ? 0xffe6a0
        : kind === "hexbolt"
          ? 0x7fe08a
          : 0xffffff;
}

// Projectile geometry/materials are SHARED per kind (projectiles churn fast —
// per-instance allocations leaked GPU buffers since nothing disposed them).
const PROJ_GEO = {
  shaft: new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6),
  shard: new THREE.ConeGeometry(0.16, 1.1, 6),
  sphere: new THREE.SphereGeometry(1, 12, 12),
};
const projMatCache = new Map<string, THREE.MeshBasicMaterial>();
function projMat(key: string, make: () => THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
  let m = projMatCache.get(key);
  if (!m) {
    m = make();
    projMatCache.set(key, m);
  }
  return m;
}
function haloMat(color: number, opacity: number): THREE.MeshBasicMaterial {
  return projMat(
    `halo:${color}:${opacity}`,
    () =>
      new THREE.MeshBasicMaterial({
        color,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity,
        depthWrite: false,
      }),
  );
}

function makeProjectileMesh(p: Projectile): THREE.Object3D {
  const color = projectileColor(p.kind);
  const g = new THREE.Group();

  if (p.kind === "arrow") {
    const shaft = new THREE.Mesh(
      PROJ_GEO.shaft,
      projMat("shaft", () => new THREE.MeshBasicMaterial({ color: 0xcfa15a })),
    );
    shaft.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(PROJ_GEO.sphere, haloMat(color, 1));
    tip.scale.setScalar(0.13);
    tip.position.z = 0.5;
    g.add(shaft, tip);
  } else if (p.kind === "bolt") {
    // bone spear — an elongated glowing shard along its travel direction
    const shard = new THREE.Mesh(PROJ_GEO.shard, haloMat(color, 0.95));
    shard.rotation.x = Math.PI / 2; // point along +z (velocity)
    const glow = new THREE.Mesh(PROJ_GEO.sphere, haloMat(color, 0.3));
    glow.scale.setScalar(0.28);
    g.add(shard, glow);
  } else {
    // boiling energy core (fbm shader surface, HDR — blooms) + additive halo
    const coreR = p.kind === "fireball" ? 0.38 : 0.2;
    const core = new THREE.Mesh(PROJ_GEO.sphere, energyBallMaterial(color));
    core.scale.setScalar(coreR);
    const halo = new THREE.Mesh(PROJ_GEO.sphere, haloMat(color, 0.35));
    halo.scale.setScalar(coreR * 1.9);
    g.add(core, halo);
  }
  return g;
}
