import { TILE } from "../config";
import type { EnemyName } from "../data/animations";
import { type BossKind, bossKind } from "../data/bosses";
import type { Grid } from "../sys/grid";
import { rand } from "../sys/rng";
import type { AttackBox, Rect } from "./player-body";

// Biome boss — pure sim. Telegraphed attack FSM with two phases, parameterised by
// a per-biome BossKind (HP, rhythm, wave fan, charge, summons). The scene reads
// its intents (waves / blast / adds) and renders the HP bar.
const GRAVITY = 1400;
const FALL_CAP = 460;
const EPS = 0.0001;
const HW = 18;
const H = 42;
const CHARGE_SPEED = 300;

export type BossState =
  | "intro"
  | "idle"
  | "wave"
  | "jump"
  | "slam"
  | "charge"
  | "punch"
  | "hurt"
  | "phase"
  | "dead";
export type Wave = { x: number; y: number; vx: number; dmg: number };
export type Blast = { x: number; y: number; r: number; dmg: number };
export type Add = { x: number; y: number; name: EnemyName };

const approach = (c: number, t: number, d: number): number =>
  c < t ? Math.min(c + d, t) : Math.max(c - d, t);

export class BossBody {
  x: number;
  y: number;
  prevX = 0; // sim position one step ago — for render interpolation
  prevY = 0;
  vx = 0;
  vy = 0;
  facing: 1 | -1 = -1;
  grounded = false;
  hp: number;
  readonly maxHp: number;
  state: BossState = "intro";
  stateT = 0;
  phase = 1;
  dead = false;
  hitFlash = 0;
  iframes = 0;

  private attackCd = 1;
  pendingWaves: Wave[] = [];
  pendingBlast: Blast | null = null;
  pendingAdds: Add[] | null = null;
  readonly kind: BossKind;

  constructor(
    private grid: Grid,
    x: number,
    y: number,
    biome: number,
  ) {
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.kind = bossKind(biome);
    this.maxHp = Math.round((44 + biome * 10) * this.kind.hpMul);
    this.hp = this.maxHp;
  }

  get hpFrac(): number {
    return Math.max(0, this.hp / this.maxHp);
  }
  get telegraphing(): boolean {
    return (
      (this.state === "wave" && this.stateT < 0.5) ||
      (this.state === "jump" && this.stateT < 0.34) ||
      (this.state === "charge" && this.stateT < 0.4) ||
      (this.state === "punch" && this.stateT < 0.26)
    );
  }

  hurtBox(): Rect {
    return { left: this.x - HW, top: this.y - H, right: this.x + HW, bottom: this.y };
  }

  // Melee danger (punch active window, slam landing) — else null.
  attackBox(): AttackBox | null {
    if (this.state === "punch" && this.stateT >= 0.26 && this.stateT < 0.4) {
      const reach = 30;
      const front = this.facing > 0 ? this.x : this.x - reach;
      return {
        left: front,
        top: this.y - H,
        right: front + reach,
        bottom: this.y,
        dmg: 1,
        kb: 200,
      };
    }
    // The whole body is dangerous mid-lunge — a heavier, knock-you-back hit.
    if (this.state === "charge" && this.stateT >= 0.4 && this.stateT < 0.82) {
      return {
        left: this.x - HW - 6,
        top: this.y - H,
        right: this.x + HW + 6,
        bottom: this.y,
        dmg: 1,
        kb: 260,
      };
    }
    return null;
  }

  takeHit(dmg: number, _kb: number, _dir: number): boolean {
    if (this.iframes > 0 || this.dead) return false;
    this.hp -= dmg;
    this.hitFlash = 0.08;
    this.iframes = 0.03;
    if (this.hp <= 0) {
      this.dead = true;
      this.setState("dead");
      return true;
    }
    if (this.phase === 1 && this.hp <= this.maxHp / 2) {
      this.phase = 2;
      this.setState("phase");
      this.iframes = 0.6;
    }
    return true;
  }

  private setState(s: BossState) {
    this.state = s;
    this.stateT = 0;
  }

