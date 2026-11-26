import type { ReflexInputs } from "@vibedgames/playtest";
import * as THREE from "three";

import { Bot } from "./ai/bot";
import type { Point } from "./ai/bot";
import { escapeGoal, fleeGoal, nearestBox, nearestCube } from "./ai/goals";
import type { AttackDef } from "./config";
import type { Brawler } from "./entities/brawler";
import type { Game } from "./game";
import { canHit, pickBestTarget } from "./playtest-sense";
import { clamp, dist } from "./utils";

type Heading = readonly [number, number];

const STILL: Heading = [0, 0];
const KEY_THRESHOLD = 0.38;
const REPLAN_S = 0.8;
const GOAL_MOVED = 1.4;
const STUCK_CHECK_S = 0.6;
const STUCK_DISTANCE = 0.14;
const SIDESTEP_S = 0.4;
const STRAFE_S = 0.9;
const POINTER_MIN = 0.1;
const POINTER_MAX = 0.9;
const ZONE_EDGE = 6;

const SCRATCH = new THREE.Vector3();

const keysFor = ([x, z]: Heading) => {
  const keys: string[] = [];

  if (x > KEY_THRESHOLD) {
    keys.push("KeyD");
  } else if (x < -KEY_THRESHOLD) {
    keys.push("KeyA");
  }

  if (z > KEY_THRESHOLD) {
    keys.push("KeyS");
  } else if (z < -KEY_THRESHOLD) {
    keys.push("KeyW");
  }

  return keys;
};

const flightTime = (attack: AttackDef, range: number) => {
  if (attack.kind === "lob" || attack.kind === "leap") {
    return attack.flight;
  }

  if (attack.kind === "melee") {
    return attack.windup;
  }

  return range / attack.speed;
};

