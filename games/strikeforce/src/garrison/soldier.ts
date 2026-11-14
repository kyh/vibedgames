// One of the garrison's soldiers as the core sees an enemy: a kind, a position,
// alive or not, and `damage()` for the player's shots and blasts. The brain
// decides what it does; the model shows it.
import { Vector3 } from "three";

import type { Enemy } from "../core/types";
import { SoldierBrain } from "../soldier/soldier-brain";
import type { Orders, World } from "../soldier/soldier-brain";
import type { SoldierModel } from "../soldier/soldier-model";
import type { Fielded, Role } from "./roles";

/**
 * A rifle headshot (26, the core's ×2.2 for a weak point, then this) drops a
 * rifleman on every difficulty (Brutal's is 133); a heavy's helmet takes two.
 */
const HEADSHOT_BONUS = 2.5;

export interface SoldierEvents {
  hurt: (soldier: Soldier, from: Vector3) => void;
  killed: (soldier: Soldier) => void;
}

export class Soldier implements Enemy {
  /** The core's audio and kill feed treat a soldier as a person, not a machine. */
  readonly soldier = true;
  readonly type: Role;
  readonly callsign: string;
  readonly brain: SoldierBrain;
  readonly model: SoldierModel;
  /** Where it was posted: an unalerted soldier patrols around here. */
  readonly home = new Vector3();
  alive = true;
  hp: number;
  /** Seconds since it went down. */
  downFor = 0;
  /** Had it seen the player by the last frame? */
  spotted = false;
  private readonly events: SoldierEvents;

  constructor(
    id: string,
    type: Role,
    fielded: Fielded,
    world: World,
    model: SoldierModel,
    events: SoldierEvents,
  ) {
    this.type = type;
    this.callsign = fielded.label;
    this.hp = fielded.hp;
    this.brain = new SoldierBrain(id, world, fielded.profile);
    this.model = model;
    this.events = events;
  }

  get pos(): Vector3 {
    return this.brain.pos;
  }

  damage(amount: number, point: Vector3, dir: Vector3, part: string): boolean {
    if (!this.alive) {
      return false;
    }
    this.hp -= part === "weak" ? amount * HEADSHOT_BONUS : amount;
    this.model.hit(point, dir);
    if (this.hp > 0) {
      // A hit comes from back along the shot.
      this.events.hurt(this, point.clone().addScaledVector(dir, -20));
      return false;
    }
    this.alive = false;
    this.events.killed(this);
    return true;
  }

  /** Down: hand back any right to fire. */
  standDown(orders: Orders): void {
    this.brain.stop(orders);
  }
}
