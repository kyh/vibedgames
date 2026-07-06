import { TILE } from "../config";
import type { EnemyKind } from "../data/enemies";
import type { Grid } from "../sys/grid";
import type { AttackBox, Rect } from "./player-body";

// Pure enemy sim: gravity + grid collision + a per-behavior state machine.
// Deterministic; the scene reads its intents (attack box / projectile /
// explosion) and applies damage. No Phaser.

const GRAVITY = 1400;
const FALL_CAP = 430;
const EPS = 0.0001;

export type EnemyState = "spawn" | "chase" | "windup" | "attack" | "charge" | "recover" | "hurt" | "dead";
export type Projectile = { x: number; y: number; vx: number; vy: number };
export type Blast = { x: number; y: number; r: number; dmg: number };

const approach = (c: number, t: number, d: number): number => (c < t ? Math.min(c + d, t) : Math.max(c - d, t));

export class EnemyBody {
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  facing: 1 | -1 = -1;
  grounded = false;
  hp: number;
  state: EnemyState = "spawn";
  stateT = 0;
  dead = false;
  hitFlash = 0;
  iframes = 0;

  private attackCd = 0;
  private chargeDir: 1 | -1 = 1;
  private hitWall = false;
  private exploded = false;
  pendingProjectile: Projectile | null = null;
  pendingBlast: Blast | null = null;

  constructor(
    readonly kind: EnemyKind,
    private grid: Grid,
    x: number,
    y: number,
  ) {
    this.x = x;
    this.y = y;
    this.hp = kind.hp;
  }

  hurtBox(): Rect {
    return { left: this.x - this.kind.hw, top: this.y - this.kind.h, right: this.x + this.kind.hw, bottom: this.y };
  }

  // Contact damage to the player when overlapping (higher mid-charge).
  contactDamage(): number {
    if (this.dead) return 0;
    if (this.state === "charge" && this.kind.attackDmg) return this.kind.attackDmg;
    return this.kind.contactDmg;
  }

  // Live melee hitbox this frame (warrior swing), else null.
  attackBox(): AttackBox | null {
    if (this.state !== "attack" || !this.kind.attackRange) return null;
    if (this.stateT > (this.kind.active ?? 0.12)) return null;
    const reach = this.kind.attackRange;
    const front = this.facing > 0 ? this.x : this.x - reach;
    return {
      left: front,
      top: this.y - this.kind.h,
      right: front + reach,
      bottom: this.y,
      dmg: this.kind.attackDmg ?? 1,
      kb: this.kind.attackKb ?? 120,
    };
  }

  takeHit(dmg: number, kb: number, dir: number): boolean {
    if (this.iframes > 0 || this.dead) return false;
    this.hp -= dmg;
    this.vx = Math.sign(dir || -this.facing) * kb;
    this.vy = -70;
    this.grounded = false;
    this.hitFlash = 0.09;
    this.iframes = 0.08;
    if (this.hp <= 0) this.die();
    else this.setState("hurt");
    return true;
  }

  private die() {
    if (this.kind.behavior === "bomber" && !this.exploded) this.explode();
    this.dead = true;
    this.setState("dead");
    this.vx *= 0.3;
  }

  private explode() {
    this.exploded = true;
    this.pendingBlast = { x: this.x, y: this.y - this.kind.h / 2, r: this.kind.blastR ?? 32, dmg: this.kind.blastDmg ?? 2 };
  }

  private setState(s: EnemyState) {
    this.state = s;
    this.stateT = 0;
  }

  step(dt: number, tx: number, ty: number) {
    this.stateT += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.iframes = Math.max(0, this.iframes - dt);
    this.attackCd = Math.max(0, this.attackCd - dt);

    if (this.dead) {
      this.vx = approach(this.vx, 0, 300 * dt);
      this.applyPhysics(dt);
      return;
    }
    if (this.state === "spawn") {
      if (this.stateT >= 0.4) this.setState("chase");
      this.applyPhysics(dt);
      return;
    }
    if (this.state === "hurt") {
      this.vx = approach(this.vx, 0, 500 * dt);
      if (this.stateT >= 0.2) this.setState("chase");
      this.applyPhysics(dt);
      return;
    }

    switch (this.kind.behavior) {
      case "melee":
        this.melee(dt, tx);
        break;
      case "charger":
        this.charger(dt, tx, ty);
        break;
      case "archer":
        this.archer(dt, tx, ty);
        break;
      case "bomber":
        this.bomber(dt, tx);
        break;
    }
    this.applyPhysics(dt);
  }

  private faceToward(dx: number) {
    if (Math.abs(dx) > 2) this.facing = dx > 0 ? 1 : -1;
  }

  private groundAt(x: number): boolean {
    return this.grid.solidInRect(x - 1, this.y + 1, x + 1, this.y + 3) || this.grid.oneWayInRect(x - 1, this.y + 1, x + 1, this.y + 3);
  }

  private walk(dir: number, speed: number, dt: number) {
    if (this.kind.stopAtLedge && this.grounded && !this.groundAt(this.x + dir * (this.kind.hw + 3))) {
      this.vx = approach(this.vx, 0, 600 * dt);
      return;
    }
    this.vx = approach(this.vx, dir * speed, 700 * dt);
  }

