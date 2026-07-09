import Phaser from "phaser";

import type { FxPool } from "../render/fx-pool";
import { ENEMY_SPECS, type EnemyKind, type Vec } from "../shared/constants";

// Cosmetic backdrop for the start screen that mimics ACTUAL play: one hero
// ship kiting and gunning down an endless swarm of the game's real enemies.
// Enemies fly in from beyond the screen edges (never pop in), press toward the
// hero, and die to beam fire or burst against the hero's shield. It is PURELY
// visual: nothing here touches the net session, XP, collisions with real
// players or the shared world. Driven from GameScene.update() only while play
// hasn't begun; torn down the instant real play starts.

/** Builds a ship Graphics (delegates to the scene's real makeShipGfx). */
type ShipFactory = (tint: number, level: number) => Phaser.GameObjects.Graphics;
/** The ship hull polygon for a level (delegates to the scene's shipHullPoints). */
type HullPoints = (level: number) => Vec[];
/** Builds an enemy Graphics / hull (delegates to the scene's real enemy art). */
type EnemyFactory = (kind: EnemyKind) => Phaser.GameObjects.Graphics;
type EnemyHull = (kind: EnemyKind) => ReadonlyArray<Vec>;

export type AttractDeps = {
  fx: FxPool;
  makeShip: ShipFactory;
  hullPoints: HullPoints;
  makeEnemy: EnemyFactory;
  enemyHull: EnemyHull;
};

/** Live swarm size the spawner maintains. A dozen chasers reads as "one
 *  against the horde" without denting the frame budget: every entity is one
 *  static Graphics (drawn once, only transformed per frame); beams batch into
 *  a single pooled Graphics; explosions ride the shared FxPool cap. */
const SWARM_SIZE = 16;

/** The light enemy kinds that swarm in real play (heavies would dwarf the
 *  title). Weighted toward drones, like an actual early arena. */
const SWARM_KINDS: ReadonlyArray<{ kind: EnemyKind; weight: number; hp: number; speed: number }> = [
  { kind: "drone", weight: 0.5, hp: 2, speed: 118 },
  { kind: "wasp", weight: 0.3, hp: 3, speed: 150 },
  { kind: "lancer", weight: 0.2, hp: 4, speed: 92 },
];

const HERO_TINT = 0x7fb2ff;
const HERO_LEVEL = 3;
const HERO_SPEED = 125;
const HERO_TURN = 3.6; // rad/s toward desired heading
const VEL_BLEND = 3.2; // how fast velocity chases heading*speed (per s)
const HERO_FIRE_RANGE = 360;
const HERO_FIRE_CD_MIN = 330;
const HERO_FIRE_CD_MAX = 560;
const KITE_DIST = 150; // closer than this, the hero breaks away from the pack
const BEAM_LIFE_MS = 110;
const ENEMY_TURN = 2.6; // rad/s — chasers arc in rather than rail-turn
const CONTACT_DIST = 30; // swarm reaching the hero bursts on its shield
const ENTRY_MARGIN_MIN = 60; // spawn this far beyond the screen edge...
const ENTRY_MARGIN_MAX = 140; // ...so every enemy visibly FLIES IN
const RESPAWN_MIN_MS = 150;
const RESPAWN_MAX_MS = 600;
const WEAVE_RATE = 2.3; // rad/s of heading weave
const EDGE_PAD = 90; // hero stays inside this viewport band

type Hero = {
  gfx: Phaser.GameObjects.Graphics;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  fireAt: number;
  wpX: number;
  wpY: number;
  wpUntil: number;
};

