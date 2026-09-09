import { TILE } from "../config";
import type { HeroKit } from "../data/heroes";
import type { Grid } from "../sys/grid";
import { specialReadiness } from "../data/special-readiness";
import type { SpecialReadiness } from "../data/special-readiness";

// ── Feel constants (px, seconds; tuned for 60fps fixed step) ────────────────
const MAX_RUN = 236;
const RUN_ACCEL = 2100;
const GROUND_DECEL = 3400;
const AIR_ACCEL = 1550;
const AIR_DECEL = 1050;

const JUMP_V = 374;
const G_RISE = 1250;
const G_FALL = 1780;
const FALL_CAP = 430;
const APEX_V = 45;
const APEX_MULT = 0.55;
const JUMP_CUT = 0.42;
const COYOTE = 0.1;
const JUMP_BUFFER = 0.11;

const WALL_SLIDE_MAX = 62;
const WALL_JUMP_VX = 168;
const WALL_JUMP_VY = 330;
const WALL_LOCK = 0.16;

const DASH_SPEED = 330;
export const DASH_DUR = 0.15;
const DASH_CD = 0.45;
const DASH_IFRAMES = 0.18;
const DASH_BUFFER = 0.1;
const STOMP_BOUNCE = 300;

const LAND_MIN = 130;

const ATTACK_BUFFER = 0.12;
const ATTACK_END_CD = 0.08;
const ATTACK_MOVE_MULT = 0.78;
// press within this long after a swing to chain the next hit
const COMBO_GRACE = 0.32;
// a queued next hit cancels the swing's tail at this fraction of dur (after the strike lands) so J-J-J chains snappily
const COMBO_CANCEL_FRAC = 0.5;
const SPECIAL_BUFFER = 0.12;

const HURT_IFRAMES = 0.9;
const HURT_STUN = 0.24;
const HURT_KB = 150;
const HURT_POP = 120;

const HW = 6;
const BODY_H = 22;
const EPS = 0.0001;

// Melee hitbox extents (px), relative to the player's feet at (x, y). Exported so
// the viewer's reach box can draw the ACTUAL hit area instead of an approximation.
// overlaps this far behind center so point-blank hits land
export const HIT_BACK = 8;
// reaches up over the body
export const HIT_UP = 34;
// down to just past the feet (catches grounded enemies)
export const HIT_DOWN = 6;

export const PLAYER_HALF_W = HW;
export const PLAYER_BODY_H = BODY_H;

const approach = (cur: number, target: number, maxDelta: number): number =>
  cur < target ? Math.min(cur + maxDelta, target) : Math.max(cur - maxDelta, target);
const clamp = (v: number, a: number, b: number): number => Math.min(Math.max(v, a), b);

export interface BodyInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jumpHeld: boolean;
  jumpPressed: boolean;
  dashPressed: boolean;
  attackPressed: boolean;
  specialPressed: boolean;
}

export interface BodyEvents {
  onJump?: () => void;
  onWallJump?: (side: number) => void;
  onLand?: (impact: number) => void;
  onDash?: () => void;
  onSwing?: (step: number) => void;
  onSpecial?: (kind: string) => void;
  onHurt?: () => void;
  onSquash?: (sx: number, sy: number, ms: number) => void;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export type AttackBox = Rect & { dmg: number; kb: number };
export type PlayerShot = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dmg: number;
};

// Pure platformer physics + combat state (kit-driven). No Phaser, no rendering.
// Deterministic given the same grid + input stream.
export class PlayerBody {
  x: number;
  y: number;
  // sim position one step ago — for render interpolation
  prevX = 0;
  prevY = 0;
  vx = 0;
  vy = 0;
  facing: 1 | -1 = 1;
  grounded = false;
  wallDir: -1 | 0 | 1 = 0;
  iframes = 0;
  dead = false;
  // co-op last stand: frozen + invulnerable awaiting a revive
  downed = false;

  attackStep = 0;
  swingId = 0;
  specialId = 0;
  specialActive = false;
  pendingShot: PlayerShot | null = null;
  pendingHeal = 0;