  step(dt: number, tx: number, ty: number) {
    this.prevX = this.x;
    this.prevY = this.y;
    this.stateT += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.iframes = Math.max(0, this.iframes - dt);
    this.attackCd = Math.max(0, this.attackCd - dt);
    const dx = tx - this.x;
    const dist = Math.abs(dx);
    if (Math.abs(dx) > 4 && (this.state === "idle" || this.state === "intro"))
      this.facing = dx > 0 ? 1 : -1;

    switch (this.state) {
      case "dead":
        this.vx = approach(this.vx, 0, 400 * dt);
        break;
      case "intro":
        this.vx = 0;
        if (this.stateT >= 1.0) this.setState("idle");
        break;
      case "phase":
        this.vx = approach(this.vx, 0, 500 * dt);
        if (this.stateT >= 0.8) {
          const adds = this.kind.adds;
          this.pendingAdds = adds.map((name, i) => ({
            x: this.x + (i - (adds.length - 1) / 2) * 58,
            y: this.y,
            name,
          }));
          this.setState("idle");
        }
        break;
      case "idle":
        this.idle(dt, dx, dist, ty);
        break;
      case "wave":
        this.vx = approach(this.vx, 0, 500 * dt);
        if (this.stateT >= 0.5 && this.pendingWaves.length === 0 && this.stateT < 0.56) {
          // Fan: `kind.fan` waves at staggered heights and speeds, spreading as
          // they travel — a single wave for the Salamander, a spread for the rest.
          const n = this.kind.fan;
          for (let i = 0; i < n; i++) {
            const s = n === 1 ? 0 : i - (n - 1) / 2;
            this.pendingWaves.push({
              x: this.x + this.facing * 20,
              y: this.y - 8 - Math.abs(s) * 6,
              vx: this.facing * (this.kind.waveSpeed + s * 22),
              dmg: 1,
            });
          }
        }
        if (this.stateT >= 0.85) this.endAttack();
        break;
      case "jump":
        this.vx = approach(this.vx, 0, 400 * dt);
        if (this.stateT >= 0.34) {
          this.vy = -330;
          this.vx = Math.sign(dx || this.facing) * 140;
          this.grounded = false;
          this.setState("slam");
        }
        break;
      case "slam":
        if (this.grounded && this.stateT > 0.05) {
          this.pendingBlast = { x: this.x, y: this.y - 6, r: this.kind.slamR, dmg: 1 };
          this.endAttack();
        }
        break;
      case "charge":
        // Wind up in place, lunge flat across the arena, then skid to a stop.
        if (this.stateT < 0.4) this.vx = approach(this.vx, 0, 600 * dt);
        else if (this.stateT < 0.82) this.vx = this.facing * CHARGE_SPEED;
        else {
          this.vx = approach(this.vx, 0, 900 * dt);
          if (this.stateT >= 0.98) this.endAttack();
        }
        break;
      case "punch":
        if (this.stateT >= 0.26 && this.stateT < 0.4) this.vx = this.facing * 90;
        else this.vx = approach(this.vx, 0, 600 * dt);
        if (this.stateT >= 0.6) this.endAttack();
        break;
      case "hurt":
        this.vx = approach(this.vx, 0, 500 * dt);
        if (this.stateT >= 0.2) this.setState("idle");
        break;
    }

    this.applyPhysics(dt);
  }

  private idle(dt: number, dx: number, dist: number, ty: number) {
    if (this.attackCd > 0) {
      // Ranged bosses hold a mid-range pocket (kite in when far, back off when
      // crowded); bruisers just close the gap.
      const want = this.kind.ranged ? 130 : 60;
      if (dist > want + 20) this.vx = approach(this.vx, Math.sign(dx) * 40, 300 * dt);
      else if (this.kind.ranged && dist < want - 40)
        this.vx = approach(this.vx, -Math.sign(dx) * 46, 300 * dt);
      else this.vx = approach(this.vx, 0, 300 * dt);
      return;
    }
    this.vx = 0;
    const r = rand();
    if (this.kind.charges && dist > 70 && dist < 240 && r < 0.4) this.setState("charge");
    else if (dist < 42 && !this.kind.ranged) this.setState("punch");
    else if (this.kind.ranged) this.setState(r < 0.7 ? "wave" : "jump");
    else if (dist < 150 && Math.abs(ty - this.y) < 30) this.setState(r < 0.55 ? "wave" : "jump");
    else this.setState("jump");
  }

  private endAttack() {
    this.attackCd = this.kind.cd[this.phase === 2 ? 1 : 0];
    this.setState("idle");
  }

  private applyPhysics(dt: number) {
    if (!this.grounded) this.vy = Math.min(this.vy + GRAVITY * dt, FALL_CAP);
    this.moveX(this.vx * dt);
    this.moveY(this.vy * dt);
    const l = this.x - HW + 2;
    const r = this.x + HW - 2;
    this.grounded = this.grid.solidInRect(l, this.y, r, this.y + 2);
    if (this.grounded && this.vy > 0) this.vy = 0;
  }

  private moveX(dx: number) {
    this.x += dx;
    if (this.grid.solidInRect(this.x - HW, this.y - H + 2, this.x + HW, this.y - 2)) {
      if (dx > 0) this.x = Math.floor((this.x + HW) / TILE) * TILE - HW - EPS;
      else if (dx < 0) this.x = (Math.floor((this.x - HW) / TILE) + 1) * TILE + HW + EPS;
      this.vx = 0;
    }
  }

  private moveY(dy: number) {
    const l = this.x - HW + 2;
    const r = this.x + HW - 2;
    this.y += dy;
    if (dy > 0) {
      if (this.grid.solidInRect(l, this.y - 3, r, this.y)) {
        this.y = Math.floor((this.y - EPS) / TILE) * TILE;
        this.vy = 0;
      }
    } else if (dy < 0) {
      const headTop = this.y - H;
      if (this.grid.solidInRect(l, headTop, r, headTop + 3)) {
        this.y = (Math.floor(headTop / TILE) + 1) * TILE + H + EPS;
        this.vy = 0;
      }
    }
  }
}
