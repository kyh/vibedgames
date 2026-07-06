import type { EnemyName } from "./animations";

export type Behavior = "melee" | "charger" | "archer" | "bomber";

export type EnemyKind = {
  name: EnemyName;
  behavior: Behavior;
  hp: number;
  speed: number; // walk px/s
  contactDmg: number; // touch damage (0 = harmless to touch)
  hw: number; // body half-width
  h: number; // body height
  stopAtLedge: boolean;
  // melee / charger attack
  attackRange?: number;
  attackDmg?: number;
  attackKb?: number;
  windup?: number;
  active?: number;
  recover?: number;
  cooldown?: number;
  // charger
  chargeSpeed?: number;
  chargeTime?: number;
  // archer
  shootRange?: number;
  projSpeed?: number;
  // bomber
  fuse?: number;
  blastR?: number;
  blastDmg?: number;
};

export const ENEMIES: Record<EnemyName, EnemyKind> = {
  warrior: {
    name: "warrior",
    behavior: "melee",
    hp: 2,
    speed: 54,
    contactDmg: 1,
    hw: 9,
    h: 26,
    stopAtLedge: true,
    attackRange: 22,
    attackDmg: 1,
    attackKb: 130,
    windup: 0.3,
    active: 0.12,
    recover: 0.3,
    cooldown: 0.7,
  },
  spearman: {
    name: "spearman",
    behavior: "charger",
    hp: 2,
    speed: 46,
    contactDmg: 1,
    hw: 11,
    h: 26,
    stopAtLedge: false,
    attackRange: 78,
    attackDmg: 1,
    attackKb: 170,
    windup: 0.42,
    recover: 0.5,
    cooldown: 1.1,
    chargeSpeed: 235,
    chargeTime: 0.45,
  },
  archer: {
    name: "archer",
    behavior: "archer",
    hp: 1,
    speed: 48,
    contactDmg: 1,
    hw: 9,
    h: 26,
    stopAtLedge: true,
    shootRange: 155,
    windup: 0.46,
    cooldown: 1.3,
    projSpeed: 175,
    attackDmg: 1,
  },
  bomber: {
    name: "bomber",
    behavior: "bomber",
    hp: 1,
    speed: 92,
    contactDmg: 0,
    hw: 8,
    h: 24,
    stopAtLedge: false,
    fuse: 0.55,
    blastR: 34,
    blastDmg: 2,
  },
};