  private attackTime = 0;
  private attackBuf = 0;
  private attackCd = 0;
  private comboQueued = false;
  // last hit in the current chain (persists through comboGrace)
  private comboStage = 0;
  // window after a swing to press for the next hit
  private comboGrace = 0;

  private specialBuf = 0;
  private specialCd = 0;
  private specialElapsed = 0;
  private specialDur = 0;
  private specialFired = false;

  private hurtStun = 0;
  private airDash = true;
  private jumping = false;
  private coyote = 0;
  private jumpBuf = 0;
  private dashBuf = 0;
  private dashTime = 0;
  private dashCd = 0;
  private wallLock = 0;
  private dashDirX = 1;
  private dashDirY = 0;
  private landVy = 0;

  private hLeft = false;
  private hRight = false;
  private hUp = false;
  private hDown = false;
  private jumpHeld = false;

  /** Exact authority state; excludes grid, kit and presentation callbacks. */
  checkpoint() {
    return {
      airDash: this.airDash,
      attackBuf: this.attackBuf,
      attackCd: this.attackCd,
      attackStep: this.attackStep,
      attackTime: this.attackTime,
      comboGrace: this.comboGrace,
      comboQueued: this.comboQueued,
      comboStage: this.comboStage,
      coyote: this.coyote,
      dashBuf: this.dashBuf,
      dashCd: this.dashCd,
      dashDirX: this.dashDirX,
      dashDirY: this.dashDirY,
      dashTime: this.dashTime,
      dead: this.dead,
      downed: this.downed,
      facing: this.facing,
      grounded: this.grounded,
      hDown: this.hDown,
      hLeft: this.hLeft,
      hRight: this.hRight,
      hUp: this.hUp,
      hurtStun: this.hurtStun,
      iframes: this.iframes,
      jumpBuf: this.jumpBuf,
      jumpHeld: this.jumpHeld,
      jumping: this.jumping,
      landVy: this.landVy,
      pendingHeal: this.pendingHeal,
      pendingShot: structuredClone(this.pendingShot),
      prevX: this.prevX,
      prevY: this.prevY,
      specialActive: this.specialActive,
      specialBuf: this.specialBuf,
      specialCd: this.specialCd,
      specialDur: this.specialDur,
      specialElapsed: this.specialElapsed,
      specialFired: this.specialFired,
      specialId: this.specialId,
      swingId: this.swingId,
      vx: this.vx,
      vy: this.vy,
      wallDir: this.wallDir,
      wallLock: this.wallLock,
      x: this.x,
      y: this.y,
    };
  }

  /** Restore without simulating, emitting effects or refreshing cooldowns. */
  restore(state: PlayerBodyCheckpoint) {
    this.x = state.x;
    this.y = state.y;
    this.prevX = state.prevX;
    this.prevY = state.prevY;
    this.vx = state.vx;
    this.vy = state.vy;
    this.facing = state.facing;
    this.grounded = state.grounded;
    this.wallDir = state.wallDir;
    this.iframes = state.iframes;
    this.dead = state.dead;
    this.downed = state.downed;
    this.attackStep = state.attackStep;
    this.swingId = state.swingId;
    this.specialId = state.specialId;
    this.specialActive = state.specialActive;
    this.pendingShot = structuredClone(state.pendingShot);
    this.pendingHeal = state.pendingHeal;
    this.attackTime = state.attackTime;
    this.attackBuf = state.attackBuf;
    this.attackCd = state.attackCd;
    this.comboQueued = state.comboQueued;
    this.comboStage = state.comboStage;
    this.comboGrace = state.comboGrace;
    this.specialBuf = state.specialBuf;
    this.specialCd = state.specialCd;
    this.specialElapsed = state.specialElapsed;
    this.specialDur = state.specialDur;
    this.specialFired = state.specialFired;
    this.hurtStun = state.hurtStun;
    this.airDash = state.airDash;
    this.jumping = state.jumping;
    this.coyote = state.coyote;
    this.jumpBuf = state.jumpBuf;
    this.dashBuf = state.dashBuf;
    this.dashTime = state.dashTime;
    this.dashCd = state.dashCd;
    this.wallLock = state.wallLock;
    this.dashDirX = state.dashDirX;
    this.dashDirY = state.dashDirY;
    this.landVy = state.landVy;
    this.hLeft = state.hLeft;
    this.hRight = state.hRight;
    this.hUp = state.hUp;
    this.hDown = state.hDown;
    this.jumpHeld = state.jumpHeld;
  }

