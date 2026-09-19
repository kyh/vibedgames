import * as THREE from "three";
import type {
  AttackDef,
  BrawlerDef,
  LeapAttack,
  LobAttack,
  MeleeAttack,
  SpreadAttack,
  VolleyAttack,
} from "../config";
import { BRAWLER_RADIUS, TUNING } from "../config";
import { swingMelee } from "../combat/melee";
import type { Game } from "../game";
import type { BrawlerDrive, NetTarget } from "../net/interpolation";
import { makeNetTarget, snapToTarget, steerPuppet } from "../net/interpolation";
import { clamp, damp, dampAngle, lerp } from "../utils";
import {
  buildBrawlerModel,
  PLAYER_DISC_GEOMETRY,
  SUPER_RING_GEOMETRY,
  TEAM_RING_GEOMETRY,
} from "./brawler-model";
import type { BrawlerModel } from "./brawler-model";
import { advanceEvasion, createEvasion, EVADE, evadeStyle, evasionInvulnerable } from "./evasion";
import type { EvasionState } from "./evasion";
import { sampleMeleePose } from "./melee-pose";
import type { MeleeCue, MeleePose } from "./melee-pose";
import { rangedPoseDuration, sampleRangedPose } from "./ranged-pose";
import type { RangedCue } from "./ranged-pose";

/** Hit stop on a hit the player deals or takes: three frames, a kill holds longer. */
const HIT_STOP_S = 0.05;
const KILL_STOP_S = 0.12;

// A multi-shot attack in flight: one shot fires every `a.interval` seconds
// until `left` reaches zero, all along the direction captured at the trigger.
interface BurstState {
  a: VolleyAttack;
  left: number;
  timer: number;
  dirX: number;
  dirZ: number;
  isSuper: boolean;
}

interface MeleeState {
  a: MeleeAttack;
  dx: number;
  dz: number;
  isSuper: boolean;
  remaining: number;
}

// A leap super in flight, interpolated from the launch tile to the landing tile.
interface LeapState {
  a: LeapAttack;
  t: number;
  sx: number;
  sz: number;
  tx: number;
  tz: number;
}

export interface BrawlerOptions {
  /** Who advances this body each frame: the sim (solo/host), local prediction or snapshots. */
  drive?: BrawlerDrive;
  isPlayer?: boolean;
  name: string;
  /** Wire id (`p:<playerId>` / `bot:<n>`); defaults to a local-only id. */
  netId?: string;
  /** Owning player online, null for a bot or the solo player. */
  owner?: string | null;
  x: number;
  z: number;
  hueShift?: number;
}

type GroundMarker = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

const PLAYER_RING_COLOR = 0x3d_ff_8a;
const BOT_RING_COLOR = 0xff_4a_3a;
const MAX_AMMO = 3;
const ORIGIN = new THREE.Vector3();

let nextBrawlerId = 1;

export class Brawler {
  readonly game: Game;
  readonly def: BrawlerDef;
  readonly id: number;
  readonly isPlayer: boolean;
  readonly name: string;
  readonly netId: string;
  readonly owner: string | null;
  readonly hueShift: number;
  drive: BrawlerDrive;
  /** The host's last pose, for a guest-driven body. */
  readonly netTarget: NetTarget;
  /** Mid-leap according to the host (guest bodies never hold a `leap`). */
  netAir: boolean;
  readonly model: BrawlerModel;
  readonly root: THREE.Group;
  readonly ring: GroundMarker;
  readonly disc: GroundMarker | null;
  readonly superRing: GroundMarker;

  maxHp: number;
  hp: number;
  ammo: number;
  reloadT: number;
  superCharge: number;
  cubes: number;
  kills: number;
  alive: boolean;
  deadT: number;
  rank: number;
  readonly vel: THREE.Vector2;
  readonly knock: THREE.Vector2;
  moveX: number;
  moveZ: number;
  facing: number;
  /** Live player aim, independent of an attack's committed direction. */
  lookAngle: number | null;
  aimAngle: number;
  aimHold: number;
  fireCooldown: number;
  burst: BurstState | null;
  swing: MeleeState | null;
  meleeCue: MeleeCue | null = null;
  rangedCue: RangedCue | null = null;
  leap: LeapState | null;
  evasion: EvasionState | null = null;
  evadeCooldown = 0;
  muzzleIndex: number;
  lastCombat: number;
  lastAttacker: Brawler | null;
  lastHitTime: number;
  regenT: number;
  inBush: boolean;
  revealT: number;
  hidden: boolean;
  flash: number;
  recoil: number;
  walkPhase: number;
  squash: number;
  /** Seconds this body holds still after dealing or taking a telling hit. */
  freezeT = 0;
  readonly lightColor: THREE.Color;
  readonly superColor: THREE.Color;

  // Ranged props keep their authored grip while the whole body follows recoil.
  private readonly weaponRestRotation: THREE.Euler;
  private readonly weaponRestPosition: THREE.Vector3;
  private readonly rightHandRest: THREE.Vector3;
  private readonly rangedGrip = new THREE.Vector3();
  private readonly meleeWeaponRotation = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly meleeWeaponQuaternion = new THREE.Quaternion();
  private readonly evasionRotation = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly evasionWeaponQuaternion = new THREE.Quaternion();

