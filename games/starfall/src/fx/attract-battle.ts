import Phaser from "phaser";

import type { FxPool } from "../render/fx-pool";
import type { Vec } from "../shared/constants";

// Cosmetic "warp into a massive space war" backdrop for the start screen. A
// squadron of fake AI fighters dogfights, fires beams and explodes using the
// game's real fx pool + ship rendering. It is PURELY visual: nothing here
// touches the net session, XP, collisions with real players or the shared
// world. Driven from GameScene.update() only while play hasn't begun; torn
// down the instant real play starts. If real remote players are on screen they
// simply render on top — these fakes never interact with them.

/** Builds a ship Graphics (delegates to the scene's real makeShipGfx). */
type ShipFactory = (tint: number, level: number) => Phaser.GameObjects.Graphics;
/** The ship hull polygon for a level (delegates to the scene's shipHullPoints). */
type HullPoints = (level: number) => Vec[];

export type AttractDeps = {
  fx: FxPool;
  makeShip: ShipFactory;
  hullPoints: HullPoints;
};

/** Squadron size. Two dozen fighters sells a full-scale war without denting
 *  the frame budget: each ship is one static Graphics (drawn once, only
 *  transformed per frame); beams are batched into a single pooled Graphics;
 *  explosions route through the shared FxPool (its own hard particle cap
 *  applies). */
const COUNT = 24;

// Neon squadron palette — two "teams" of warm vs cool so dogfights read.
const COOL = [0x7fb2ff, 0x5ce1e6, 0x9d7dff, 0x4ade80] as const;
const WARM = [0xff5d73, 0xffa64d, 0xff5cf0, 0xffe066] as const;

const SHIP_SPEED = 92; // cruise px/s
const TURN_RATE = 3.4; // rad/s toward desired heading
const VEL_BLEND = 3.2; // how fast velocity chases heading*speed (per s)
const FIRE_RANGE = 300;
const FIRE_CONE = 0.32; // rad half-angle to open fire
const FIRE_CD_MIN = 480;
const FIRE_CD_MAX = 1150;
const BEAM_LIFE_MS = 120;
const SHOT_DAMAGE = 34;
const FIGHTER_HP = 100;
const RESPAWN_MIN_MS = 700;
const RESPAWN_MAX_MS = 1600;
const EDGE_MARGIN = 80; // keep the swarm inside the viewport (+turn-in band)
const BREAK_DIST = 95; // closing inside this ends the attack run (overshoot past)
const WEAVE_RATE = 2.1; // rad/s of the jink oscillation while on an attack run
const WEAVE_AMP = 0.28; // rad of heading weave — kills the "perfect circle" look

// Speed multipliers per maneuver: runs come in hot, extends burn away harder,
// cruises coast — the mix keeps the swarm's motion from reading as uniform.
const RUN_SPEED = 1.25;
const EXTEND_SPEED = 1.45;

/** What a fighter is currently flying:
 *  - "engage": attack run straight at the target (with a weave), guns live
 *  - "extend": burn away after the pass to open distance (guns cold)
 *  - "cruise": transit to a random waypoint between engagements */
type Maneuver = "engage" | "extend" | "cruise";

type Fighter = {
  gfx: Phaser.GameObjects.Graphics;
  tint: number;
  level: number;
  cool: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  hp: number;
  targetIdx: number;
  fireAt: number;
  breakDir: number; // +1 / -1: which side to break/extend toward after a pass
  maneuver: Maneuver;
  maneuverUntil: number; // ms; reconsider the maneuver at this deadline
  wpX: number; // cruise waypoint
  wpY: number;
  weavePhase: number; // per-ship jink phase so runs don't sync up
  alive: boolean;
  respawnAt: number; // ms; 0 while alive
};

type Shot = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  tint: number;
  width: number;
  bornAt: number;
};

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