  /** Drop queued/held input; active actions and their deadlines keep running. */
  clearInput(): void {
    this.hLeft = false;
    this.hRight = false;
    this.hUp = false;
    this.hDown = false;
    this.jumpHeld = false;
    this.comboQueued = false;
    this.jumpBuf = 0;
    this.dashBuf = 0;
    this.attackBuf = 0;
    this.specialBuf = 0;
  }

  private grid: Grid;
  private kit: HeroKit;
  private ev: BodyEvents;

  constructor(grid: Grid, x: number, y: number, kit: HeroKit, ev: BodyEvents = {}) {
    this.grid = grid;
    this.kit = kit;
    this.ev = ev;
    this.x = x;
    this.y = y;
  }

  get dashing(): boolean {
    return this.dashTime > 0;
  }
  get hurting(): boolean {
    return this.hurtStun > 0;
  }
  get specialCdFrac(): number {
    const { cd } = this.kit.special;
    return cd > 0 ? clamp(this.specialCd / cd, 0, 1) : 0;
  }

  get specialReadiness(): SpecialReadiness {
    return specialReadiness({
      attackStep: this.attackStep,
      dashTime: this.dashTime,
      dead: this.dead,
      downed: this.downed,
      hurtStun: this.hurtStun,
      specialActive: this.specialActive,
      specialCd: this.specialCd,
    });
  }

  buffer(input: BodyInput) {
    this.hLeft = input.left;
    this.hRight = input.right;
    this.hUp = input.up;
    this.hDown = input.down;
    this.jumpHeld = input.jumpHeld;
    if (input.jumpPressed) {
      this.jumpBuf = JUMP_BUFFER;
    }
    if (input.dashPressed) {
      this.dashBuf = DASH_BUFFER;
    }
    if (input.attackPressed) {
      this.attackBuf = ATTACK_BUFFER;
    }
    if (input.specialPressed) {
      this.specialBuf = SPECIAL_BUFFER;
    }
  }

  bounce() {
    this.vy = -STOMP_BOUNCE;
    this.grounded = false;
    this.airDash = true;
  }

  enterRoom(grid: Grid, x: number, y: number) {
    this.grid = grid;
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.vx = 0;
    this.vy = 0;
    this.attackStep = 0;
    this.comboQueued = false;
    this.dashTime = 0;
    this.hurtStun = 0;
    this.iframes = 0;
    this.specialActive = false;
    this.downed = false;
    this.grounded = false;
  }

  applyHurt(dirX: number): boolean {
    if (this.iframes > 0 || this.dead || this.downed) {
      return false;
    }
    this.iframes = HURT_IFRAMES;
    this.hurtStun = HURT_STUN;
    this.vx = Math.sign(dirX || this.facing) * HURT_KB;
    this.vy = -HURT_POP;
    this.grounded = false;
    this.attackStep = 0;
    this.dashTime = 0;
    this.specialActive = false;
    this.ev.onHurt?.();
    return true;
  }

  // Enter co-op last stand: frozen (no move/attack/dash) and invulnerable via
  // the applyHurt guard; gravity still applies so an airborne down hits the floor.
  down() {
    this.downed = true;
    this.vx = 0;
    // invulnerability comes from the downed guard, not i-frames
    this.iframes = 0;
    this.hurtStun = 0;
    this.attackStep = 0;
    this.attackTime = 0;
    this.comboQueued = false;
    this.dashTime = 0;
    this.specialActive = false;
    this.jumping = false;
    this.pendingShot = null;
    this.pendingHeal = 0;
  }

  // Revived by a teammate: control returns with a mercy invulnerability window.
  revive() {
    this.downed = false;
    this.iframes = HURT_IFRAMES;
  }

