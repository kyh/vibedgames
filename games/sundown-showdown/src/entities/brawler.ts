import * as THREE from "three";
import type {
  AttackDef,
  BrawlerDef,
  LeapAttack,
  LobAttack,
  SpreadAttack,
  VolleyAttack,
} from "../config";
import { BRAWLER_RADIUS, TUNING } from "../config";
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
  aimAngle: number;
  aimHold: number;
  fireCooldown: number;
  burst: BurstState | null;
  leap: LeapState | null;
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
  readonly punch: [number, number];
  walkPhase: number;
  squash: number;
  spawnT: number;
  /** Seconds this body holds still after dealing or taking a telling hit. */
  freezeT = 0;
  readonly lightColor: THREE.Color;
  readonly superColor: THREE.Color;

  // Where the weapon sits before recoil pushes it back along its own axis.
  private readonly weaponRestZ: number;

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
    this.root.position.set(options.x, 0, options.z);
    game.scene.add(this.root);
    this.weaponRestZ = this.model.weapon.position.z;

    const ringColor = this.isPlayer ? PLAYER_RING_COLOR : BOT_RING_COLOR;
    this.ring = new THREE.Mesh(
      TEAM_RING_GEOMETRY,
      new THREE.MeshBasicMaterial({
        color: ringColor,
        depthWrite: false,
        opacity: 0.92,
        transparent: true,
      }),
    );
    this.ring.position.y = 0.04;
    this.ring.renderOrder = 2;
    this.ring.userData["noAO"] = true;
    this.root.add(this.ring);

    this.disc = null;
    if (this.isPlayer) {
      const disc = new THREE.Mesh(
        PLAYER_DISC_GEOMETRY,
        new THREE.MeshBasicMaterial({
          color: ringColor,
          depthWrite: false,
          opacity: 0.16,
          transparent: true,
        }),
      );
      disc.position.y = 0.035;
      disc.renderOrder = 2;
      disc.userData["noAO"] = true;
      this.root.add(disc);
      this.disc = disc;
    }

    this.superRing = new THREE.Mesh(
      SUPER_RING_GEOMETRY,
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
    this.superRing.userData["noAO"] = true;
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
    this.aimAngle = this.facing;
    this.aimHold = 0;
    this.fireCooldown = 0;
    this.burst = null;
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
    this.punch = [0, 0];
    this.walkPhase = Math.random() * 6;
    this.squash = 0;
    this.spawnT = 0;
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

  /** A person plays this brawler (locally or from another client), not a bot brain. */
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
      muzzle.y,
      this.z - muzzle.x * sin + muzzle.z * cos,
    );
    return out;
  }

  canAct(): boolean {
    return this.alive && !this.leap && this.game.state !== "countdown";
  }

  attack(dx: number, dz: number, x: number, z: number): boolean {
    if (!this.canAct() || this.ammo < 1 || this.fireCooldown > 0 || this.burst) {
      return false;
    }
    this.ammo -= 1;
    this.startVolley(this.def.attack, dx, dz, x, z, false);
    return true;
  }

  useSuper(dx: number, dz: number, x: number, z: number): boolean {
    if (!this.canAct() || !this.superReady || this.burst) {
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
    const len = Math.hypot(dx, dz) || 1;
    const dirX = dx / len;
    const dirZ = dz / len;
    this.aimAngle = Math.atan2(dirX, dirZ);
    this.aimHold = 0.55;
    this.lastCombat = this.game.elapsed;
    this.revealT = Math.max(this.revealT, 0.9);
    this.fireCooldown = 0.22;
    if (a.kind === "spread") {
      this.fireSpread(a, dirX, dirZ, isSuper);
    } else if (a.kind === "burst" || a.kind === "melee") {
      this.burst = { a, dirX, dirZ, isSuper, left: a.count, timer: 0 };
      this.fireCooldown = a.count * a.interval + 0.12;
    } else if (a.kind === "lob") {
      this.throwLob(a, dirX, dirZ, targetX, targetZ, isSuper);
    } else if (a.kind === "leap") {
      this.startLeap(a, dirX, dirZ, targetX, targetZ);
    }
  }

  private fireSpread(a: SpreadAttack, dirX: number, dirZ: number, isSuper: boolean): void {
    this.recoil = 1;
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    for (let i = 0; i < a.pellets; i += 1) {
      const fan = a.pellets === 1 ? 0 : i / (a.pellets - 1) - 0.5;
      const angle = this.aimAngle + fan * a.spread + (Math.random() - 0.5) * 0.04;
      this.game.combat.spawnBullet(
        this,
        muzzle.x,
        muzzle.z,
        Math.sin(angle),
        Math.cos(angle),
        a,
        isSuper,
        a.speed * (0.94 + Math.random() * 0.12),
      );
    }
    this.game.effects.muzzle(
      muzzle.x,
      muzzle.y,
      muzzle.z,
      dirX,
      dirZ,
      this.bulletColor(isSuper),
      isSuper ? 1.6 : 1.1,
    );
    this.game.audio.play(isSuper ? "blastBig" : "blast", this.x, this.z);
    if (isSuper) {
      this.knock.set(-dirX * 3, -dirZ * 3);
    }
  }

  private throwLob(
    a: LobAttack,
    dirX: number,
    dirZ: number,
    targetX: number,
    targetZ: number,
    isSuper: boolean,
  ): void {
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
    this.game.audio.play("lob", this.x, this.z);
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
    this.muzzleIndex += 1;
    this.recoil = 1;
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    const angle = Math.atan2(burst.dirX, burst.dirZ) + (Math.random() - 0.5) * 2 * a.jitter;
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);
    this.game.combat.spawnBullet(this, muzzle.x, muzzle.z, dirX, dirZ, a, burst.isSuper, a.speed);
    if (a.kind === "melee") {
      this.punch[this.muzzleIndex % 2] = 1;
      this.game.audio.play("punch", this.x, this.z);
    } else {
      this.game.effects.muzzle(
        muzzle.x,
        muzzle.y,
        muzzle.z,
        dirX,
        dirZ,
        this.bulletColor(burst.isSuper),
        burst.isSuper ? 1.1 : 0.75,
      );
      this.game.audio.play(burst.isSuper ? "shotBig" : "shot", this.x, this.z);
    }
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
    if (!this.alive || this.airborne || this.spawnT > 0) {
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
    this.leap = null;
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
      this.freezeT -= dt;
      return;
    }
    this.tickTimers(dt);
    this.tickReload(dt);
    this.tickBurst(dt);
    if (this.leap) {
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
    this.spawnT = Math.max(0, this.spawnT - dt);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.aimHold = Math.max(0, this.aimHold - dt);
    this.revealT = Math.max(0, this.revealT - dt);
    this.flash = Math.max(0, this.flash - dt * 7);
    this.recoil = damp(this.recoil, 0, 14, dt);
    this.punch[0] = damp(this.punch[0], 0, 16, dt);
    this.punch[1] = damp(this.punch[1], 0, 16, dt);
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

  // Arc between launch and landing tiles with a full forward flip, then slam.
  private tickLeap(dt: number, leap: LeapState): void {
    const pos = this.root.position;
    const { body } = this.model;
    leap.t += dt;
    const progress = clamp(leap.t / leap.a.flight, 0, 1);
    pos.x = lerp(leap.sx, leap.tx, progress);
    pos.z = lerp(leap.sz, leap.tz, progress);
    pos.y = Math.sin(progress * Math.PI) * 3.4;
    body.rotation.x = progress * Math.PI * 2;
    this.aimAngle = Math.atan2(leap.tx - leap.sx, leap.tz - leap.sz);
    this.aimHold = 0.3;
    if (progress >= 1) {
      pos.y = 0;
      body.rotation.x = 0;
      this.leap = null;
      this.squash = 1.4;
      this.game.world.resolveCircle(pos, BRAWLER_RADIUS);
      this.game.combat.explode(pos.x, pos.z, leap.a, this, true, true);
    }
  }

  private tickMovement(dt: number): void {
    const pos = this.root.position;
    let { speed } = this.def;
    // Firing a ranged burst slows the shooter; melee swings keep full pace.
    if (this.burst && this.burst.a.kind !== "melee") {
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
  }

  // Face the aim while a shot is held, otherwise the direction of travel.
  private updateFacing(dt: number, moving: boolean): void {
    let target = this.facing;
    if (this.aimHold > 0) {
      target = this.aimAngle;
    } else if (moving) {
      target = Math.atan2(this.vel.x, this.vel.y);
    }
    this.facing = dampAngle(this.facing, target, this.aimHold > 0 ? 26 : 13, dt);
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
    this.animateBody(dt, moving, stride);
    this.animateArms(moving, stride);
    this.animateOverlays(dt);
  }

  private animateBody(dt: number, moving: boolean, stride: number): void {
    const { model } = this;
    const [leftLeg, rightLeg] = model.legs;
    leftLeg.rotation.x = damp(leftLeg.rotation.x, stride, 20, dt);
    rightLeg.rotation.x = damp(rightLeg.rotation.x, -stride, 20, dt);
    const bob = moving
      ? Math.abs(Math.cos(this.walkPhase)) * 0.05
      : Math.sin(this.game.elapsed * 2.3 + this.id) * 0.012;
    const { squash } = this;
    model.body.position.y = bob - Math.max(0, squash) * 0.07;
    model.body.scale.set(1 + squash * 0.09, 1 - squash * 0.11, 1 + squash * 0.09);
    if (!this.leap) {
      model.body.rotation.x = (moving ? 0.13 : 0) - this.recoil * 0.2;
    }
    model.head.rotation.z = moving ? Math.sin(this.walkPhase) * 0.05 : 0;
    model.weapon.position.z = this.weaponRestZ - this.recoil * 0.17;
  }

  private animateArms(moving: boolean, stride: number): void {
    const { arms, pose } = this.model;
    const [leftArm, rightArm] = arms;
    const [leftBase, rightBase] = pose.armBase;
    if (pose.punch) {
      const [leftPunch, rightPunch] = this.punch;
      leftArm.rotation.x =
        leftBase[0] - leftPunch * 0.75 + (moving ? Math.sin(this.walkPhase) * 0.25 : 0);
      leftArm.position.z = leftPunch * 0.42;
      rightArm.rotation.x =
        rightBase[0] - rightPunch * 0.75 + (moving ? Math.sin(this.walkPhase + Math.PI) * 0.25 : 0);
      rightArm.position.z = rightPunch * 0.42;
    } else if (pose.swingLeft) {
      leftArm.rotation.x = leftBase[0] + (moving ? -stride * 0.7 : 0);
      rightArm.rotation.x = rightBase[0] - this.recoil * 1.1;
    }
  }

  // Hit flash on every body material, ground markers pinned to the floor
  // while leaping, and the super ring pulsing when a super is ready.
  private animateOverlays(dt: number): void {
    const { flash } = this;
    for (const mat of this.model.flashMats) {
      mat.emissive.setRGB(flash, flash * 0.92, flash * 0.85);
    }
    const lift = this.root.position.y;
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
  }

  dispose(): void {
    this.game.scene.remove(this.root);
    for (const mat of this.model.allMats) {
      mat.dispose();
    }
    this.ring.material.dispose();
    this.superRing.material.dispose();
    if (this.disc) {
      this.disc.material.dispose();
    }
  }
}