  constructor(game: Game, def: BrawlerDef, options: BrawlerOptions) {
    this.game = game;
    this.def = def;
    this.id = nextBrawlerId;
    nextBrawlerId += 1;
    this.isPlayer = options.isPlayer ?? false;
    this.name = options.name;
    this.netId = options.netId ?? `local:${this.id}`;
    this.owner = options.owner ?? null;
    this.hueShift = options.hueShift ?? 0;
    this.drive = options.drive ?? "sim";
    this.netTarget = makeNetTarget();
    this.netAir = false;
    this.model = buildBrawlerModel(def, this.hueShift);
    this.root = this.model.root;
    this.root.position.set(options.x, game.world.heightAt(options.x, options.z), options.z);
    game.scene.add(this.root);
    this.weaponRestRotation = this.model.weapon.rotation.clone();
    this.weaponRestPosition = this.model.weapon.position.clone();
    this.rightHandRest = new THREE.Vector3(0, -0.28, 0).applyEuler(this.model.arms[1].rotation);

    const ringColor = this.isPlayer ? PLAYER_RING_COLOR : BOT_RING_COLOR;
    this.ring = new THREE.Mesh(
      TEAM_RING_GEOMETRY.clone(),
      new THREE.MeshBasicMaterial({
        color: ringColor,
        depthWrite: false,
        opacity: 0.92,
        transparent: true,
      }),
    );
    this.ring.position.y = 0.04;
    this.ring.renderOrder = 2;
    this.ring.userData.noAO = true;
    this.root.add(this.ring);

    this.disc = null;
    if (this.isPlayer) {
      const disc = new THREE.Mesh(
        PLAYER_DISC_GEOMETRY.clone(),
        new THREE.MeshBasicMaterial({
          color: ringColor,
          depthWrite: false,
          opacity: 0.16,
          transparent: true,
        }),
      );
      disc.position.y = 0.035;
      disc.renderOrder = 2;
      disc.userData.noAO = true;
      this.root.add(disc);
      this.disc = disc;
    }

    this.superRing = new THREE.Mesh(
      SUPER_RING_GEOMETRY.clone(),
      new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending,
        color: new THREE.Color(3.2, 2.3, 0.4),
        depthWrite: false,
        opacity: 0,
        transparent: true,
      }),
    );
    this.superRing.position.y = 0.045;
    this.superRing.renderOrder = 3;
    this.superRing.userData.noAO = true;
    this.root.add(this.superRing);

    this.maxHp = def.hp;
    this.hp = def.hp;
    this.ammo = MAX_AMMO;
    this.reloadT = 0;
    this.superCharge = 0;
    this.cubes = 0;
    this.kills = 0;
    this.alive = true;
    this.deadT = 0;
    this.rank = 0;
    this.vel = new THREE.Vector2();
    this.knock = new THREE.Vector2();
    this.moveX = 0;
    this.moveZ = 0;
    // Spawn facing the arena centre.
    this.facing = Math.atan2(-options.x, -options.z);
    this.lookAngle = null;
    this.aimAngle = this.facing;
    this.aimHold = 0;
    this.fireCooldown = 0;
    this.burst = null;
    this.swing = null;
    this.leap = null;
    this.muzzleIndex = 0;
    this.lastCombat = -10;
    this.lastAttacker = null;
    this.lastHitTime = -10;
    this.regenT = 0;
    this.inBush = false;
    this.revealT = 0;
    this.hidden = false;
    this.flash = 0;
    this.recoil = 0;
    this.walkPhase = Math.random() * 6;
    this.squash = 0;
    this.lightColor = new THREE.Color(def.attack.color);
    this.superColor = new THREE.Color(def.super.color);
  }

  get x(): number {
    return this.root.position.x;
  }

  get z(): number {
    return this.root.position.z;
  }

  get damageMul(): number {
    return 1 + this.cubes * TUNING.cubeDamage;
  }

  get superReady(): boolean {
    return this.superCharge >= 1;
  }

  get airborne(): boolean {
    return this.leap !== null || this.netAir;
  }

  get evadingInvulnerable(): boolean {
    return evasionInvulnerable(this.evasion);
  }

  /** Hidden mercy only ever softens bots against the solo player. */
  private mercyScale(): number {
    return this.isPlayer && this.game.mode === "solo" ? this.game.mercy.damageScale : 1;
  }

  /** Freeze both parties briefly; only bodies the sim drives can hold. */
  private hitStop(source: Brawler | null, seconds: number): void {
    if (this.drive === "sim") {
      this.freezeT = Math.max(this.freezeT, seconds);
    }
    if (source && source !== this && source.drive === "sim") {
      source.freezeT = Math.max(source.freezeT, seconds);
    }
  }

  /** A person plays this brawler (locally or from another client), not a bot brain. */
  get isHuman(): boolean {
    return this.isPlayer || this.owner !== null;
  }

  // The current muzzle offset rotated by the aim angle into world space.
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    const { muzzles } = this.model;
    const muzzle = muzzles[this.muzzleIndex % muzzles.length] ?? ORIGIN;
    const cos = Math.cos(this.aimAngle);
    const sin = Math.sin(this.aimAngle);
    out.set(
      this.x + muzzle.x * cos + muzzle.z * sin,
      muzzle.y + this.root.position.y,
      this.z - muzzle.x * sin + muzzle.z * cos,
    );
    return out;
  }

  canAct(): boolean {
    return this.alive && !this.airborne && !this.evasion && this.game.state !== "countdown";
  }

  evade(dx: number, dz: number): boolean {
    if (
      !this.alive ||
      this.drive === "puppet" ||
      this.airborne ||
      this.evasion ||
      this.evadeCooldown > 0 ||
      !Number.isFinite(dx) ||
      !Number.isFinite(dz) ||
      this.game.state !== "playing"
    ) {
      return false;
    }
    this.evasion = createEvasion(dx, dz, this.facing);
    this.evadeCooldown = EVADE.cooldown;
    this.burst = null;
    this.swing = null;
    this.meleeCue = null;
    this.rangedCue = null;
    this.freezeT = 0;
    this.knock.set(0, 0);
    this.recoil = 0;
    this.revealT = Math.max(this.revealT, EVADE.duration);
    if (evadeStyle(this.def.id) === "blink") {
      this.game.effects.burst(this.x, this.root.position.y + 0.65, this.z, this.lightColor, 9, 2.6);
      this.game.effects.ring(this.x, this.z, 0.8, this.lightColor, 0.2, 0.8);
    } else {
      this.game.effects.dust(this.x, this.z, 6, 1.7);
    }
    this.game.audio.play("leap", this.x, this.z);
    return true;
  }

  attack(dx: number, dz: number, x: number, z: number): boolean {
    if (!this.canAct() || this.ammo < 1 || this.fireCooldown > 0 || this.burst || this.swing) {
      return false;
    }
    this.ammo -= 1;
    this.startVolley(this.def.attack, dx, dz, x, z, false);
    return true;
  }

  useSuper(dx: number, dz: number, x: number, z: number): boolean {
    if (!this.canAct() || !this.superReady || this.burst || this.swing) {
      return false;
    }
    this.superCharge = 0;
    this.startVolley(this.def.super, dx, dz, x, z, true);
    this.game.audio.play("super");
    return true;
  }

  // Aim along (dx, dz) toward the target point and launch whichever attack
  // shape the definition describes.
  startVolley(
    a: AttackDef,
    dx: number,
    dz: number,
    targetX: number,
    targetZ: number,
    isSuper: boolean,
  ): void {
    const len = Math.hypot(dx, dz);
    const dirX = len > 0.001 ? dx / len : Math.sin(this.facing);
    const dirZ = len > 0.001 ? dz / len : Math.cos(this.facing);
    this.aimAngle = Math.atan2(dirX, dirZ);
    this.aimHold = 0.55;
    this.lastCombat = this.game.elapsed;
    this.revealT = Math.max(this.revealT, 0.9);
    this.fireCooldown = 0.22;
    if (a.kind === "spread") {
      this.fireSpread(a, isSuper);
    } else if (a.kind === "burst") {
      this.burst = { a, dirX, dirZ, isSuper, left: a.count, timer: 0 };
      this.fireCooldown = a.count * a.interval + 0.12;
    } else if (a.kind === "melee") {
      this.swing = { a, dx: dirX, dz: dirZ, isSuper, remaining: a.windup };
      this.meleeCue = {
        angle: this.aimAngle,
        elapsed: 0,
        recovery: a.recovery,
        windup: a.windup,
      };
      this.recoil = 0.35;
      this.fireCooldown = a.windup + a.recovery;
    } else if (a.kind === "lob") {
      this.throwLob(a, dirX, dirZ, targetX, targetZ, isSuper);
    } else if (a.kind === "leap") {
      this.startLeap(a, dirX, dirZ, targetX, targetZ);
    }
  }

  private fireSpread(a: SpreadAttack, isSuper: boolean): void {
    this.rangedCue = { elapsed: 0, isSuper };
    this.recoil = 1;
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    for (let i = 0; i < a.pellets; i += 1) {
      const fan = a.pellets === 1 ? 0 : i / (a.pellets - 1) - 0.5;
      const angle = this.aimAngle + fan * a.spread + (this.game.rng() - 0.5) * 0.04;
      this.game.combat.spawnBullet(
        this,
        muzzle.x,
        muzzle.z,
        Math.sin(angle),
        Math.cos(angle),
        a,
        isSuper,
        a.speed * (0.94 + this.game.rng() * 0.12),
      );
    }
    this.game.effects.impact(
      muzzle.x,
      muzzle.y,
      muzzle.z,
      this.bulletColor(isSuper),
      isSuper ? 4 : 2,
    );
    this.game.audio.play(a.style === "thorn" ? "thorns" : "shotBig", this.x, this.z);
  }

  private throwLob(
    a: LobAttack,
    dirX: number,
    dirZ: number,
    targetX: number,
    targetZ: number,
    isSuper: boolean,
  ): void {
    this.rangedCue = { elapsed: 0, isSuper };
    this.recoil = 1;
    const reach = Math.min(a.range, Math.hypot(targetX - this.x, targetZ - this.z));
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    this.game.combat.spawnBomb(
      this,
      muzzle.x,
      muzzle.y,
      muzzle.z,
      this.x + dirX * reach,
      this.z + dirZ * reach,
      a,
      isSuper,
    );
    this.game.effects.impact(
      muzzle.x,
      muzzle.y,
      muzzle.z,
      this.bulletColor(isSuper),
      isSuper ? 8 : 4,
    );
    this.game.audio.play(a.style === "potion" ? "splash" : "lob", this.x, this.z);
    this.fireCooldown = 0.3;
  }

  private startLeap(
    a: LeapAttack,
    dirX: number,
    dirZ: number,
    targetX: number,
    targetZ: number,
  ): void {
    const reach = clamp(Math.hypot(targetX - this.x, targetZ - this.z), 2, a.range);
    const landing = this.game.world.nearestOpen(this.x + dirX * reach, this.z + dirZ * reach);
    this.leap = { a, sx: this.x, sz: this.z, t: 0, tx: landing.x, tz: landing.z };
    this.game.effects.dust(this.x, this.z, 10, 2.4);
    this.game.audio.play("leap", this.x, this.z);
  }

  bulletColor(isSuper: boolean): THREE.Color {
    return isSuper ? this.superColor : this.lightColor;
  }

  fireBurstShot(): void {
    const { burst } = this;
    if (!burst) {
      return;
    }
    const { a } = burst;
    if (this.def.attack.kind !== "melee") {
      this.rangedCue = { elapsed: 0, isSuper: burst.isSuper };
    }
    this.muzzleIndex += 1;
    this.recoil = 1;
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    const angle = Math.atan2(burst.dirX, burst.dirZ) + (this.game.rng() - 0.5) * 2 * a.jitter;
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);
    this.game.combat.spawnBullet(this, muzzle.x, muzzle.z, dirX, dirZ, a, burst.isSuper, a.speed);
    if (this.def.attack.kind === "melee") {
      this.meleeCue = { angle, elapsed: 0.12, recovery: 0.38, windup: 0.12 };
    }
    this.game.audio.play(a.style === "bolt" ? "bolt" : "shot", this.x, this.z);
  }

  addCharge(amount: number): void {
    if (!this.alive) {
      return;
    }
    const wasReady = this.superReady;
    this.superCharge = Math.min(1, this.superCharge + amount / this.def.superCharge);
    if (!wasReady && this.superReady && this.isPlayer) {
      this.game.audio.play("ready");
    }
  }

  // Returns the damage actually absorbed (capped at remaining hp) so the
  // attacker's super charge reflects what landed, not overkill.
  takeDamage(amount: number, source: Brawler | null = null, isGas = false): number {
    if (!this.alive || this.airborne || (!isGas && this.evadingInvulnerable)) {
      return 0;
    }
    let dealt = amount;
    if (source && !source.isHuman) {
      // Bots hit humans at the difficulty's rate and each other softly, so
      // bot-on-bot fights thin the field without deciding the match.
      dealt *= this.isHuman ? this.game.difficulty.damage * this.mercyScale() : 0.34;
    }
    if (source) {
      this.lastAttacker = source;
      this.lastHitTime = this.game.elapsed;
    }
    dealt = Math.round(dealt);
    const absorbed = Math.min(this.hp, dealt);
    this.hp -= dealt;
    this.lastCombat = this.game.elapsed;
    this.regenT = 0;
    this.flash = 1;
    this.squash = 1;
    this.revealT = Math.max(this.revealT, 0.9);
    if (this.def.id === "titan") {
      this.addCharge(dealt * 0.35);
    }
    if (source && source !== this) {
      source.addCharge(absorbed);
      source.lastCombat = this.game.elapsed;
    }
    this.presentHit(dealt, source, isGas);
    if (this.hp <= 0) {
      this.die(source);
    }
    return absorbed;
  }

  /** Everything a hit shows and sounds: the number, the beat, the thud, the flash. */
  private presentHit(dealt: number, source: Brawler | null, isGas: boolean): void {
    if (!this.hidden || this.isPlayer) {
      this.game.hud.floatText(this.x, 1.7, this.z, `${dealt}`, this.isPlayer ? "dmg-self" : "dmg");
    }
    if (!isGas && (this.isPlayer || source?.isPlayer)) {
      this.hitStop(source, this.hp <= 0 ? KILL_STOP_S : HIT_STOP_S);
    }
    if (!isGas) {
      this.game.audio.play("hit", this.x, this.z);
    }
    if (this.isPlayer) {
      this.game.onPlayerHurt(dealt);
    }
  }

  heal(amount: number): void {
    if (!this.alive || this.hp >= this.maxHp) {
      return;
    }
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    const gained = Math.round(this.hp - before);
    if (gained > 0 && (!this.hidden || this.isPlayer)) {
      this.game.hud.floatText(this.x, 1.7, this.z, `+${gained}`, "heal");
      this.game.effects.healPuff(this.x, this.z);
    }
  }

  // A power cube raises max hp and tops up half a cube's worth on the spot.
  addCube(): void {
    this.cubes += 1;
    const fraction = this.hp / this.maxHp;
    this.maxHp += TUNING.cubeHp;
    this.hp = Math.min(this.maxHp, Math.round(this.maxHp * fraction) + TUNING.cubeHp * 0.5);
    this.squash = -1;
  }

  die(killer: Brawler | null): void {
    if (!this.alive) {
      return;
    }
    this.alive = false;
    this.hp = 0;
    this.deadT = 0;
    this.burst = null;
    this.swing = null;
    this.rangedCue = null;
    this.leap = null;
    this.evasion = null;
    if (killer && killer !== this) {
      killer.kills += 1;
    }
    this.game.onBrawlerDown(this, killer);
  }

  update(dt: number): void {
    if (this.drive === "puppet") {
      this.updatePuppet(dt);
      return;
    }
    if (this.drive === "predict") {
      this.updatePredict(dt);
      return;
    }
    if (!this.alive) {
      this.updateDeath(dt);
      return;
    }
    if (this.freezeT > 0) {
      // Hit stop: the parties to a blow hold still for a beat so it lands.
      this.freezeT = Math.max(0, this.freezeT - dt);
      if (!this.evasion) {
        return;
      }
    }
    this.tickTimers(dt);
    this.tickReload(dt);
    this.tickBurst(dt);
    this.tickMelee(dt);
    if (this.evasion) {
      this.tickEvasion(dt, this.evasion);
    } else if (this.leap) {
      this.tickLeap(dt, this.leap);
    } else {
      this.tickMovement(dt);
    }
    const moving = this.vel.lengthSq() > 0.2 && !this.leap;
    this.updateFacing(dt, moving);
    this.updateBush();
    this.tickRegen(dt);
    this.animate(dt, moving);
  }

  // A remote body on a guest: chase the host's pose and animate what it implies.
  private updatePuppet(dt: number): void {
    if (!this.alive) {
      this.updateDeath(dt);
      return;
    }
    this.tickTimers(dt);
    const moving = steerPuppet(this, dt);
    if (this.evasion) {
      const before = this.evasion.elapsed;
      this.evasion.elapsed += dt;
      this.showEvasionTrail(before, this.evasion);
      if (this.evasion.elapsed >= EVADE.duration) {
        this.evasion = null;
      }
    }
    this.root.rotation.y = this.facing;
    this.animate(dt, moving);
  }

  // The guest's own body: local input moves it now; the host corrects it later.
  private updatePredict(dt: number): void {
    if (!this.alive) {
      this.updateDeath(dt);
      return;
    }
    this.tickTimers(dt);
    let moving = false;
    if (this.netAir) {
      snapToTarget(this);
    } else if (this.evasion) {
      this.tickEvasion(dt, this.evasion);
      moving = this.vel.lengthSq() > 0.2;
    } else {
      this.tickMovement(dt);
      moving = this.vel.lengthSq() > 0.2;
    }
    this.updateFacing(dt, moving);
    const pos = this.root.position;
    this.inBush = !this.netAir && this.game.world.isBushAt(pos.x, pos.z);
    this.animate(dt, moving);
  }

  // Shrink and spin away over a third of a second, then drop out of the scene.
  private updateDeath(dt: number): void {
    this.deadT += dt;
    const scale = clamp(1 - this.deadT / 0.32, 0, 1);
    this.root.scale.setScalar(scale);
    this.root.rotation.y += dt * 14;
    if (scale <= 0) {
      this.root.visible = false;
    }
  }

  private tickTimers(dt: number): void {
    this.evadeCooldown = Math.max(0, this.evadeCooldown - dt);
    if (this.rangedCue) {
      this.rangedCue.elapsed += dt;
      if (this.rangedCue.elapsed >= rangedPoseDuration(this.def.id, this.rangedCue.isSuper)) {
        this.rangedCue = null;
      }
    }
    if (this.meleeCue) {
      this.meleeCue.elapsed += dt;
      if (this.meleeCue.elapsed >= this.meleeCue.windup + this.meleeCue.recovery) {
        this.meleeCue = null;
      }
    }
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.aimHold = Math.max(0, this.aimHold - dt);
    this.revealT = Math.max(0, this.revealT - dt);
    this.flash = Math.max(0, this.flash - dt * 7);
    this.recoil = damp(this.recoil, 0, this.def.attack.kind === "melee" ? 8 : 14, dt);
    this.squash = damp(this.squash, 0, 12, dt);
  }

  private tickReload(dt: number): void {
    if (this.ammo < MAX_AMMO) {
      this.reloadT += dt / this.def.reload;
      if (this.reloadT >= 1) {
        this.reloadT = 0;
        this.ammo = Math.min(MAX_AMMO, this.ammo + 1);
      }
    } else {
      this.reloadT = 0;
    }
  }

  private tickBurst(dt: number): void {
    const { burst } = this;
    if (!burst) {
      return;
    }
    burst.timer -= dt;
    while (burst.timer <= 0 && burst.left > 0) {
      this.fireBurstShot();
      burst.left -= 1;
      burst.timer += burst.a.interval;
    }
    if (burst.left <= 0) {
      this.burst = null;
    }
    this.aimHold = Math.max(this.aimHold, 0.35);
  }

  private tickMelee(dt: number): void {
    const { swing } = this;
    if (!swing) {
      return;
    }
    swing.remaining -= dt;
    this.aimHold = Math.max(this.aimHold, 0.35);
    if (swing.remaining <= 0) {
      this.swing = null;
      this.recoil = 1;
      swingMelee(this.game.combat, this, swing.a, swing.dx, swing.dz, swing.isSuper);
      this.game.audio.play("punch", this.x, this.z);
    }
  }

  // Arc between launch and landing tiles with a full forward flip, then slam.
  private tickLeap(dt: number, leap: LeapState): void {
    const pos = this.root.position;
    const { body } = this.model;
    leap.t += dt;
    const progress = clamp(leap.t / leap.a.flight, 0, 1);
    pos.x = lerp(leap.sx, leap.tx, progress);
    pos.z = lerp(leap.sz, leap.tz, progress);
    pos.y =
      lerp(
        this.game.world.heightAt(leap.sx, leap.sz),
        this.game.world.heightAt(leap.tx, leap.tz),
        progress,
      ) +
      Math.sin(progress * Math.PI) * 3.4;
    body.rotation.x = progress * Math.PI * 2;
    this.aimAngle = Math.atan2(leap.tx - leap.sx, leap.tz - leap.sz);
    this.aimHold = 0.3;
    if (progress >= 1) {
      pos.y = this.game.world.heightAt(pos.x, pos.z);
      body.rotation.x = 0;
      this.leap = null;
      this.squash = 1.4;
      this.game.world.resolveCircle(pos, BRAWLER_RADIUS);
      pos.y = this.game.world.heightAt(pos.x, pos.z);
      this.game.combat.explode(pos.x, pos.z, leap.a, this, true, true);
    }
  }

  private tickMovement(dt: number): void {
    const pos = this.root.position;
    let { speed } = this.def;
    // Firing a ranged burst slows the shooter; melee swings keep full pace.
    if (this.burst) {
      speed *= 0.82;
    }
    if (this.game.state === "countdown") {
      speed = 0;
    }
    this.vel.set(this.moveX * speed, this.moveZ * speed);
    const knockX = this.knock.x;
    const knockZ = this.knock.y;
    pos.x += (this.vel.x + knockX) * dt;
    pos.z += (this.vel.y + knockZ) * dt;
    this.knock.multiplyScalar(Math.exp(-7 * dt));
    this.game.world.resolveCircle(pos, BRAWLER_RADIUS);
    pos.y = this.game.world.heightAt(pos.x, pos.z);
  }

  private tickEvasion(dt: number, state: EvasionState): void {
    const before = state.elapsed;
    const { x } = this;
    const { z } = this;
    const finished = advanceEvasion(state, this.root.position, this.game.world, dt);
    if (dt > 0) {
      this.vel.set((this.x - x) / dt, (this.z - z) / dt);
    }
    this.showEvasionTrail(before, state);
    if (finished) {
      this.evasion = null;
      if (evadeStyle(this.def.id) === "blink") {
        this.game.effects.burst(this.x, this.root.position.y + 0.65, this.z, this.lightColor, 7, 2);
      }
    }
  }

  private showEvasionTrail(before: number, state: EvasionState): void {
    if (Math.floor(state.elapsed / 0.045) <= Math.floor(before / 0.045)) {
      return;
    }
    if (evadeStyle(this.def.id) === "blink") {
      this.game.effects.trail(this.x, this.root.position.y + 0.65, this.z, this.lightColor, 0.7);
    } else {
      this.game.effects.footDust(this.x, this.z);
    }
  }

  // Follow live aim while strafing; melee poses keep the blade on its committed hit sector.
  private updateFacing(dt: number, moving: boolean): void {
    let target = this.lookAngle ?? this.facing;
    const aiming = this.lookAngle !== null || this.aimHold > 0;
    if (this.meleeCue && this.lookAngle === null) {
      target = this.meleeCue.angle;
    } else if (this.leap || (this.lookAngle === null && this.aimHold > 0)) {
      target = this.aimAngle;
    } else if (this.lookAngle === null && moving) {
      target = Math.atan2(this.vel.x, this.vel.y);
    }
    this.facing = dampAngle(this.facing, target, aiming || this.meleeCue ? 26 : 13, dt);
    this.root.rotation.y = this.facing;
  }

  private updateBush(): void {
    const pos = this.root.position;
    const wasInBush = this.inBush;
    this.inBush = !this.leap && this.game.world.isBushAt(pos.x, pos.z);
    if (this.inBush !== wasInBush && (!this.hidden || this.isPlayer)) {
      this.game.effects.leaves(pos.x, pos.z, 5);
    }
  }

  // Out of combat for three seconds: recover 13% of max hp every second.
  private tickRegen(dt: number): void {
    if (this.game.elapsed - this.lastCombat > 3 && this.hp < this.maxHp) {
      this.regenT += dt;
      if (this.regenT >= 1) {
        this.regenT = 0;
        this.heal(Math.round(this.maxHp * 0.13));
      }
    }
  }

  animate(dt: number, moving: boolean): void {
    const speed = this.vel.length();
    if (moving) {
      const step = dt * speed * 3.3;
      this.walkPhase += step;
      // A sign change of the stride wave is a footfall.
      const footfall = Math.sin(this.walkPhase) * Math.sin(this.walkPhase - step) < 0;
      if (footfall && (!this.hidden || this.isPlayer) && !this.inBush) {
        this.game.effects.footDust(this.x, this.z);
      }
    }
    const stride = moving ? Math.sin(this.walkPhase) * 0.8 : 0;
    const melee = this.def.attack.kind === "melee" ? this.def.attack : null;
    const pose = sampleMeleePose(
      this.leap || this.netAir ? null : this.meleeCue,
      melee ? melee.style : "cleave",
    );
    this.animateBody(dt, moving, stride, pose);
    this.animateArms(moving, stride, pose);
    this.animateEvasion();
    this.animateOverlays(dt);
  }

  private animateBody(dt: number, moving: boolean, stride: number, pose: MeleePose): void {
    const { model } = this;
    const [leftLeg, rightLeg] = model.legs;
    const bob = moving
      ? Math.abs(Math.cos(this.walkPhase)) * 0.05
      : Math.sin(this.game.elapsed * 2.3 + this.id) * 0.012;
    const { squash } = this;
    const melee = this.def.attack.kind === "melee";
    const step = melee ? pose.advance : 0;
    leftLeg.rotation.x = damp(leftLeg.rotation.x, stride - step * 1.35, 20, dt);
    rightLeg.rotation.x = damp(rightLeg.rotation.x, -stride + step * 0.7, 20, dt);
    const difference = this.meleeCue ? this.meleeCue.angle - this.facing : 0;
    const committedYaw = Math.atan2(Math.sin(difference), Math.cos(difference)) * pose.commitment;
    model.body.position.y = bob - Math.max(0, squash) * 0.07;
    model.body.position.x = Math.sin(committedYaw) * step;
    model.body.position.z = Math.cos(committedYaw) * step;
    model.body.scale.set(1 + squash * 0.09, 1 - squash * 0.11, 1 + squash * 0.09);
    if (!this.leap) {
      model.body.rotation.x = (moving ? 0.13 : 0) + (melee ? pose.bodyPitch : -this.recoil * 0.2);
    }
    model.body.rotation.y = melee ? pose.bodyYaw : 0;
    model.body.rotation.z = melee ? -pose.bodyYaw * 0.13 : 0;
    model.head.rotation.z = moving ? Math.sin(this.walkPhase) * 0.05 : 0;
    model.head.rotation.y = melee ? -pose.bodyYaw * 0.65 : 0;
    if (!melee) {
      model.weapon.rotation.copy(this.weaponRestRotation);
    }
  }

  private animateEvasion(): void {
    const { rig } = this.model;
    rig.position.set(0, 0, 0);
    rig.quaternion.identity();
    rig.scale.setScalar(1);
    if (!this.evasion) {
      return;
    }
    const progress = clamp(this.evasion.elapsed / EVADE.duration, 0, 1);
    const lift = Math.sin(progress * Math.PI);
    const yaw = this.evasion.angle - this.facing;
    let pitch = 0;
    const style = evadeStyle(this.def.id);
    switch (style) {
      case "roll": {
        const rotation = progress * Math.PI * 2;
        pitch = rotation;
        rig.position.y = 0.8 * (1 - Math.cos(rotation)) + lift * 0.26;
        const shift = -0.8 * Math.sin(rotation);
        rig.position.x = shift * Math.sin(yaw);
        rig.position.z = shift * Math.cos(yaw);
        // Long weapons fold across the body around their fixed hand grip.
        if (this.def.id === "ace" || this.def.id === "rowan") {
          this.evasionRotation.set(
            0,
            this.def.id === "ace" ? -Math.PI / 2 : 0,
            this.def.id === "rowan" ? -Math.PI / 2 : 0,
          );
          this.evasionWeaponQuaternion.setFromEuler(this.evasionRotation);
          this.model.weapon.quaternion.slerp(this.evasionWeaponQuaternion, lift);
        }
        break;
      }
      case "dash": {
        pitch = lift * 0.6;
        rig.position.y = lift * 0.18;
        rig.scale.y = 1 - lift * 0.12;
        break;
      }
      case "blink": {
        rig.scale.setScalar(1 - lift * 0.78);
        pitch = -lift * 0.3;
        rig.position.y = lift * 0.4;
        break;
      }
      default: {
        const unreachable: never = style;
        throw new Error(`Unknown evade style: ${unreachable}`);
      }
    }
    this.evasionRotation.set(pitch, yaw, 0);
    rig.quaternion.setFromEuler(this.evasionRotation);
  }

  private animateArms(moving: boolean, stride: number, attack: MeleePose): void {
    const { arms, pose, weapon } = this.model;
    const [leftArm, rightArm] = arms;
    const [leftBase, rightBase] = pose.armBase;
    if (this.def.attack.kind === "melee") {
      const sway = moving && !this.meleeCue ? stride * 0.14 : 0;
      if (this.def.attack.style === "flurry") {
        leftArm.rotation.set(
          leftBase[0] + attack.armPitch - sway,
          -attack.armYaw,
          leftBase[1] - attack.armRoll,
        );
      } else {
        leftArm.rotation.set(leftBase[0] - attack.guard * 0.35 - sway, 0, leftBase[1]);
      }
      rightArm.rotation.set(
        rightBase[0] + attack.armPitch + sway,
        attack.armYaw,
        rightBase[1] + attack.armRoll,
      );
      // The grip stays inside the hand; the shoulder moves it through the swing.
      const difference = this.meleeCue ? this.meleeCue.angle - this.facing : 0;
      const committedYaw =
        Math.atan2(Math.sin(difference), Math.cos(difference)) * attack.commitment;
      this.meleeWeaponRotation.set(
        attack.weaponPitch,
        attack.weaponYaw + committedYaw,
        attack.weaponRoll,
      );
      weapon.quaternion.copy(rightArm.quaternion).invert();
      if (!this.leap && !this.netAir) {
        this.meleeWeaponQuaternion.copy(this.model.body.quaternion).invert();
        weapon.quaternion.multiply(this.meleeWeaponQuaternion);
      }
      this.meleeWeaponQuaternion.setFromEuler(this.meleeWeaponRotation);
      weapon.quaternion.multiply(this.meleeWeaponQuaternion);
      const { offhand } = this.model;
      if (offhand) {
        this.meleeWeaponRotation.set(
          attack.weaponPitch + (Math.PI - 2 * attack.weaponPitch) * attack.commitment,
          -attack.weaponYaw + committedYaw,
          -attack.weaponRoll,
        );
        offhand.quaternion.copy(leftArm.quaternion).invert();
        if (!this.leap && !this.netAir) {
          this.meleeWeaponQuaternion.copy(this.model.body.quaternion).invert();
          offhand.quaternion.multiply(this.meleeWeaponQuaternion);
        }
        this.meleeWeaponQuaternion.setFromEuler(this.meleeWeaponRotation);
        offhand.quaternion.multiply(this.meleeWeaponQuaternion);
      }
      return;
    }
    const ranged = sampleRangedPose(
      this.evasion || this.leap || this.netAir ? null : this.rangedCue,
      this.def.id,
    );
    const sway = moving && !this.rangedCue && pose.swingLeft ? -stride * 0.7 : 0;
    leftArm.rotation.set(
      leftBase[0] + ranged.leftPitch + sway,
      ranged.leftYaw,
      leftBase[1] + ranged.leftRoll,
    );
    rightArm.rotation.set(
      rightBase[0] + ranged.rightPitch,
      ranged.rightYaw,
      rightBase[1] + ranged.rightRoll,
    );
    const { body, head, loadedProjectile } = this.model;
    body.position.z += ranged.advance;
    body.position.y -= ranged.bodyDrop;
    body.rotation.x += ranged.bodyPitch;
    body.rotation.y += ranged.bodyYaw;
    head.rotation.x = -ranged.bodyPitch * 0.4;
    head.rotation.y = -ranged.bodyYaw * 0.5;
    // Preserve the authored grip offset as its supporting shoulder moves.
    this.rangedGrip.set(0, -0.28, 0).applyEuler(rightArm.rotation).sub(this.rightHandRest);
    weapon.position.copy(this.weaponRestPosition).add(this.rangedGrip);
    weapon.rotation.set(
      this.weaponRestRotation.x + ranged.weaponPitch,
      this.weaponRestRotation.y + ranged.weaponYaw,
      this.weaponRestRotation.z + ranged.weaponRoll,
    );
    weapon.visible = ranged.weaponVisible;
    if (loadedProjectile) {
      loadedProjectile.visible = ranged.loaded;
    }
  }

  // Hit flash on every body material, ground markers pinned to the floor
  // while leaping, and the super ring pulsing when a super is ready.
  private animateOverlays(dt: number): void {
    const { flash } = this;
    for (const mat of this.model.flashMats) {
      mat.emissive.setRGB(flash, flash * 0.92, flash * 0.85);
    }
    const lift = this.root.position.y - this.game.world.heightAt(this.x, this.z);
    this.ring.position.y = 0.04 - lift;
    this.superRing.position.y = 0.045 - lift;
    if (this.disc) {
      this.disc.position.y = 0.035 - lift;
    }
    const ringMat = this.superRing.material;
    const target = this.superReady ? 0.55 + Math.sin(this.game.elapsed * 6) * 0.25 : 0;
    ringMat.opacity = damp(ringMat.opacity, target, 8, dt);
    this.superRing.visible = ringMat.opacity > 0.01;
    this.superRing.rotation.y = -this.facing;
    this.conformMarker(this.ring);
    if (this.superRing.visible) {
      this.conformMarker(this.superRing);
    }
    if (this.disc) {
      this.conformMarker(this.disc);
    }
  }

  private conformMarker(marker: GroundMarker): void {
    const positions = marker.geometry.getAttribute("position");
    const angle = this.facing + marker.rotation.y;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const ground = this.game.world.heightAt(this.x, this.z);
    for (let i = 0; i < positions.count; i += 1) {
      const x = positions.getX(i);
      const z = positions.getZ(i);
      positions.setY(
        i,
        this.game.world.heightAt(this.x + x * cos + z * sin, this.z - x * sin + z * cos) - ground,
      );
    }
    positions.needsUpdate = true;
  }

  dispose(): void {
    this.game.scene.remove(this.root);
    for (const mat of this.model.allMats) {
      mat.dispose();
    }
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.superRing.geometry.dispose();
    this.superRing.material.dispose();
    if (this.disc) {
      this.disc.geometry.dispose();
      this.disc.material.dispose();
    }
  }
}