  // ── guest-prediction corrections (see net/predict.ts) ──────────────────────
  /** Snap the sim to an authoritative point (hit knockback, respawn, teleport). */
  snapTo(x: number, y: number, vx: number, vy: number) {
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.vx = vx;
    this.vy = vy;
  }

  /** Shift the sim by a small reconciliation delta (prev too, so the render
   * interpolation doesn't smear the correction across a frame). */
  nudge(dx: number, dy: number) {
    this.x += dx;
    this.y += dy;
    this.prevX += dx;
    this.prevY += dy;
  }

  attackBox(): AttackBox | null {
    if (this.attackStep === 0) {
      return null;
    }
    const s = this.kit.swings[this.attackStep - 1];
    if (!s || this.attackTime < s.a0 || this.attackTime > s.a1) {
      return null;
    }
    // Reaches `reach` px forward, overlaps the body (HIT_BACK) so point-blank
    // swings connect, and spans HIT_UP above the feet to HIT_DOWN below — a tall
    // box that reliably catches grounded enemies in front.
    const left = this.facing > 0 ? this.x - HIT_BACK : this.x - s.reach;
    const right = this.facing > 0 ? this.x + s.reach : this.x + HIT_BACK;
    return {
      bottom: this.y + HIT_DOWN,
      dmg: s.dmg,
      kb: s.kb,
      left,
      right,
      top: this.y - HIT_UP,
    };
  }

  // AoE special hitbox (super-smash / reaping spin), else null.
  specialBox(): AttackBox | null {
    const sp = this.kit.special;
    if (!this.specialActive || sp.kind !== "aoe") {
      return null;
    }
    if (this.specialElapsed < sp.a0 || this.specialElapsed > sp.a1) {
      return null;
    }
    return {
      bottom: this.y + 4,
      dmg: sp.dmg,
      kb: sp.kb,
      left: this.x - sp.radius,
      right: this.x + sp.radius,
      top: this.y - BODY_H - sp.radius * 0.4,
    };
  }

  hurtBox(): Rect {
    return { bottom: this.y, left: this.x - HW, right: this.x + HW, top: this.y - BODY_H };
  }

  step(dt: number) {
    this.prevX = this.x;
    this.prevY = this.y;
    if (this.dead) {
      return;
    }
    if (this.downed) {
      this.stepDowned(dt);
      return;
    }
    const busy = this.specialActive;

    this.stepSpecialTrigger();
    this.stepAttack(dt, busy);
    this.stepSpecialProgress(dt);
    this.stepMovement(dt, this.attackStep > 0, busy);
    this.stepDash(busy);

    const prevGrounded = this.grounded;
    this.moveX(this.vx * dt);
    this.moveY(this.vy * dt);
    this.updateContacts();
    if (!prevGrounded && this.grounded && this.landVy > LAND_MIN) {
      this.ev.onSquash?.(1.3, 0.72, 150);
      this.ev.onLand?.(this.landVy);
    }

    this.stepTimers(dt);
  }

  // Last stand: crumpled in place — gravity + collision only; all buffered input
  // is dropped so nothing fires on the frame a revive lands.
  private stepDowned(dt: number) {
    this.jumpBuf = 0;
    this.dashBuf = 0;
    this.attackBuf = 0;
    this.specialBuf = 0;
    this.vx = approach(this.vx, 0, GROUND_DECEL * dt);
    if (!this.grounded) {
      this.vy = Math.min(this.vy + G_FALL * dt, FALL_CAP);
    }
    this.moveX(this.vx * dt);
    this.moveY(this.vy * dt);
    this.updateContacts();
  }

  private stepSpecialTrigger() {
    if (
      this.specialBuf > 0 &&
      this.specialCd <= 0 &&
      !this.specialActive &&
      this.attackStep === 0 &&
      this.dashTime <= 0 &&
      this.hurtStun <= 0
    ) {
      this.startSpecial();
      this.specialBuf = 0;
    }
  }

