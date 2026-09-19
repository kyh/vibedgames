// One brain per bot brawler. Every 0.3s it re-evaluates what to do (escape the
// gas, flee a losing fight, fight, grab a cube, crack a loot box, or wander)
// and plans a tile path toward that goal; every frame it steers the brawler
// along that path (or strafes around its target) and decides when to shoot.

import type { LootBox } from "../combat/combat";
import type { AttackDef } from "../config";
import type { Brawler } from "../entities/brawler";
import type { Game } from "../game";
import { dist, randIn } from "../utils";
import type { Rng } from "../utils";
import type { TileCoord } from "../world/grid";
import { escapeGoal, fleeGoal, nearestBox, nearestCube } from "./goals";
import { BUSH_SIGHT_RANGE, pickTarget, SIGHT_RANGE } from "./targeting";

export { BOT_NOTICE_RANGE, BUSH_SIGHT_RANGE, SIGHT_RANGE } from "./targeting";

export type BotState = "box" | "cube" | "escape" | "fight" | "flee" | "loot" | "wander";

export interface Point {
  x: number;
  z: number;
}

export interface AimSolution {
  dx: number;
  dz: number;
  x: number;
  z: number;
}

interface Decision {
  goal: Point | null;
  state: BotState;
}

const THINK_INTERVAL = 0.3;
const WAYPOINT_REACHED = 0.36;
const STUCK_CHECK_INTERVAL = 0.6;
const STUCK_DISTANCE = 0.14;

/** How far a super is worth throwing: spreads want point blank, leaps their full range. */
const superReach = (def: AttackDef): number => {
  if (def.kind === "spread") {
    return 5;
  }
  if (def.kind === "leap") {
    return def.range;
  }
  return def.range * 0.9;
};

/** Projectile speed used to lead a moving target; leaps carry no projectile. */
const projectileSpeed = (def: AttackDef): number =>
  def.speed !== undefined && def.speed > 0 ? def.speed : 14;

export class Bot {
  game: Game;
  b: Brawler;
  /** The match's seeded stream; a navigator that never decides anything may pass any source. */
  private readonly rng: Rng;
  thinkT: number;
  state: BotState;
  target: Brawler | null;
  box: LootBox | null;
  goal: Point | null;
  path: TileCoord[] | null;
  pathI: number;
  repathT: number;
  strafeDir: number;
  strafeT: number;
  reactT: number;
  shootT: number;
  stuckT: number;
  lastX: number;
  lastZ: number;
  jitterT: number;
  jx: number;
  jz: number;
  wanderT: number;
  wanderGoal: Point | null;
  skill: number;
  thrower: boolean;

  constructor(game: Game, brawler: Brawler, rng: Rng) {
    this.game = game;
    this.b = brawler;
    this.rng = rng;
    this.thinkT = randIn(rng, 0, 0.35);
    this.state = "loot";
    this.target = null;
    this.box = null;
    this.goal = null;
    this.path = null;
    this.pathI = 0;
    this.repathT = 0;
    this.strafeDir = rng() < 0.5 ? 1 : -1;
    this.strafeT = randIn(rng, 0.6, 1.6);
    this.reactT = 0;
    this.shootT = randIn(rng, 0.4, 1);
    this.stuckT = 0;
    this.lastX = brawler.x;
    this.lastZ = brawler.z;
    this.jitterT = 0;
    this.jx = 0;
    this.jz = 0;
    this.wanderT = 0;
    this.wanderGoal = null;
    const [lo, hi] = game.difficulty.skill;
    this.skill = randIn(rng, lo, hi);
    this.thrower = brawler.def.attack.kind === "lob";
  }

  canSee(other: Brawler, range: number): boolean {
    if (range > SIGHT_RANGE || (other.inBush && range > BUSH_SIGHT_RANGE && other.revealT <= 0)) {
      return false;
    }
    if (this.thrower && range < 8) {
      return true;
    }
    return range < 2.5 || this.game.world.hasLineOfSight(this.b.x, this.b.z, other.x, other.z);
  }

  seesBox(box: LootBox): boolean {
    const hit = this.game.world.raycast(this.b.x, this.b.z, box.x, box.z);
    return !hit || (hit.tx === box.tx && hit.ty === box.ty);
  }

  think(): void {
    const { game } = this;
    const { target, range } = pickTarget(this);
    if (target !== this.target) {
      this.reactT = randIn(this.rng, 0.22, 0.5) * (2 - this.skill) * game.difficulty.react;
    }
    this.target = target;
    const { state, goal } = this.decide(target, range);
    if (state !== "box") {
      this.box = null;
    }
    this.state = state;
    this.repathT -= THINK_INTERVAL;
    if (goal) {
      if (
        !this.goal ||
        dist(goal.x, goal.z, this.goal.x, this.goal.z) > 1.4 ||
        this.repathT <= 0 ||
        !this.path
      ) {
        this.planTo(goal);
      }
    } else {
      this.goal = null;
      this.path = null;
    }
  }