  private melee(dt: number, tx: number) {
    const dx = tx - this.x;
    const dist = Math.abs(dx);
    const k = this.kind;
    switch (this.state) {
      case "attack":
        if (this.stateT < (k.active ?? 0.12)) this.vx = this.facing * 45;
        else this.setState("recover");
        break;
      case "recover":
        this.vx = approach(this.vx, 0, 500 * dt);
        if (this.stateT >= (k.recover ?? 0.3)) {
          this.attackCd = k.cooldown ?? 0.7;
          this.setState("chase");
        }
        break;
      case "windup":
        this.faceToward(dx);
        this.vx = approach(this.vx, 0, 600 * dt);
        if (this.stateT >= (k.windup ?? 0.3)) this.setState("attack");
        break;
      default:
        this.faceToward(dx);
        if (dist <= (k.attackRange ?? 22) && this.attackCd <= 0) this.setState("windup");
        else this.walk(Math.sign(dx), k.speed, dt);
    }
  }

  private charger(dt: number, tx: number, ty: number) {
    const dx = tx - this.x;
    const dist = Math.abs(dx);
    const k = this.kind;
    switch (this.state) {
      case "windup":
        this.vx = approach(this.vx, 0, 700 * dt);
        if (this.stateT >= (k.windup ?? 0.42)) {
          this.chargeDir = this.facing;
          this.setState("charge");
        }
        break;
      case "charge":
        this.vx = this.chargeDir * (k.chargeSpeed ?? 235);
        if (this.stateT >= (k.chargeTime ?? 0.45) || this.hitWall) this.setState("recover");
        break;
      case "recover":
        this.vx = approach(this.vx, 0, 500 * dt);
        if (this.stateT >= (k.recover ?? 0.5)) {
          this.attackCd = k.cooldown ?? 1.1;
          this.setState("chase");
        }
        break;
      default:
        this.faceToward(dx);
        if (dist <= (k.attackRange ?? 78) && Math.abs(ty - this.y) < 26 && this.attackCd <= 0) this.setState("windup");
        else this.walk(Math.sign(dx), k.speed, dt);
    }
  }

  private archer(dt: number, tx: number, ty: number) {
    const dx = tx - this.x;
    const dist = Math.abs(dx);
    const k = this.kind;
    switch (this.state) {
      case "windup":
        this.vx = approach(this.vx, 0, 600 * dt);
        if (this.stateT >= (k.windup ?? 0.46)) {
          const dirx = Math.sign(dx) || this.facing;
          this.pendingProjectile = { x: this.x + dirx * 6, y: this.y - 14, vx: dirx * (k.projSpeed ?? 175), vy: -20 };
          this.attackCd = k.cooldown ?? 1.3;
          this.setState("recover");
        }
        break;
      case "recover":
        this.vx = approach(this.vx, 0, 500 * dt);
        if (this.stateT >= 0.25) this.setState("chase");
        break;
      default:
        this.faceToward(dx);
        if (dist < 58) this.walk(-Math.sign(dx), k.speed, dt); // retreat
        else if (dist <= (k.shootRange ?? 155) && Math.abs(ty - this.y) < 44 && this.attackCd <= 0) this.setState("windup");
        else if (dist > (k.shootRange ?? 155)) this.walk(Math.sign(dx), k.speed, dt);
        else this.vx = approach(this.vx, 0, 500 * dt);
    }
  }

  private bomber(dt: number, tx: number) {
    const dx = tx - this.x;
    const dist = Math.abs(dx);
    const k = this.kind;
    if (this.state === "windup") {
      // fuse: keep drifting toward target, then blow.
      this.vx = approach(this.vx, Math.sign(dx) * k.speed * 0.4, 500 * dt);
      if (this.stateT >= (k.fuse ?? 0.55)) {
        this.explode();
        this.die();
      }
      return;
    }
    this.faceToward(dx);
    if (dist <= (k.blastR ?? 34) * 1.1) this.setState("windup");
    else this.walk(Math.sign(dx), k.speed, dt);
  }

  private applyPhysics(dt: number) {
    if (!this.grounded) this.vy = Math.min(this.vy + GRAVITY * dt, FALL_CAP);
    this.moveX(this.vx * dt);
    this.moveY(this.vy * dt);
    this.updateGround();
  }

  private moveX(dx: number) {
    this.x += dx;
    const hw = this.kind.hw;
    const t = this.y - this.kind.h + 2;
    const b = this.y - 2;
    this.hitWall = false;
    if (this.grid.solidInRect(this.x - hw, t, this.x + hw, b)) {
      if (dx > 0) this.x = Math.floor((this.x + hw) / TILE) * TILE - hw - EPS;
      else if (dx < 0) this.x = (Math.floor((this.x - hw) / TILE) + 1) * TILE + hw + EPS;
      this.vx = 0;
      this.hitWall = true;
    }
  }

  private moveY(dy: number) {
    const hw = this.kind.hw;
    const l = this.x - hw + 2;
    const r = this.x + hw - 2;
    this.y += dy;
    if (dy > 0) {
      if (this.grid.solidInRect(l, this.y - 3, r, this.y) || this.grid.oneWayInRect(l, this.y - 1, r, this.y)) {
        this.y = Math.floor((this.y - EPS) / TILE) * TILE;
        this.vy = 0;
      }
    } else if (dy < 0) {
      const headTop = this.y - this.kind.h;
      if (this.grid.solidInRect(l, headTop, r, headTop + 3)) {
        this.y = (Math.floor(headTop / TILE) + 1) * TILE + this.kind.h + EPS;
        this.vy = 0;
      }
    }
  }

  private updateGround() {
    const l = this.x - this.kind.hw + 2;
    const r = this.x + this.kind.hw - 2;
    this.grounded = this.grid.solidInRect(l, this.y, r, this.y + 2) || this.grid.oneWayInRect(l, this.y, r, this.y + 2);
    if (this.grounded && this.vy > 0) this.vy = 0;
  }
}
