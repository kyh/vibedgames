// The dock's crew in Mission and Holdout: soldiers, in place of the machines
// the core shipped with. It is the core's enemies module (`G.enemies`, handed
// over at boot through `CoreModules`), so the core's director keeps running
// everything around it — patrols, waves, pursuit, relays, extraction, Holdout
// scoring — and only who turns up has changed.
//
// Soldiers patrol around their post until they see the player (200 degrees
// ahead) or hear a shot, then fight with the shared soldier brain. Only a few
// may fire at once (TUNE's attack tokens), so a crowd presses rather than
// shreds; a hit or a squadmate going down brings the others near it to look.
import { Raycaster } from "three";
import type { Mesh, Object3D, Vector3 } from "three";

import type { Enemies, EnemyHit, StrikeforceGame } from "../core/types";
import type { Combatant, Orders, Shot } from "../soldier/soldier-brain";
import { showShot } from "../soldier/gunfire";
import { SoldierModel } from "../soldier/soldier-model";
import { baseTune, field, roleOf } from "./roles";
import { Soldier } from "./soldier";
import type { SoldierEvents } from "./soldier";

const PLAYER = "player";
/** Seconds a body stays down before it is cleared away. */
const CORPSE_SECONDS = 8;
/** Squadmates this close to a hit or a death come to look. */
const SQUAD_RADIUS = 16;
/** How far a patrol strays from its post. */
const PATROL_RADIUS = 10;

const yawTo = (a: Vector3, b: Vector3): number => Math.atan2(-(b.x - a.x), -(b.z - a.z));

const pose = (soldier: Soldier, dt: number): void => {
  const { brain } = soldier;
  soldier.model.update(
    {
      aiming: brain.target !== null,
      alive: soldier.alive,
      crouch: 0,
      pitch: brain.pitch,
      x: brain.pos.x,
      y: brain.pos.y,
      yaw: brain.yaw,
      z: brain.pos.z,
    },
    dt,
  );
};

export class Garrison implements Enemies {
  readonly TUNE = baseTune();
  readonly list: Soldier[] = [];
  readonly stub = false;
  private readonly game: StrikeforceGame;
  private readonly byId = new Map<string, Soldier>();
  /** Who holds an attack token. */
  private readonly firing = new Set<string>();
  private lastGrant = -Infinity;
  private clock = 0;
  private serial = 0;
  private hearing = 0;
  private people: Combatant[] = [];
  private readonly ray = new Raycaster();
  private readonly orders: Orders = {
    ceaseFire: (brain) => {
      this.firing.delete(brain.id);
    },
    fire: (shot) => this.fire(shot),
    mayOpenFire: (brain) => this.grant(brain.id),
    wander: (brain) => {
      const post = this.byId.get(brain.id)?.home ?? brain.pos;
      return this.game.physics.nav.randomPoint(post, PATROL_RADIUS);
    },
  };
  private readonly squad: SoldierEvents = {
    hurt: (soldier, from) => {
      soldier.brain.investigate(from);
      this.rally(soldier, from);
    },
    killed: (soldier) => {
      soldier.standDown(this.orders);
      this.rally(soldier, this.game.player.pos);
      this.game.events.emit("enemy:killed", {
        enemy: soldier,
        pos: soldier.pos,
        type: soldier.type,
      });
    },
  };

  constructor(game: StrikeforceGame) {
    this.game = game;
    game.events.on("weapon:fire", (shot) => {
      if (this.hearing > 0) {
        return;
      }
      this.hearing = 0.3;
      this.alert(shot.origin, this.TUNE.hearRadius);
    });
    game.events.on("explosion", ({ pos }) => {
      if (pos) {
        this.alert(pos, 30);
      }
    });
    game.events.on("game:state", ({ state }) => {
      if (state === "title") {
        this.clear();
      }
    });
  }

  spawn(type: string, pos: Vector3, options?: { state?: string; target?: Vector3 }): Soldier {
    const { physics, player, scene } = this.game;
    const role = roleOf(type);
    const fielded = field(role, this.TUNE);
    this.serial += 1;
    const id = `crew:${this.serial}`;
    const model = new SoldierModel("garrison", `${fielded.label}-${this.serial}`);
    const soldier = new Soldier(id, role, fielded, physics, model, this.squad);
    // The director picks some posts in the air (they were for flyers): stand
    // on the ground beneath, or the nearest walkable spot.
    const at = physics.nav.isWalkable(pos.x, pos.z) ? pos.clone() : physics.nav.randomPoint(pos, 4);
    at.y = physics.groundHeight(at.x, at.z, 1.5);
    soldier.brain.place(at, yawTo(at, player.pos), this.orders);
    soldier.home.copy(at);
    if (options?.state === "alert") {
      soldier.brain.investigate(options.target ?? player.pos);
    }
    scene.add(model.root);
    this.list.push(soldier);
    this.byId.set(id, soldier);
    pose(soldier, 0);
    return soldier;
  }