  private decide(target: Brawler | null, range: number): Decision {
    const { b, game } = this;
    const { gas, world } = game;
    const gasDepth = gas.active ? gas.depthAt(b.x, b.z) : -99;
    if (gasDepth > -1.6) {
      return { goal: escapeGoal(world, gas, b), state: "escape" };
    }
    if (target) {
      const ownHealth = b.hp / b.maxHp;
      const theirHealth = target.hp / target.maxHp;
      if (ownHealth < 0.42 && theirHealth > ownHealth + 0.05 && range < 9) {
        return { goal: fleeGoal(world, gas, b, target, range), state: "flee" };
      }
      return { goal: null, state: "fight" };
    }
    return this.lootDecision();
  }

  private lootDecision(): Decision {
    const { b, game } = this;
    const cube = nearestCube(game, b);
    if (cube) {
      return { goal: { x: cube.x, z: cube.z }, state: "cube" };
    }
    const box = nearestBox(game, b);
    this.box = box;
    if (box) {
      return { goal: { x: box.x, z: box.z }, state: "box" };
    }
    this.wanderT -= THINK_INTERVAL;
    if (!this.goal || this.wanderT <= 0 || dist(b.x, b.z, this.goal.x, this.goal.z) < 1.2) {
      const reach = Math.max(2, Math.min(game.gas.half - 4, 17));
      this.wanderGoal = game.world.nearestOpen(
        randIn(this.rng, -reach, reach),
        randIn(this.rng, -reach, reach),
      );
      this.wanderT = 7;
    }
    return { goal: this.wanderGoal, state: "wander" };
  }

  planTo(goal: Point): void {
    const { b, game } = this;
    const { world, gas } = game;
    this.goal = goal;
    this.repathT = 1.3;
    // Tiles already inside the gas cost extra so paths skirt the cloud when they can.
    const gasCost = gas.active
      ? (tx: number, ty: number) => (gas.depthAt(world.center(tx), world.center(ty)) > -0.5 ? 6 : 0)
      : undefined;
    this.path = world.findPath(
      world.toTile(b.x),
      world.toTile(b.z),
      world.toTile(goal.x),
      world.toTile(goal.z),
      gasCost,
    );
    this.pathI = 0;
    if (!this.path && this.box) {
      this.box.skipBy = b.id;
      this.box = null;
    }
  }

  private waypoint(index: number): Point | null {
    if (!this.path || index >= this.path.length) {
      return null;
    }
    const step = this.path[index];
    if (!step) {
      return null;
    }
    const { world } = this.game;
    return { x: world.center(step[0]), z: world.center(step[1]) };
  }

  followPath(): [number, number] {
    const { b } = this;
    let next = this.waypoint(this.pathI);
    if (!next) {
      return [0, 0];
    }
    if (dist(b.x, b.z, next.x, next.z) < WAYPOINT_REACHED) {
      this.pathI += 1;
      next = this.waypoint(this.pathI);
      if (!next) {
        return [0, 0];
      }
    }
    const range = dist(b.x, b.z, next.x, next.z) || 1;
    return [(next.x - b.x) / range, (next.z - b.z) / range];
  }

  aimAt(x: number, z: number, vx: number, vz: number, def: AttackDef): AimSolution {
    const { b } = this;
    const range = dist(b.x, b.z, x, z);
    const flight = def.kind === "lob" ? def.flight + def.fuse * 0.7 : range / projectileSpeed(def);
    const lead = 0.8 * this.skill;
    const px = x + vx * flight * lead;
    const pz = z + vz * flight * lead;
    const wobble = (this.rng() - 0.5) * 2 * (0.05 + (1 - this.skill) * 0.3);
    const angle = Math.atan2(px - b.x, pz - b.z) + wobble;
    const reach = dist(b.x, b.z, px, pz);
    return {
      dx: Math.sin(angle),
      dz: Math.cos(angle),
      x: b.x + Math.sin(angle) * reach,
      z: b.z + Math.cos(angle) * reach,
    };
  }