  private stepAttack(dt: number, busy: boolean) {
    if (
      !busy &&
      this.attackBuf > 0 &&
      this.attackCd <= 0 &&
      this.dashTime <= 0 &&
      this.hurtStun <= 0
    ) {
      if (this.attackStep === 0) {
        // Continue the chain if a press lands within the post-swing grace window,
        // else start fresh at hit 1 — so consecutive taps reliably go 1 → 2 → 3
        // whether you press during the swing or just after it lands.
        const chain =
          this.comboGrace > 0 && this.comboStage > 0 && this.comboStage < this.kit.swings.length;
        this.startSwing(chain ? this.comboStage + 1 : 1);
        this.attackBuf = 0;
      } else if (this.comboOpen()) {
        this.comboQueued = true;
        this.attackBuf = 0;
      }
    }
    if (this.attackStep > 0) {
      this.advanceSwing(dt);
    } else if (this.comboGrace > 0) {
      this.comboGrace -= dt;
      // chain lapsed → next tap is hit 1
      if (this.comboGrace <= 0) {
        this.comboStage = 0;
      }
    }
  }

  private advanceSwing(dt: number) {
    this.attackTime += dt;
    const cur = this.kit.swings[this.attackStep - 1];
    if (!cur) {
      return;
    }
    if (
      this.comboQueued &&
      this.attackStep < this.kit.swings.length &&
      this.attackTime >= cur.dur * COMBO_CANCEL_FRAC
    ) {
      // Queued next hit + the strike has landed (dur*FRAC is well past a1):
      // cancel this swing's recovery straight into the next slash.
      this.startSwing(this.attackStep + 1);
      this.comboQueued = false;
    } else if (this.attackTime >= cur.dur) {
      // Uncanceled swing ran its full readable length → end, hold the chain
      // open for one more tap.
      this.attackStep = 0;
      this.attackTime = 0;
      this.attackCd = ATTACK_END_CD;
      this.comboQueued = false;
      this.comboGrace = COMBO_GRACE;
    }
  }

  private stepSpecialProgress(dt: number) {
    if (!this.specialActive) {
      return;
    }
    this.specialElapsed += dt;
    const sp = this.kit.special;
    if (sp.kind === "projectile" && !this.specialFired && this.specialElapsed >= sp.fireAt) {
      this.pendingShot = {
        dmg: sp.dmg,
        vx: this.facing * sp.speed,
        vy: 0,
        x: this.x + this.facing * 10,
        y: this.y - 12,
      };
      this.specialFired = true;
    }
    if (this.specialElapsed >= this.specialDur) {
      this.specialActive = false;
    }
  }

  private stepMovement(dt: number, swinging: boolean, rooted: boolean) {
    if (this.dashTime > 0) {
      this.vx = this.dashDirX * DASH_SPEED;
      this.vy = this.dashDirY * DASH_SPEED;
      return;
    }
    this.applyRun(dt, swinging, rooted);
    if (this.jumpBuf > 0 && this.hurtStun <= 0 && !rooted) {
      this.tryJump();
    }
    if (this.jumping && this.vy < 0 && !this.jumpHeld) {
      this.vy *= JUMP_CUT;
      this.jumping = false;
    }
    if (this.vy >= 0) {
      this.jumping = false;
    }
    if (!this.grounded) {
      this.applyGravity(dt);
    }
  }

  private applyRun(dt: number, swinging: boolean, rooted: boolean) {
    const locked = this.wallLock > 0 || this.hurtStun > 0 || rooted;
    const dir = locked ? 0 : (this.hRight ? 1 : 0) - (this.hLeft ? 1 : 0);
    const speedMult = swinging ? ATTACK_MOVE_MULT : 1;
    if (dir !== 0) {
      // Turn freely even mid-swing — the hit lands in the first ~0.1s, so the
      // long readable recovery shouldn't lock your facing (that read as sluggish).
      this.facing = dir > 0 ? 1 : -1;
      this.vx = approach(
        this.vx,
        dir * MAX_RUN * speedMult,
        (this.grounded ? RUN_ACCEL : AIR_ACCEL) * dt,
      );
    } else if (this.hurtStun <= 0) {
      this.vx = approach(this.vx, 0, (this.grounded ? GROUND_DECEL : AIR_DECEL) * dt);
    }
  }

