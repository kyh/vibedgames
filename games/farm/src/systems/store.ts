// Shared persistent player state. Lives across scenes (farm <-> mine) so both
// read/write the same inventory, skills, gold and vitals. The World and the
// day/time clock stay owned by GameScene; only player-carried state is here.

import { Inventory } from "./inventory";
import { Skills } from "./skills";
import type { AnimalSave } from "./save";
import { MAX_HP, MAX_ENERGY, START_GOLD } from "../config";

class Store {
  inv: Inventory = Inventory.fresh();
  skills: Skills = Skills.fresh();
  gold = START_GOLD;
  energy = MAX_ENERGY;
  hp = MAX_HP;

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
    this.gold = START_GOLD;
    this.energy = MAX_ENERGY;
    this.hp = MAX_HP;
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