type Swarmer = {
  gfx: Phaser.GameObjects.Graphics;
  kind: EnemyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  hp: number;
  speed: number;
  weavePhase: number;
  weaveAmp: number;
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

function rollKind(): { kind: EnemyKind; hp: number; speed: number } {
  const r = Math.random();
  let acc = 0;
  for (const s of SWARM_KINDS) {
    acc += s.weight;
    if (r < acc) return s;
  }
  const last = SWARM_KINDS[SWARM_KINDS.length - 1];
  return last ?? { kind: "drone", hp: 2, speed: 118 };
}

export class AttractBattle {
  private hero: Hero | null = null;
  private readonly swarm: Swarmer[] = [];
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

  /** Lazily seed hero + swarm (needs a laid-out camera). */
  private seed(): void {
    if (this.started) return;
    const view = this.scene.cameras.main.worldView;
    // The first frame(s) can run before the camera has real bounds — seeding
    // then dumps everything in a tiny box at the top-left corner.
    if (view.width < 200 || view.height < 200) return;
    this.started = true;

    const now = this.scene.time.now;
    this.hero = {
      gfx: this.deps.makeShip(HERO_TINT, HERO_LEVEL).setDepth(9),
      x: view.centerX + rand(-80, 80),
      y: view.centerY + rand(60, 140), // below the title text block
      vx: 0,
      vy: 0,
      angle: rand(-Math.PI, Math.PI),
      fireAt: now + rand(200, 600),
      wpX: view.centerX,
      wpY: view.centerY + 100,
      wpUntil: 0,
    };

    for (let i = 0; i < SWARM_SIZE; i++) {
      const s = this.makeSwarmer();
      // Stagger the opening entries so the swarm streams in, not a wall.
      s.alive = false;
      s.gfx.setVisible(false);
      s.respawnAt = now + i * rand(120, 320);
      this.swarm.push(s);
    }
  }

  private makeSwarmer(): Swarmer {
    const roll = rollKind();
    return {
      gfx: this.deps.makeEnemy(roll.kind),
      kind: roll.kind,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      angle: 0,
      hp: roll.hp,
      speed: roll.speed,
      weavePhase: rand(0, Math.PI * 2),
      weaveAmp: roll.kind === "wasp" ? 0.55 : 0.22,
      alive: true,
      respawnAt: 0,
    };
  }

  /** Send a swarmer in from beyond a random screen edge, aimed at the hero. */
  private enter(s: Swarmer): void {
    const view = this.scene.cameras.main.worldView;
    const roll = rollKind();
    s.kind = roll.kind;
    s.hp = roll.hp;
    s.speed = roll.speed;
    s.gfx.destroy();
    s.gfx = this.deps.makeEnemy(s.kind);

    const m = rand(ENTRY_MARGIN_MIN, ENTRY_MARGIN_MAX);
    const edge = Math.floor(Math.random() * 4);
    if (edge === 0) {
      s.x = view.x - m;
      s.y = rand(view.y, view.bottom);
    } else if (edge === 1) {
      s.x = view.right + m;
      s.y = rand(view.y, view.bottom);
    } else if (edge === 2) {
      s.x = rand(view.x, view.right);
      s.y = view.y - m;
    } else {
      s.x = rand(view.x, view.right);
      s.y = view.bottom + m;
    }
    const at = this.hero
      ? Math.atan2(this.hero.y - s.y, this.hero.x - s.x)
      : Math.atan2(view.centerY - s.y, view.centerX - s.x);
    s.angle = at;
    s.vx = Math.cos(at) * s.speed;
    s.vy = Math.sin(at) * s.speed;
    s.alive = true;
    s.respawnAt = 0;
    s.gfx.setVisible(true).setPosition(s.x, s.y).setRotation(s.angle);
  }

  private killSwarmer(s: Swarmer, now: number): void {
    const spec = ENEMY_SPECS[s.kind];
    this.deps.fx.shatter(s.x, s.y, this.deps.enemyHull(s.kind), s.angle, spec.tint);
    this.deps.fx.sparks(s.x, s.y, 8, spec.tint, { lifeMin: 140, lifeMax: 280 });
    s.alive = false;
    s.gfx.setVisible(false);
    s.respawnAt = now + rand(RESPAWN_MIN_MS, RESPAWN_MAX_MS);
  }

  /** Advance the cosmetic battle one frame. Safe to call every frame while the
   *  start screen is up; no-ops once destroyed. */
  update(dt: number, now: number): void {
    this.seed();
    const hero = this.hero;
    if (!hero) return;
    const view = this.scene.cameras.main.worldView;

    // ---- hero: kite the pack, gun the nearest chaser -------------------------
    let nearest: Swarmer | null = null;
    let nearestD = Infinity;
    let packX = 0;
    let packY = 0;
    let packN = 0;
    for (const s of this.swarm) {
      if (!s.alive) continue;
      packX += s.x;
      packY += s.y;
      packN++;
      const d = Math.hypot(s.x - hero.x, s.y - hero.y);
      if (d < nearestD) {
        nearestD = d;
        nearest = s;
      }
    }

    let desired: number;
    if (nearest && nearestD < KITE_DIST && packN > 0) {
      // Too much company: burn away from the pack's center of mass.
      desired = Math.atan2(hero.y - packY / packN, hero.x - packX / packN);
    } else {
      // Drift between waypoints so the fight wanders the screen.
      if (now >= hero.wpUntil || Math.hypot(hero.wpX - hero.x, hero.wpY - hero.y) < 50) {
        hero.wpX = rand(view.x + view.width * 0.2, view.right - view.width * 0.2);
        hero.wpY = rand(view.y + view.height * 0.25, view.bottom - view.height * 0.15);
        hero.wpUntil = now + rand(1800, 3600);
      }
      desired = Math.atan2(hero.wpY - hero.y, hero.wpX - hero.x);
    }
    desired += Math.sin(now * 0.001 * WEAVE_RATE) * 0.2;
    const outside =
      hero.x < view.x + EDGE_PAD ||
      hero.x > view.right - EDGE_PAD ||
      hero.y < view.y + EDGE_PAD ||
      hero.y > view.bottom - EDGE_PAD;
    if (outside) desired = Math.atan2(view.centerY - hero.y, view.centerX - hero.x);

    hero.angle += Phaser.Math.Clamp(angleDelta(hero.angle, desired), -HERO_TURN * dt, HERO_TURN * dt);
    const k = 1 - Math.exp(-VEL_BLEND * dt);
    hero.vx += (Math.cos(hero.angle) * HERO_SPEED - hero.vx) * k;
    hero.vy += (Math.sin(hero.angle) * HERO_SPEED - hero.vy) * k;
    hero.x += hero.vx * dt;
    hero.y += hero.vy * dt;
    hero.gfx.setPosition(hero.x, hero.y).setRotation(hero.angle);

    // In real play aim is mouse-driven, decoupled from travel — so the hero
    // fires at the nearest threat regardless of heading.
    if (nearest && nearestD < HERO_FIRE_RANGE && now >= hero.fireAt) {
      this.fireHero(hero, nearest, now);
      hero.fireAt = now + rand(HERO_FIRE_CD_MIN, HERO_FIRE_CD_MAX);
    }

    // ---- swarm: press the hero, burst on shield contact -----------------------
    for (const s of this.swarm) {
      if (!s.alive) {
        if (now >= s.respawnAt) this.enter(s);
        continue;
      }
      const toHero = Math.atan2(hero.y - s.y, hero.x - s.x);
      const chase = toHero + Math.sin(now * 0.001 * WEAVE_RATE + s.weavePhase) * s.weaveAmp;
      s.angle += Phaser.Math.Clamp(angleDelta(s.angle, chase), -ENEMY_TURN * dt, ENEMY_TURN * dt);
      s.vx += (Math.cos(s.angle) * s.speed - s.vx) * k;
      s.vy += (Math.sin(s.angle) * s.speed - s.vy) * k;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.gfx.setPosition(s.x, s.y).setRotation(s.angle);

      // Reached the hero: burst against the shield (white flash, no harm —
      // the demo pilot is having a better run than you will).
      if (Math.hypot(s.x - hero.x, s.y - hero.y) < CONTACT_DIST) {
        this.deps.fx.ring(hero.x, hero.y, 10, 44, 260, 0xffffff, 0.75);
        this.killSwarmer(s, now);
      }
    }

    this.drawBeams(now);
  }

  private fireHero(hero: Hero, target: Swarmer, now: number): void {
    this.shots.push({
      x1: hero.x,
      y1: hero.y,
      x2: target.x,
      y2: target.y,
      tint: HERO_TINT,
      width: 1.6,
      bornAt: now,
    });
    this.deps.fx.sparks(hero.x, hero.y, 3, HERO_TINT, {
      lifeMin: 60,
      lifeMax: 130,
      speedMin: 40,
      speedMax: 120,
    });
    target.hp -= 1;
    if (target.hp <= 0) this.killSwarmer(target, now);
    else {
      const spec = ENEMY_SPECS[target.kind];
      this.deps.fx.sparks(target.x, target.y, 4, spec.tint, { lifeMin: 90, lifeMax: 180 });
    }
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
    this.hero?.gfx.destroy();
    this.hero = null;
    for (const s of this.swarm) s.gfx.destroy();
    this.swarm.length = 0;
    this.shots.length = 0;
    this.beamGfx.destroy();
  }
}
