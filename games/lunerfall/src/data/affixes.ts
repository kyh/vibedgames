import { rand } from "../sys/rng";

export interface Affix {
  id: string;
  name: string;
  tint: number;
  hpMult: number;
  speedMult: number;
  dmgTakenMult: number;
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

export const rollAffix = () => AFFIXES[Math.floor(rand() * AFFIXES.length)] ?? ARMORED;
