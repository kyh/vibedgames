import { rand } from "../sys/rng";

// Elite-room affixes. Every enemy in an elite room rolls one, recolouring it and
// bending its EnemyBody multipliers so the pack fights differently: a wall you
// grind down, a swarm you outrun, or hits you can't facetank. Applied host-side
// at spawn (see spawnEnemies); the tint reads the threat at a glance.
export interface Affix {
  id: string;
  name: string;
  // enemy recolour
  tint: number;
  hpMult: number;
  speedMult: number;
  // <1 = tanky
  dmgTakenMult: number;
  // >1 = hits harder
  dmgOutMult: number;
}

const ARMORED: Affix = {
  dmgOutMult: 1,
  dmgTakenMult: 0.45,
  hpMult: 1.5,
  id: "armored",
  name: "Armored",
  speedMult: 1,
  tint: 0x9f_b4_d8,
};

export const AFFIXES: readonly Affix[] = [
  ARMORED,
  {
    dmgOutMult: 1,
    dmgTakenMult: 1,
    hpMult: 0.9,
    id: "swift",
    name: "Swift",
    speedMult: 1.7,
    tint: 0xff_e1_4a,
  },
  {
    dmgOutMult: 1.5,
    dmgTakenMult: 1,
    hpMult: 1.3,
    id: "brutal",
    name: "Brutal",
    speedMult: 1.1,
    tint: 0xff_5a_5a,
  },
];

export const rollAffix = (): Affix => AFFIXES[Math.floor(rand() * AFFIXES.length)] ?? ARMORED;
