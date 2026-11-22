import type { EnemyName } from "./animations";

export interface BossKind {
  name: string;
  tint: number;
  hpMul: number;
  cd: readonly [number, number];
  waveSpeed: number;
  fan: number;
  slamR: number;
  ranged: boolean;
  charges: boolean;
  adds: readonly EnemyName[];
  banner: string;
}

const SALAMANDER: BossKind = {
  adds: ["warrior", "archer"],
  banner: "SALAMANDER",
  cd: [1.15, 0.7],
  charges: false,
  fan: 1,
  hpMul: 1,
  name: "SALAMANDER",
  ranged: false,
  slamR: 46,
  tint: 0xff_ff_ff,
  waveSpeed: 150,
};

export const BOSS_KINDS: readonly BossKind[] = [
  SALAMANDER,
  {
    adds: ["bomber", "bomber"],
    banner: "CINDERKING · relentless flame",
    cd: [0.85, 0.55],
    charges: false,
    fan: 3,
    hpMul: 1,
    name: "CINDERKING",
    ranged: false,
    slamR: 52,
    tint: 0xff_8a_52,
    waveSpeed: 182,
  },
  {
    adds: ["archer", "archer"],
    banner: "RIMEWARDEN · frost barrage",
    cd: [0.9, 0.68],
    charges: false,
    fan: 2,
    hpMul: 0.95,
    name: "RIMEWARDEN",
    ranged: true,
    slamR: 40,
    tint: 0x8f_d0_ff,
    waveSpeed: 224,
  },
  {
    adds: ["spearman", "spearman"],
    banner: "BLIGHTMAW · venom charge",
    cd: [1, 0.62],
    charges: true,
    fan: 1,
    hpMul: 1.15,
    name: "BLIGHTMAW",
    ranged: false,
    slamR: 58,
    tint: 0x9c_ff_5a,
    waveSpeed: 150,
  },
  {
    adds: ["warrior", "spearman", "archer"],
    banner: "VOID SOVEREIGN · all is dust",
    cd: [0.8, 0.5],
    charges: true,
    fan: 3,
    hpMul: 1.28,
    name: "VOID SOVEREIGN",
    ranged: true,
    slamR: 50,
    tint: 0xc8_6a_ff,
    waveSpeed: 205,
  },
];

export const bossKind = (biome: number) => {
  const i = (((Math.floor(biome) - 1) % BOSS_KINDS.length) + BOSS_KINDS.length) % BOSS_KINDS.length;

  return BOSS_KINDS[i] ?? SALAMANDER;
};