  update(dt: number): void {
    const { b, game } = this;
    if (!b.alive) {
      return;
    }
    if (game.state === "countdown") {
      b.moveX = 0;
      b.moveZ = 0;
      return;
    }
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = THINK_INTERVAL;
      this.think();
    }
    this.reactT = Math.max(0, this.reactT - dt);
    this.shootT -= dt;
    const target = this.target?.alive ? this.target : null;
    const steered = this.steer(dt, target);
    const [ax, az] = this.unstick(dt, steered[0], steered[1]);
    const mag = Math.hypot(ax, az);
    b.moveX = mag > 0.01 ? ax / mag : 0;
    b.moveZ = mag > 0.01 ? az / mag : 0;
    if (target && this.reactT <= 0 && !target.airborne) {
      this.engage(target);
    } else if (
      this.state === "box" &&
      this.box &&
      this.box.alive &&
      this.shootT <= 0 &&
      b.ammo >= 1
    ) {
      this.shootBox(this.box);
    }
  }

  private steer(dt: number, target: Brawler | null): [number, number] {
    const { b } = this;
    if (this.state === "fight" && target) {
      return this.fightMove(dt, target);
    }
    if (this.state === "box" && this.box && this.box.alive) {
      const standOff = Math.min(b.def.attack.range * 0.7, 5);
      if (dist(b.x, b.z, this.box.x, this.box.z) > standOff || !this.seesBox(this.box)) {
        return this.followPath();
      }
      return [0, 0];
    }
    return this.followPath();
  }

  private fightMove(dt: number, target: Brawler): [number, number] {
    const { b, game } = this;
    const range = dist(b.x, b.z, target.x, target.z) || 0.001;
    if (this.thrower || game.world.hasLineOfSight(b.x, b.z, target.x, target.z)) {
      const ux = (target.x - b.x) / range;
      const uz = (target.z - b.z) / range;
      const { preferred } = b.def;
      let approach = 0;
      if (range > preferred + 0.8) {
        approach = 1;
      } else if (range < preferred - 1.2) {
        approach = -1;
      }
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = randIn(this.rng, 0.5, 1.5);
        this.strafeDir *= -1;
      }
      const strafe = preferred < 2.5 ? 0.25 : 0.85;
      return [
        ux * approach + -uz * this.strafeDir * strafe,
        uz * approach + ux * this.strafeDir * strafe,
      ];
    }
    if (!this.path || this.pathI >= this.path.length) {
      this.planTo({ x: target.x, z: target.z });
    }
    return this.followPath();
  }

  /** Detects a brawler pushing against geometry and kicks it sideways for a moment. */
  private unstick(dt: number, ax: number, az: number): [number, number] {
    const { b } = this;
    this.stuckT += dt;
    if (this.stuckT > STUCK_CHECK_INTERVAL) {
      const moved = dist(b.x, b.z, this.lastX, this.lastZ);
      if ((ax !== 0 || az !== 0) && moved < STUCK_DISTANCE) {
        this.jitterT = 0.4;
        const angle = this.rng() * 6.28;
        this.jx = Math.cos(angle);
        this.jz = Math.sin(angle);
        this.strafeDir *= -1;
        this.repathT = 0;
      }
      this.stuckT = 0;
      this.lastX = b.x;
      this.lastZ = b.z;
    }
    if (this.jitterT > 0) {
      this.jitterT -= dt;
      return [this.jx, this.jz];
    }
    return [ax, az];
  }

  private engage(target: Brawler): void {
    const { b, game } = this;
    const { attack } = b.def;
    const range = dist(b.x, b.z, target.x, target.z);
    const canHit = this.thrower
      ? range < attack.range
      : game.world.hasLineOfSight(b.x, b.z, target.x, target.z);
    if (canHit && b.superReady && this.shootT <= 0) {
      this.trySuper(target, range);
    }
    if (canHit && range < attack.range * 0.95 && this.shootT <= 0 && b.ammo >= 1) {
      const aim = this.aimAt(target.x, target.z, target.vel.x, target.vel.y, attack);
      if (b.attack(aim.dx, aim.dz, aim.x, aim.z)) {
        this.shootT =
          (randIn(this.rng, 0.45, 1) + (b.ammo < 1 ? 0.4 : 0)) *
          (target.isHuman ? game.difficulty.cadence : 1);
      }
    }
  }

  private trySuper(target: Brawler, range: number): void {
    const { b } = this;
    const { super: def } = b.def;
    const maxRange = superReach(def);
    const minRange = def.kind === "leap" ? 2.5 : 0;
    if (range < maxRange && range > minRange && this.rng() < 0.6) {
      const aim = this.aimAt(target.x, target.z, target.vel.x, target.vel.y, def);
      if (b.useSuper(aim.dx, aim.dz, aim.x, aim.z)) {
        this.shootT = randIn(this.rng, 0.4, 0.8);
      }
    }
  }

  private shootBox(box: LootBox): void {
    const { b } = this;
    const range = dist(b.x, b.z, box.x, box.z);
    if (range < b.def.attack.range * 0.85 && (this.thrower || this.seesBox(box))) {
      const ux = (box.x - b.x) / (range || 1);
      const uz = (box.z - b.z) / (range || 1);
      if (b.attack(ux, uz, box.x, box.z)) {
        this.shootT = randIn(this.rng, 0.35, 0.7);
      }
    }
  }
}