const axisReach = (from: number, to: number) => {
  if (to > POINTER_MAX) {
    return (POINTER_MAX - from) / (to - from);
  }

  if (to < POINTER_MIN) {
    return (POINTER_MIN - from) / (to - from);
  }

  return 1;
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export class Pilot {
  private nav: Bot | null = null;
  private planned: Point | null = null;
  private plannedAt = 0;
  private strafeDir = 1;
  private strafeAt = 0;
  private checkAt = 0;
  private checkX = 0;
  private checkZ = 0;
  private sidestepUntil = 0;
  private sidestep: Heading = STILL;
  private readonly game: Game;

  constructor(game: Game) {
    this.game = game;
  }

  private navigator(player: Brawler) {
    if (this.nav?.b !== player) {
      this.nav = new Bot(this.game, player, Math.random);
      this.planned = null;
      this.strafeDir = 1;
      this.strafeAt = 0;
      this.checkAt = 0;
      this.sidestepUntil = 0;
    }

    return this.nav;
  }

  private screenPoint(x: number, z: number) {
    SCRATCH.set(x, this.game.world.heightAt(x, z) + 0.5, z).project(this.game.camera);

    return [(SCRATCH.x + 1) / 2, (1 - SCRATCH.y) / 2] satisfies [number, number];
  }

  private pointerAt(player: Brawler, x: number, z: number, down: boolean) {
    const [px, py] = this.screenPoint(player.x, player.z);
    const [tx, ty] = this.screenPoint(x, z);
    const reach = clamp(Math.min(axisReach(px, tx), axisReach(py, ty)), 0, 1);

    return {
      down,
      x: round3(clamp(px + (tx - px) * reach, POINTER_MIN, POINTER_MAX)),
      y: round3(clamp(py + (ty - py) * reach, POINTER_MIN, POINTER_MAX)),
    };
  }

  private aimAtBrawler(player: Brawler, target: Brawler) {
    const { attack } = player.def;
    const lead = flightTime(attack, dist(player.x, player.z, target.x, target.z)) * 0.8;
    const x = target.x + target.vel.x * lead;
    const z = target.z + target.vel.y * lead;
    const fire = player.ammo >= 1 && canHit(this.game, player, target.x, target.z);

    return this.pointerAt(player, x, z, fire);
  }

  private walkTo(player: Brawler, goal: Point) {
    const nav = this.navigator(player);
    const now = this.game.elapsed;

    const stale =
      !this.planned ||
      !nav.path ||
      now - this.plannedAt > REPLAN_S ||
      dist(goal.x, goal.z, this.planned.x, this.planned.z) > GOAL_MOVED;

    if (stale) {
      nav.planTo(goal);
      this.planned = goal;
      this.plannedAt = now;
    }

    const [x, z] = nav.followPath();

    if (x !== 0 || z !== 0) {
      return [x, z] satisfies Heading;
    }

    const range = dist(player.x, player.z, goal.x, goal.z);

    return (
      range < 0.3 ? STILL : [(goal.x - player.x) / range, (goal.z - player.z) / range]
    ) satisfies Heading;
  }

  private unstick(player: Brawler, heading: Heading) {
    const now = this.game.elapsed;

    if (now - this.checkAt > STUCK_CHECK_S) {
      const moved = dist(player.x, player.z, this.checkX, this.checkZ);

      if ((heading[0] !== 0 || heading[1] !== 0) && moved < STUCK_DISTANCE) {
        this.sidestep = [-heading[1] * this.strafeDir, heading[0] * this.strafeDir];
        this.sidestepUntil = now + SIDESTEP_S;
        this.strafeDir *= -1;
        this.planned = null;
      }

      this.checkAt = now;
      this.checkX = player.x;
      this.checkZ = player.z;
    }

    return now < this.sidestepUntil ? this.sidestep : heading;
  }

  private duel(player: Brawler, target: Brawler) {
    const range = dist(player.x, player.z, target.x, target.z) || 0.001;
    const ux = (target.x - player.x) / range;
    const uz = (target.z - player.z) / range;
    const { preferred } = player.def;
    let approach = 0;

    if (range > preferred + 0.8) {
      approach = 1;
    } else if (range < preferred - 1.2) {
      approach = -1;
    }

    const now = this.game.elapsed;

    if (now - this.strafeAt > STRAFE_S) {
      this.strafeAt = now;
      this.strafeDir *= -1;
    }

    const strafe = preferred < 2.5 ? 0.25 : 0.85;

    return [
      ux * approach - uz * this.strafeDir * strafe,
      uz * approach + ux * this.strafeDir * strafe,
    ] satisfies Heading;
  }

  private nearestStanding(player: Brawler) {
    let best: Brawler | null = null;
    let bestRange = Number.POSITIVE_INFINITY;

    for (const other of this.game.brawlers) {
      const range = dist(player.x, player.z, other.x, other.z);

      if (other !== player && other.alive && !other.hidden && range < bestRange) {
        best = other;
        bestRange = range;
      }
    }

    return best;
  }

  private inputs(player: Brawler, heading: Heading, target: Brawler | null) {
    return {
      keys: keysFor(this.unstick(player, heading)),
      pointer: target ? this.aimAtBrawler(player, target) : null,
    };
  }

  private livePlayer() {
    const { player, state } = this.game;

    if (player?.alive !== true || state !== "playing") {
      return null;
    }

    this.navigator(player);

    return player;
  }

  private safeGoal(player: Brawler) {
    const { gas, world } = this.game;

    return -gas.depthAt(player.x, player.z) < ZONE_EDGE
      ? escapeGoal(world, gas, player)
      : world.nearestOpen(0, 0);
  }

  readonly fight = () => {
    const player = this.livePlayer();

    if (!player) {
      return { keys: [] } satisfies ReflexInputs;
    }

    const target = pickBestTarget(this.game, player);

    if (target && canHit(this.game, player, target.x, target.z)) {
      return this.inputs(player, this.duel(player, target), target) satisfies ReflexInputs;
    }

    const quarry = target ?? this.nearestStanding(player);
    const goal = quarry ? { x: quarry.x, z: quarry.z } : this.safeGoal(player);

    return this.inputs(player, this.walkTo(player, goal), target) satisfies ReflexInputs;
  };

  readonly loot = () => {
    const { game } = this;
    const player = this.livePlayer();

    if (!player) {
      return { keys: [] } satisfies ReflexInputs;
    }

    const target = pickBestTarget(game, player);
    const threat = target && canHit(game, player, target.x, target.z) ? target : null;
    const cube = nearestCube(game, player);

    if (cube) {
      return this.inputs(player, this.walkTo(player, cube), threat) satisfies ReflexInputs;
    }

    const box = nearestBox(game, player);

    if (!box) {
      return this.inputs(
        player,
        this.walkTo(player, this.safeGoal(player)),
        threat,
      ) satisfies ReflexInputs;
    }

    const standOff = Math.min(player.def.attack.range * 0.7, 5);

    const inReach =
      dist(player.x, player.z, box.x, box.z) <= standOff &&
      (player.def.attack.kind === "lob" || this.navigator(player).seesBox(box));

    const heading = inReach ? STILL : this.walkTo(player, box);

    if (threat || !inReach) {
      return this.inputs(player, heading, threat) satisfies ReflexInputs;
    }

    return {
      keys: keysFor(heading),
      pointer: this.pointerAt(player, box.x, box.z, player.ammo >= 1),
    } satisfies ReflexInputs;
  };

  readonly flee = () => {
    const { game } = this;
    const player = this.livePlayer();

    if (!player) {
      return { keys: [] } satisfies ReflexInputs;
    }

    const target = pickBestTarget(game, player);

    const goal = target
      ? fleeGoal(game.world, game.gas, player, target, dist(player.x, player.z, target.x, target.z))
      : this.safeGoal(player);

    return this.inputs(player, this.walkTo(player, goal), target) satisfies ReflexInputs;
  };

  readonly toZone = () => {
    const player = this.livePlayer();

    if (!player) {
      return { keys: [] } satisfies ReflexInputs;
    }

    const target = pickBestTarget(this.game, player);

    return this.inputs(
      player,
      this.walkTo(player, this.safeGoal(player)),
      target,
    ) satisfies ReflexInputs;
  };
}
