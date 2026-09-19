import type { EnemyName } from "./animations";

export type Behavior = "melee" | "charger" | "archer" | "bomber";

export interface EnemyKind {
  name: EnemyName;
  behavior: Behavior;
  hp: number;
  // walk px/s
  speed: number;
  // touch damage (0 = harmless to touch)
  contactDmg: number;
  // body half-width
  hw: number;
  // body height
  h: number;
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
}

export const ENEMIES = {
  archer: {
    attackDmg: 1,
    behavior: "archer",
    contactDmg: 1,
    cooldown: 1.3,
    h: 26,
    hp: 1,
    hw: 9,
    name: "archer",
    projSpeed: 175,
    shootRange: 155,
    speed: 48,
    stopAtLedge: true,
    windup: 0.46,
  },
  bomber: {
    behavior: "bomber",
    blastDmg: 2,
    blastR: 34,
    contactDmg: 0,
    fuse: 0.55,
    h: 24,
    hp: 1,
    hw: 8,
    name: "bomber",
    speed: 92,
    stopAtLedge: false,
  },
  spearman: {
    attackDmg: 1,
    attackKb: 170,
    attackRange: 78,
    behavior: "charger",
    chargeSpeed: 235,
    chargeTime: 0.45,
    contactDmg: 1,
    cooldown: 1.1,
    h: 26,
    hp: 2,
    hw: 11,
    name: "spearman",
    recover: 0.5,
    speed: 46,
    stopAtLedge: false,
    windup: 0.42,
  },
  warrior: {
    active: 0.12,
    attackDmg: 1,
    attackKb: 130,
    attackRange: 22,
    behavior: "melee",
    contactDmg: 1,
    cooldown: 0.7,
    h: 26,
    hp: 2,
    hw: 9,
    name: "warrior",
    recover: 0.3,
    speed: 54,
    stopAtLedge: true,
    windup: 0.3,
  },
} satisfies Record<EnemyName, EnemyKind>;