  private tryJump() {
    if (this.grounded || this.coyote > 0) {
      this.vy = -JUMP_V;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuf = 0;
      this.jumping = true;
      this.ev.onSquash?.(0.9, 1.15, 130);
      this.ev.onJump?.();
    } else if (this.wallDir !== 0) {
      this.vy = -WALL_JUMP_VY;
      this.vx = -this.wallDir * WALL_JUMP_VX;
      this.facing = this.wallDir > 0 ? -1 : 1;
      this.wallLock = WALL_LOCK;
      this.jumpBuf = 0;
      this.jumping = true;
      this.ev.onJump?.();
      this.ev.onWallJump?.(this.wallDir);
    }
  }

  private applyGravity(dt: number) {
    let g = this.vy < 0 ? G_RISE : G_FALL;
    if (this.jumpHeld && Math.abs(this.vy) < APEX_V) {
      g *= APEX_MULT;
    }
    this.vy = Math.min(this.vy + g * dt, FALL_CAP);
    const pressingWall = (this.wallDir === 1 && this.hRight) || (this.wallDir === -1 && this.hLeft);
    if (pressingWall && this.vy > WALL_SLIDE_MAX && this.hurtStun <= 0) {
      this.vy = WALL_SLIDE_MAX;
    }
  }

  private stepDash(rooted: boolean) {
    if (
      this.dashBuf > 0 &&
      this.dashCd <= 0 &&
      this.dashTime <= 0 &&
      this.hurtStun <= 0 &&
      !rooted &&
      (this.grounded || this.airDash)
    ) {
      this.startDash();
    }
    if (this.dashTime > 0) {
      this.vx = this.dashDirX * DASH_SPEED;
      this.vy = this.dashDirY * DASH_SPEED;
    }
  }

  private stepTimers(dt: number) {
    if (this.grounded) {
      this.coyote = COYOTE;
      this.airDash = true;
    } else {
      this.coyote = Math.max(0, this.coyote - dt);
    }
    this.jumpBuf = Math.max(0, this.jumpBuf - dt);
    this.dashBuf = Math.max(0, this.dashBuf - dt);
    this.specialBuf = Math.max(0, this.specialBuf - dt);
    this.specialCd = Math.max(0, this.specialCd - dt);
    this.wallLock = Math.max(0, this.wallLock - dt);
    this.iframes = Math.max(0, this.iframes - dt);
    this.hurtStun = Math.max(0, this.hurtStun - dt);
    this.attackCd = Math.max(0, this.attackCd - dt);
    if (this.dashTime > 0) {
      this.dashTime -= dt;
      if (this.dashTime <= 0) {
        this.dashCd = DASH_CD;
        this.vx = clamp(this.vx, -MAX_RUN, MAX_RUN);
        if (this.dashDirY !== 0) {
          this.vy = 0;
        }
      }
    } else {
      this.dashCd = Math.max(0, this.dashCd - dt);
    }
  }

  private startSpecial() {
    const sp = this.kit.special;
    this.specialCd = sp.cd;
    this.specialActive = true;
    this.specialElapsed = 0;
    this.specialFired = false;
    this.specialId += 1;
    this.attackStep = 0;
    switch (sp.kind) {
      case "aoe": {
        this.specialDur = sp.dur;
        break;
      }
      case "projectile": {
        this.specialDur = sp.dur;
        break;
      }
      case "heal": {
        this.specialDur = sp.dur;
        this.pendingHeal = sp.amount;
        break;
      }
      case "blink": {
        this.specialDur = 0.24;
        this.doBlink(sp.dist, sp.iframes);
        break;
      }
      default: {
        break;
      }
    }
    this.ev.onSpecial?.(sp.kind);
  }

  private doBlink(dist: number, iframes: number) {
    const dir = this.facing;
    let nx = this.x;
    for (let d = 4; d <= dist; d += 4) {
      const tryx = this.x + dir * d;
      if (this.grid.solidInRect(tryx - HW, this.y - BODY_H + 2, tryx + HW, this.y - 2)) {
        break;
      }
      nx = tryx;
    }
    this.x = nx;
    this.iframes = Math.max(this.iframes, iframes);
    this.vx = 0;
  }

