import type { EnemyName } from "./animations";

// A distinct boss per biome. All share the salamander silhouette (the pack's only
// boss art) recoloured per biome, but each has its own HP, rhythm, projectile
// pattern and summons, so the fight changes as you descend:
//   1 Salamander  — balanced, the original three-move set
//   2 Cinderking  — relentless: fast triple-wave fans, bomber adds
//   3 Rimewarden  — zoner: keeps distance, fast wave barrages, archer adds
//   4 Blightmaw   — bruiser: charges across the arena, wide slams, spearman adds
//   5 Void Sovereign — chaotic apex: tanky, charges AND fans, mixed adds
// Beyond biome 5 the table cycles.
export interface BossKind {
  name: string;
  // salamander recolour for this biome
  tint: number;
  // scales the base HP curve
  hpMul: number;
  // attack cooldown [phase 1, phase 2]
  cd: readonly [number, number];
  // ground-wave projectile speed
  waveSpeed: number;
  // waves emitted per cast (1 = single, 3 = spread fan)
  fan: number;
  // jump-slam blast radius
  slamR: number;
  // favours waves and holds distance
  ranged: boolean;
  // adds the horizontal lunge attack
  charges: boolean;
  // phase-2 summons
  adds: readonly EnemyName[];
  // shown when the fight begins
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

export const bossKind = (biome: number): BossKind => {
  const i = (((Math.floor(biome) - 1) % BOSS_KINDS.length) + BOSS_KINDS.length) % BOSS_KINDS.length;
  return BOSS_KINDS[i] ?? SALAMANDER;
};
