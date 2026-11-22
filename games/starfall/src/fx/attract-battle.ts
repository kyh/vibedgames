import type Phaser from "phaser";
import { BlendModes, Math as PhaserMath } from "phaser";

import type { FxPool } from "../render/fx-pool";
import { ENEMY_SPECS } from "../shared/constants";
import type { EnemyKind, Vec } from "../shared/constants";

/** Builds a ship Graphics (delegates to the scene's real makeShipGfx). */
type ShipFactory = (tint: number, level: number) => Phaser.GameObjects.Graphics;

/** The ship hull polygon for a level (delegates to the scene's shipHullPoints). */
type HullPoints = (level: number) => Vec[];

/** Builds an enemy Graphics / hull (delegates to the scene's real enemy art). */
type EnemyFactory = (kind: EnemyKind) => Phaser.GameObjects.Graphics;

type EnemyHull = (kind: EnemyKind) => readonly Vec[];

export interface AttractDeps {
  fx: FxPool;
  makeShip: ShipFactory;
  hullPoints: HullPoints;
  makeEnemy: EnemyFactory;
  enemyHull: EnemyHull;
}

const SWARM_SIZE = 16;

const SWARM_KINDS: readonly { kind: EnemyKind; weight: number; hp: number; speed: number }[] = [
  { hp: 2, kind: "drone", speed: 118, weight: 0.5 },
  { hp: 3, kind: "wasp", speed: 150, weight: 0.3 },
  { hp: 4, kind: "lancer", speed: 92, weight: 0.2 },
];

const HERO_TINT = 0x7f_b2_ff;
const HERO_LEVEL = 3;
const HERO_SPEED = 125;
const HERO_TURN = 3.6;
const VEL_BLEND = 3.2;
const HERO_FIRE_RANGE = 360;
const HERO_FIRE_CD_MIN = 330;
const HERO_FIRE_CD_MAX = 560;
const KITE_DIST = 150;
const BEAM_LIFE_MS = 110;
const ENEMY_TURN = 2.6;
const CONTACT_DIST = 30;
const ENTRY_MARGIN_MIN = 60;
const ENTRY_MARGIN_MAX = 140;
const RESPAWN_MIN_MS = 150;
const RESPAWN_MAX_MS = 600;
const WEAVE_RATE = 2.3;
const EDGE_PAD = 90;

interface Hero {
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
}

interface Swarmer {
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
  respawnAt: number;
}

interface Shot {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  tint: number;
  width: number;
  bornAt: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

const angleDelta = (a: number, b: number) => {
  let d = b - a;

  while (d > Math.PI) {
    d -= Math.PI * 2;
  }

  while (d < -Math.PI) {
    d += Math.PI * 2;
  }

  return d;
};

const rollKind = () => {
  const r = Math.random();
  let acc = 0;

  for (const s of SWARM_KINDS) {
    acc += s.weight;

    if (r < acc) {
      return s;
    }
  }

  const last = SWARM_KINDS.at(-1);

  return last ?? { hp: 2, kind: "drone", speed: 118 };
};

export class AttractBattle {
  private hero: Hero | null = null;
  private readonly swarm: Swarmer[] = [];
  private readonly shots: Shot[] = [];
  private readonly beamGfx: Phaser.GameObjects.Graphics;
  private started = false;
  private readonly scene: Phaser.Scene;
  private readonly deps: AttractDeps;

  constructor(scene: Phaser.Scene, deps: AttractDeps) {
    this.scene = scene;
    this.deps = deps;
    this.beamGfx = scene.add.graphics().setDepth(8).setBlendMode(BlendModes.ADD);
  }

  private seed() {
    if (this.started) {
      return;
    }

    const view = this.scene.cameras.main.worldView;

    if (view.width < 200 || view.height < 200) {
      return;
    }

    this.started = true;

    const { now } = this.scene.time;
    this.hero = {
      angle: rand(-Math.PI, Math.PI),
      fireAt: now + rand(200, 600),
      gfx: this.deps.makeShip(HERO_TINT, HERO_LEVEL).setDepth(9),
      vx: 0,
      vy: 0,
      wpUntil: 0,
      wpX: view.centerX,
      wpY: view.centerY + 100,
      x: view.centerX + rand(-80, 80),
      y: view.centerY + rand(60, 140),
    };

    for (let i = 0; i < SWARM_SIZE; i += 1) {
      const s = this.makeSwarmer();
      s.alive = false;
      s.gfx.setVisible(false);
      s.respawnAt = now + i * rand(120, 320);
      this.swarm.push(s);
    }
  }

  private makeSwarmer() {
    const roll = rollKind();

    return {
      alive: true,
      angle: 0,
      gfx: this.deps.makeEnemy(roll.kind),
      hp: roll.hp,
      kind: roll.kind,
      respawnAt: 0,
      speed: roll.speed,
      vx: 0,
      vy: 0,
      weaveAmp: roll.kind === "wasp" ? 0.55 : 0.22,
      weavePhase: rand(0, Math.PI * 2),
      x: 0,
      y: 0,
    };
  }

