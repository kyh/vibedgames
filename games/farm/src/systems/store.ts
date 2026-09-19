// Shared persistent player state. Lives across scenes (farm <-> mine) so both
// read/write the same inventory, skills, gold and vitals. The World and the
// day/time clock stay owned by GameScene; only player-carried state is here.

import { Inventory } from "./inventory";
import { Skills } from "./skills";
import { Collections } from "./collections";
import type { AnimalSave } from "./save";
import { MAX_HP, MAX_ENERGY, START_GOLD } from "../config";

/**
 * Finished farm work this session. The purse is spent as well as earned, so
 * this — not `gold` — is the only number that rises with every real step of
 * play; diagnostics publish it as the objective. Never saved.
 */
export interface Work {
  felled: number;
  foraged: number;
  goldEarned: number;
  harvested: number;
  planted: number;
  quarried: number;
  tilled: number;
  watered: number;
}

const freshWork = (): Work => ({
  felled: 0,
  foraged: 0,
  goldEarned: 0,
  harvested: 0,
  planted: 0,
  quarried: 0,
  tilled: 0,
  watered: 0,
});

export const workScore = (w: Work): number =>
  w.tilled +
  w.planted +
  w.watered +
  w.foraged * 2 +
  (w.felled + w.quarried) * 3 +
  w.harvested * 5 +
  w.goldEarned;

class Store {
  inv: Inventory = Inventory.fresh();
  skills: Skills = Skills.fresh();
  collections = Collections.empty();
  gold = START_GOLD;
  energy = MAX_ENERGY;
  hp = MAX_HP;
  work = freshWork();

  // persistent across scenes (farm <-> mine)
  animals: AnimalSave[] = [];
  animalSeq = 1;
  npcFriendship: Record<string, number> = {};

  maxHp(): number {
    return MAX_HP + this.skills.bonusMaxHp();
  }

  initNew(): void {
    this.inv = Inventory.fresh();
    this.skills = Skills.fresh();
    this.collections = Collections.empty();
    this.gold = START_GOLD;
    this.energy = MAX_ENERGY;
    this.hp = MAX_HP;
    this.work = freshWork();
    this.animals = [];
    this.animalSeq = 1;
    this.npcFriendship = {};
  }

  animalSave(): AnimalSave[] {
    return this.animals;
  }
  loadAnimals(a: AnimalSave[], seq: number): void {
    this.animals = a;
    this.animalSeq = seq;
  }

  spendEnergy(n: number): void {
    this.energy = Math.max(0, this.energy - n);
  }
  damage(n: number): void {
    this.hp = Math.max(0, this.hp - n);
  }
}

export const store = new Store();