/** Shortest signed angle a→b. */
function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class AttractBattle {
  private readonly fighters: Fighter[] = [];
  private readonly shots: Shot[] = [];
  private readonly beamGfx: Phaser.GameObjects.Graphics;
  private started = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly deps: AttractDeps,
  ) {
    // Below the DOM start overlay, above the starfield; additive so the beams
    // bloom like the in-game weapon fire.
    this.beamGfx = scene.add.graphics().setDepth(8).setBlendMode(Phaser.BlendModes.ADD);
  }

  /** Lazily seed the swarm across the current viewport (needs a laid-out camera). */
  private seed(): void {
    if (this.started) return;
    const view = this.scene.cameras.main.worldView;
    // The first frame(s) can run before the camera has real bounds — seeding
    // then dumps the whole fleet in a tiny box at the top-left corner.
    if (view.width < 200 || view.height < 200) return;
    this.started = true;
    for (let i = 0; i < COUNT; i++) {
      const cool = i % 2 === 0;
      const pool = cool ? COOL : WARM;
      const tint = pool[i % pool.length] ?? 0xffffff;
      const level = 1 + (Math.random() < 0.5 ? 0 : Math.random() < 0.6 ? 1 : 2);
      const gfx = this.deps.makeShip(tint, level).setDepth(9);
      const angle = rand(-Math.PI, Math.PI);
      this.fighters.push({
        gfx,
        tint,
        level,
        cool,
        x: rand(view.x + EDGE_MARGIN, view.right - EDGE_MARGIN),
        y: rand(view.y + EDGE_MARGIN, view.bottom - EDGE_MARGIN),
        vx: Math.cos(angle) * SHIP_SPEED,
        vy: Math.sin(angle) * SHIP_SPEED,
        angle,
        hp: FIGHTER_HP,
        targetIdx: -1,
        fireAt: this.scene.time.now + rand(0, FIRE_CD_MAX),
        breakDir: Math.random() < 0.5 ? 1 : -1,
        // Stagger the opening moves so the fleet doesn't act in lockstep.
        maneuver: Math.random() < 0.6 ? "engage" : "cruise",
        maneuverUntil: this.scene.time.now + rand(400, 2600),
        wpX: rand(view.x + EDGE_MARGIN, view.right - EDGE_MARGIN),
        wpY: rand(view.y + EDGE_MARGIN, view.bottom - EDGE_MARGIN),
        weavePhase: rand(0, Math.PI * 2),
        alive: true,
        respawnAt: 0,
      });
    }
  }

  /** Nearest live enemy-team fighter to `f`; -1 if none. */
  private acquire(f: Fighter): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.fighters.length; i++) {
      const o = this.fighters[i];
      if (!o || o === f || !o.alive || o.cool === f.cool) continue;
      const d = (o.x - f.x) ** 2 + (o.y - f.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private explode(f: Fighter, now: number): void {
    const pts = this.deps.hullPoints(f.level);
    this.deps.fx.shatter(f.x, f.y, pts, f.angle, f.tint);
    this.deps.fx.ring(f.x, f.y, 8, 70, 360, 0xffffff, 0.7);
    this.deps.fx.sparks(f.x, f.y, 10, f.tint, { lifeMin: 150, lifeMax: 300 });
    f.alive = false;
    f.hp = 0;
    f.gfx.setVisible(false);
    f.respawnAt = now + rand(RESPAWN_MIN_MS, RESPAWN_MAX_MS);
  }

  private respawn(f: Fighter, now: number): void {
    const view = this.scene.cameras.main.worldView;
    // Fly back in from a random screen edge with a converge tell.
    const edge = Math.floor(Math.random() * 4);
    if (edge === 0) {
      f.x = view.x + EDGE_MARGIN;
      f.y = rand(view.y, view.bottom);
    } else if (edge === 1) {
      f.x = view.right - EDGE_MARGIN;
      f.y = rand(view.y, view.bottom);
    } else if (edge === 2) {
      f.x = rand(view.x, view.right);
      f.y = view.y + EDGE_MARGIN;
    } else {
      f.x = rand(view.x, view.right);
      f.y = view.bottom - EDGE_MARGIN;
    }
    const toCenter = Math.atan2(view.centerY - f.y, view.centerX - f.x);
    f.angle = toCenter;
    f.vx = Math.cos(toCenter) * SHIP_SPEED;
    f.vy = Math.sin(toCenter) * SHIP_SPEED;
    f.hp = FIGHTER_HP;
    f.targetIdx = -1;
    f.fireAt = now + rand(FIRE_CD_MIN, FIRE_CD_MAX);
    f.maneuver = "cruise"; // fly back into the fray before picking a fight
    f.maneuverUntil = now + rand(600, 1400);
    f.wpX = rand(view.x + EDGE_MARGIN, view.right - EDGE_MARGIN);
    f.wpY = rand(view.y + EDGE_MARGIN, view.bottom - EDGE_MARGIN);
    f.alive = true;
    f.respawnAt = 0;
    f.gfx.setVisible(true);
    this.deps.fx.converge(f.x, f.y, 10, 46, 280, f.tint);
  }

  /** Advance the cosmetic battle one frame. Safe to call every frame while the
   *  start screen is up; no-ops once destroyed. */
  update(dt: number, now: number): void {
    this.seed();
    const view = this.scene.cameras.main.worldView;

    for (const f of this.fighters) {
      if (!f.alive) {
        if (now >= f.respawnAt) this.respawn(f, now);
        continue;
      }

      // Reacquire when target is gone/dead.
      let target = this.fighters[f.targetIdx];
      if (!target || !target.alive) {
        f.targetIdx = this.acquire(f);
        target = this.fighters[f.targetIdx];
      }

      // Maneuver transitions. Real dogfights are passes, not circles: run in
      // hot, overshoot, extend away, come back around — with transit legs in
      // between so the furball drifts across the screen.
      const dist = target ? Math.hypot(target.x - f.x, target.y - f.y) : Infinity;
      if (f.maneuver === "engage") {
        if (dist < BREAK_DIST || now >= f.maneuverUntil) {
          f.maneuver = "extend";
          f.maneuverUntil = now + rand(700, 1500);
          f.breakDir = Math.random() < 0.5 ? 1 : -1;
          // A pass often ends with a new mark — keeps pairs from re-locking.
          if (Math.random() < 0.35) f.targetIdx = this.acquire(f);
        }
      } else if (now >= f.maneuverUntil) {
        if (f.maneuver === "extend" && Math.random() < 0.3) {
          f.maneuver = "cruise";
          f.maneuverUntil = now + rand(1200, 2600);
          f.wpX = rand(view.x + EDGE_MARGIN, view.right - EDGE_MARGIN);
          f.wpY = rand(view.y + EDGE_MARGIN, view.bottom - EDGE_MARGIN);
        } else {
          f.maneuver = "engage";
          f.maneuverUntil = now + rand(1400, 3000);
        }
      }
      if (f.maneuver === "cruise" && Math.hypot(f.wpX - f.x, f.wpY - f.y) < 60) {
        f.maneuver = "engage";
        f.maneuverUntil = now + rand(1400, 3000);
      }

      // Desired heading + speed per maneuver.
      let desired = f.angle;
      let speed = SHIP_SPEED;
      if (f.maneuver === "engage" && target) {
        const toT = Math.atan2(target.y - f.y, target.x - f.x);
        // Straight at the mark, with a weave so the run reads as flown, not aimed.
        desired = toT + Math.sin(now * 0.001 * WEAVE_RATE + f.weavePhase) * WEAVE_AMP;
        speed = SHIP_SPEED * RUN_SPEED;
      } else if (f.maneuver === "extend" && target) {
        // Burn away past the target's far side to open distance for re-entry.
        const away = Math.atan2(f.y - target.y, f.x - target.x);
        desired = away + f.breakDir * 0.5;
        speed = SHIP_SPEED * EXTEND_SPEED;
      } else {
        desired = Math.atan2(f.wpY - f.y, f.wpX - f.x);
      }
      const pad = EDGE_MARGIN;
      const outside =
        f.x < view.x + pad ||
        f.x > view.right - pad ||
        f.y < view.y + pad ||
        f.y > view.bottom - pad;
      if (outside) desired = Math.atan2(view.centerY - f.y, view.centerX - f.x);

      // Turn toward desired at a limited rate, then chase heading*speed.
      f.angle += Phaser.Math.Clamp(angleDelta(f.angle, desired), -TURN_RATE * dt, TURN_RATE * dt);
      const k = 1 - Math.exp(-VEL_BLEND * dt);
      f.vx += (Math.cos(f.angle) * speed - f.vx) * k;
      f.vy += (Math.sin(f.angle) * speed - f.vy) * k;
      f.x += f.vx * dt;
      f.y += f.vy * dt;

      f.gfx.setPosition(f.x, f.y).setRotation(f.angle);

      // Guns are only live on the attack run, when aimed at an in-range mark.
      if (f.maneuver === "engage" && target && now >= f.fireAt) {
        const aim = Math.abs(angleDelta(f.angle, Math.atan2(target.y - f.y, target.x - f.x)));
        if (dist < FIRE_RANGE && aim < FIRE_CONE) {
          this.fire(f, target, now);
          f.fireAt = now + rand(FIRE_CD_MIN, FIRE_CD_MAX);
        }
      }
    }

    this.drawBeams(now);
  }

  private fire(f: Fighter, target: Fighter, now: number): void {
    const nx = f.x + Math.cos(f.angle) * 10;
    const ny = f.y + Math.sin(f.angle) * 10;
    this.shots.push({
      x1: nx,
      y1: ny,
      x2: target.x,
      y2: target.y,
      tint: f.tint,
      width: 1 + f.level * 0.4,
      bornAt: now,
    });
    this.deps.fx.sparks(nx, ny, 3, f.tint, {
      lifeMin: 60,
      lifeMax: 130,
      speedMin: 40,
      speedMax: 120,
    });
    target.hp -= SHOT_DAMAGE;
    if (target.hp <= 0) this.explode(target, now);
    else this.deps.fx.sparks(target.x, target.y, 4, target.tint, { lifeMin: 90, lifeMax: 180 });
  }

  private drawBeams(now: number): void {
    const g = this.beamGfx;
    g.clear();
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      if (!s) continue;
      const age = now - s.bornAt;
      if (age >= BEAM_LIFE_MS) {
        this.shots.splice(i, 1);
        continue;
      }
      const a = 1 - age / BEAM_LIFE_MS;
      // Outer glow + bright core, mirroring the in-game beam look.
      g.lineStyle(s.width * 3, s.tint, 0.18 * a);
      g.lineBetween(s.x1, s.y1, s.x2, s.y2);
      g.lineStyle(s.width, 0xffffff, 0.85 * a);
      g.lineBetween(s.x1, s.y1, s.x2, s.y2);
    }
  }

  /** Despawn everything. Called the moment real play begins. */
  destroy(): void {
    for (const f of this.fighters) f.gfx.destroy();
    this.fighters.length = 0;
    this.shots.length = 0;
    this.beamGfx.destroy();
  }
}