  private enter(s: Swarmer) {
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

  private killSwarmer(s: Swarmer, now: number) {
    const spec = ENEMY_SPECS[s.kind];
    this.deps.fx.shatter(s.x, s.y, this.deps.enemyHull(s.kind), s.angle, spec.tint);
    this.deps.fx.sparks(s.x, s.y, 8, spec.tint, { lifeMax: 280, lifeMin: 140 });
    s.alive = false;
    s.gfx.setVisible(false);
    s.respawnAt = now + rand(RESPAWN_MIN_MS, RESPAWN_MAX_MS);
  }

  /** Advance the cosmetic battle one frame. Safe to call every frame while the
   *  start screen is up; no-ops once destroyed. */
  update(dt: number, now: number) {
    this.seed();
    const { hero } = this;

    if (!hero) {
      return;
    }

    const view = this.scene.cameras.main.worldView;

    let nearest: Swarmer | null = null;
    let nearestD = Infinity;
    let packX = 0;
    let packY = 0;
    let packN = 0;

    for (const s of this.swarm) {
      if (!s.alive) {
        continue;
      }

      packX += s.x;
      packY += s.y;
      packN += 1;
      const d = Math.hypot(s.x - hero.x, s.y - hero.y);

      if (d < nearestD) {
        nearestD = d;
        nearest = s;
      }
    }

    let desired: number;

    if (nearest && nearestD < KITE_DIST && packN > 0) {
      desired = Math.atan2(hero.y - packY / packN, hero.x - packX / packN);
    } else {
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

    if (outside) {
      desired = Math.atan2(view.centerY - hero.y, view.centerX - hero.x);
    }

    hero.angle += PhaserMath.Clamp(
      angleDelta(hero.angle, desired),
      -HERO_TURN * dt,
      HERO_TURN * dt,
    );
    const k = 1 - Math.exp(-VEL_BLEND * dt);
    hero.vx += (Math.cos(hero.angle) * HERO_SPEED - hero.vx) * k;
    hero.vy += (Math.sin(hero.angle) * HERO_SPEED - hero.vy) * k;
    hero.x += hero.vx * dt;
    hero.y += hero.vy * dt;
    hero.gfx.setPosition(hero.x, hero.y).setRotation(hero.angle);

    if (nearest && nearestD < HERO_FIRE_RANGE && now >= hero.fireAt) {
      this.fireHero(hero, nearest, now);
      hero.fireAt = now + rand(HERO_FIRE_CD_MIN, HERO_FIRE_CD_MAX);
    }

    this.updateSwarm(hero, k, dt, now);
    this.drawBeams(now);
  }

  private updateSwarm(hero: Hero, k: number, dt: number, now: number) {
    for (const s of this.swarm) {
      if (!s.alive) {
        if (now >= s.respawnAt) {
          this.enter(s);
        }

        continue;
      }

      const toHero = Math.atan2(hero.y - s.y, hero.x - s.x);
      const chase = toHero + Math.sin(now * 0.001 * WEAVE_RATE + s.weavePhase) * s.weaveAmp;
      s.angle += PhaserMath.Clamp(angleDelta(s.angle, chase), -ENEMY_TURN * dt, ENEMY_TURN * dt);
      s.vx += (Math.cos(s.angle) * s.speed - s.vx) * k;
      s.vy += (Math.sin(s.angle) * s.speed - s.vy) * k;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.gfx.setPosition(s.x, s.y).setRotation(s.angle);

      if (Math.hypot(s.x - hero.x, s.y - hero.y) < CONTACT_DIST) {
        this.deps.fx.ring(hero.x, hero.y, 10, 44, 260, 0xff_ff_ff, 0.75);
        this.killSwarmer(s, now);
      }
    }
  }

  private fireHero(hero: Hero, target: Swarmer, now: number) {
    this.shots.push({
      bornAt: now,
      tint: HERO_TINT,
      width: 1.6,
      x1: hero.x,
      x2: target.x,
      y1: hero.y,
      y2: target.y,
    });
    this.deps.fx.sparks(hero.x, hero.y, 3, HERO_TINT, {
      lifeMax: 130,
      lifeMin: 60,
      speedMax: 120,
      speedMin: 40,
    });
    target.hp -= 1;

    if (target.hp <= 0) {
      this.killSwarmer(target, now);
    } else {
      const spec = ENEMY_SPECS[target.kind];
      this.deps.fx.sparks(target.x, target.y, 4, spec.tint, { lifeMax: 180, lifeMin: 90 });
    }
  }

  private drawBeams(now: number) {
    const g = this.beamGfx;
    g.clear();

    for (let i = this.shots.length - 1; i >= 0; i -= 1) {
      const s = this.shots[i];

      if (!s) {
        continue;
      }

      const age = now - s.bornAt;

      if (age >= BEAM_LIFE_MS) {
        this.shots.splice(i, 1);
        continue;
      }

      const a = 1 - age / BEAM_LIFE_MS;
      g.lineStyle(s.width * 3, s.tint, 0.18 * a);
      g.lineBetween(s.x1, s.y1, s.x2, s.y2);
      g.lineStyle(s.width, 0xff_ff_ff, 0.85 * a);
      g.lineBetween(s.x1, s.y1, s.x2, s.y2);
    }
  }

  /** Despawn everything. Called the moment real play begins. */
  destroy() {
    this.hero?.gfx.destroy();
    this.hero = null;

    for (const s of this.swarm) {
      s.gfx.destroy();
    }

    this.swarm.length = 0;
    this.shots.length = 0;
    this.beamGfx.destroy();
  }
}