  update(dt: number): void {
    this.clock += dt;
    this.hearing -= dt;
    const { player } = this.game;
    this.people = player.alive
      ? [
          {
            crouch: player.crouching,
            id: PLAYER,
            moving: Math.hypot(player.vel.x, player.vel.z) > 2,
            pos: player.pos,
          },
        ]
      : [];
    const cleared: Soldier[] = [];
    for (const soldier of this.list) {
      if (soldier.alive) {
        soldier.brain.update(dt, this.people, this.orders);
        this.watchSpotted(soldier);
      } else {
        soldier.downFor += dt;
        if (soldier.downFor > CORPSE_SECONDS) {
          cleared.push(soldier);
        }
      }
      pose(soldier, dt);
    }
    for (const soldier of cleared) {
      this.remove(soldier);
    }
  }

  raycast(origin: Vector3, dir: Vector3, maxDist: number): EnemyHit | null {
    const boxes: Mesh[] = [];
    const owner = new Map<Object3D, Soldier>();
    for (const soldier of this.list) {
      if (!soldier.alive) {
        continue;
      }
      soldier.model.root.updateMatrixWorld(true);
      for (const box of soldier.model.hitboxes) {
        boxes.push(box);
        owner.set(box, soldier);
      }
    }
    if (boxes.length === 0) {
      return null;
    }
    this.ray.set(origin, dir);
    this.ray.far = maxDist;
    const [hit] = this.ray.intersectObjects(boxes, false);
    const enemy = hit ? owner.get(hit.object) : undefined;
    if (!hit || !enemy) {
      return null;
    }
    return {
      dist: hit.distance,
      enemy,
      normal: hit.face
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
        : dir.clone().negate(),
      part: hit.object.userData.part === "head" ? "weak" : "body",
      point: hit.point.clone(),
    };
  }

  aliveCount(): number {
    return this.list.reduce((n, s) => n + (s.alive ? 1 : 0), 0);
  }

  clear(): void {
    for (const soldier of this.list) {
      soldier.standDown(this.orders);
      soldier.model.dispose();
    }
    this.list.length = 0;
    this.byId.clear();
    this.firing.clear();
  }

  alert(pos: Vector3, radius: number): void {
    for (const soldier of this.list) {
      if (soldier.alive && soldier.pos.distanceTo(pos) < radius) {
        soldier.brain.investigate(pos);
      }
    }
  }

  /** Whether `id` may open a burst: a few at a time, a beat apart. */
  private grant(id: string): boolean {
    if (this.firing.has(id)) {
      return true;
    }
    const { TUNE } = this;
    const limit = this.aliveCount() > 5 ? TUNE.maxTokensCrowd : TUNE.maxTokens;
    if (this.firing.size >= limit || this.clock - this.lastGrant < TUNE.tokenGap) {
      return false;
    }
    this.firing.add(id);
    this.lastGrant = this.clock;
    return true;
  }

  private fire(shot: Shot): void {
    const soldier = this.byId.get(shot.shooter);
    if (!soldier) {
      return;
    }
    soldier.model.fire();
    const muzzle = soldier.model.muzzle(shot.muzzle);
    showShot(this.game, muzzle, shot.end);
    this.game.events.emit("enemy:fire", { enemy: soldier, pos: muzzle, type: soldier.type });
    const { player } = this.game;
    if (shot.victim === PLAYER && player.alive) {
      player.damage(shot.damage, muzzle);
    }
  }

  /** The first sight of the player: the director's "contact" call. */
  private watchSpotted(soldier: Soldier): void {
    const spotted = soldier.brain.target !== null;
    if (spotted && !soldier.spotted) {
      this.game.events.emit("enemy:alert", {
        enemy: soldier,
        pos: soldier.pos,
        type: soldier.type,
      });
    }
    soldier.spotted = spotted;
  }

  /** Squadmates near `soldier` come to look at `at`. */
  private rally(soldier: Soldier, at: Vector3): void {
    for (const other of this.list) {
      if (other !== soldier && other.alive && other.pos.distanceTo(soldier.pos) < SQUAD_RADIUS) {
        other.brain.investigate(at);
      }
    }
  }

  private remove(soldier: Soldier): void {
    soldier.model.dispose();
    this.list.splice(this.list.indexOf(soldier), 1);
    this.byId.delete(soldier.brain.id);
  }
}