  private comboOpen(): boolean {
    if (this.attackStep === 0) {
      return false;
    }
    const s = this.kit.swings[this.attackStep - 1];
    return !!s && this.attackTime >= s.combo && this.attackTime <= s.dur;
  }

  private startSwing(n: number) {
    this.attackStep = n;
    this.attackTime = 0;
    this.swingId += 1;
    this.comboStage = n;
    const s = this.kit.swings[n - 1];
    if (s && this.grounded) {
      this.vx = this.facing * s.lunge;
    }
    this.ev.onSwing?.(n);
  }

  private startDash() {
    this.dashBuf = 0;
    this.attackStep = 0;
    this.comboQueued = false;
    // dashing cancels the chain → next tap is hit 1
    this.comboGrace = 0;
    let dx = (this.hRight ? 1 : 0) - (this.hLeft ? 1 : 0);
    const dy = (this.hDown ? 1 : 0) - (this.hUp ? 1 : 0);
    if (dx === 0 && dy === 0) {
      dx = this.facing;
    }
    const len = Math.hypot(dx, dy) || 1;
    this.dashDirX = dx / len;
    this.dashDirY = dy / len;
    this.dashTime = DASH_DUR;
    this.iframes = Math.max(this.iframes, DASH_IFRAMES);
    if (!this.grounded) {
      this.airDash = false;
    }
    if (dx !== 0) {
      this.facing = dx > 0 ? 1 : -1;
    }
    this.ev.onDash?.();
  }

  private moveX(dx: number) {
    this.x += dx;
    const t = this.y - BODY_H + 2;
    const b = this.y - 2;
    if (this.grid.solidInRect(this.x - HW, t, this.x + HW, b)) {
      if (dx > 0) {
        this.x = Math.floor((this.x + HW) / TILE) * TILE - HW - EPS;
      } else if (dx < 0) {
        this.x = (Math.floor((this.x - HW) / TILE) + 1) * TILE + HW + EPS;
      }
      this.vx = 0;
    }
  }

  private moveY(dy: number) {
    this.landVy = 0;
    const prevFeet = this.y;
    const l = this.x - HW + 2;
    const r = this.x + HW - 2;
    this.y += dy;
    if (dy > 0) {
      let hit = this.grid.solidInRect(l, this.y - 3, r, this.y);
      if (!hit && !this.hDown) {
        const row = Math.floor((this.y - EPS) / TILE);
        const top = row * TILE;
        const onOneWay =
          this.grid.isOneWayCell(Math.floor(l / TILE), row) ||
          this.grid.isOneWayCell(Math.floor(r / TILE), row);
        if (onOneWay && prevFeet <= top + 1 && this.y >= top) {
          hit = true;
        }
      }
      if (hit) {
        this.y = Math.floor((this.y - EPS) / TILE) * TILE;
        this.landVy = this.vy;
        this.vy = 0;
      }
    } else if (dy < 0) {
      const headTop = this.y - BODY_H;
      if (this.grid.solidInRect(l, headTop, r, headTop + 3)) {
        this.y = (Math.floor(headTop / TILE) + 1) * TILE + BODY_H + EPS;
        this.vy = 0;
      }
    }
  }

  private groundBelow(): boolean {
    const l = this.x - HW + 2;
    const r = this.x + HW - 2;
    if (this.grid.solidInRect(l, this.y, r, this.y + 2)) {
      return true;
    }
    if (!this.hDown && this.grid.oneWayInRect(l, this.y, r, this.y + 2)) {
      return true;
    }
    return false;
  }

  private updateContacts() {
    this.grounded = this.groundBelow();
    if (this.grounded && this.vy > 0) {
      this.vy = 0;
    }
    const t = this.y - BODY_H + 3;
    const b = this.y - 3;
    if (this.grid.solidInRect(this.x + HW, t, this.x + HW + 2, b)) {
      this.wallDir = 1;
    } else if (this.grid.solidInRect(this.x - HW - 2, t, this.x - HW, b)) {
      this.wallDir = -1;
    } else {
      this.wallDir = 0;
    }
  }
}

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

export type PlayerBodyCheckpoint = ReturnType<PlayerBody["checkpoint"]>;
