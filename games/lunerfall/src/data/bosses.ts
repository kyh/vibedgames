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
export type BossKind = {
  name: string;
  tint: number; // salamander recolour for this biome
  hpMul: number; // scales the base HP curve
  cd: readonly [number, number]; // attack cooldown [phase 1, phase 2]
  waveSpeed: number; // ground-wave projectile speed
  fan: number; // waves emitted per cast (1 = single, 3 = spread fan)
  slamR: number; // jump-slam blast radius
  ranged: boolean; // favours waves and holds distance
  charges: boolean; // adds the horizontal lunge attack
  adds: readonly EnemyName[]; // phase-2 summons
  banner: string; // shown when the fight begins
};

const SALAMANDER: BossKind = {
  name: "SALAMANDER",
  tint: 0xffffff,
  hpMul: 1,
  cd: [1.15, 0.7],
  waveSpeed: 150,
  fan: 1,
  slamR: 46,
  ranged: false,
  charges: false,
  adds: ["warrior", "archer"],
  banner: "SALAMANDER",
};

export const BOSS_KINDS: readonly BossKind[] = [
  SALAMANDER,
  {
    name: "CINDERKING",
    tint: 0xff8a52,
    hpMul: 1.0,
    cd: [0.85, 0.55],
    waveSpeed: 182,
    fan: 3,
    slamR: 52,
    ranged: false,
    charges: false,
    adds: ["bomber", "bomber"],
    banner: "CINDERKING · relentless flame",
  },
  {
    name: "RIMEWARDEN",
    tint: 0x8fd0ff,
    hpMul: 0.95,
    cd: [0.9, 0.68],
    waveSpeed: 224,
    fan: 2,
    slamR: 40,
    ranged: true,
    charges: false,
    adds: ["archer", "archer"],
    banner: "RIMEWARDEN · frost barrage",
  },
  {
    name: "BLIGHTMAW",
    tint: 0x9cff5a,
    hpMul: 1.15,
    cd: [1.0, 0.62],
    waveSpeed: 150,
    fan: 1,
    slamR: 58,
    ranged: false,
    charges: true,
    adds: ["spearman", "spearman"],
    banner: "BLIGHTMAW · venom charge",
  },
  {
    name: "VOID SOVEREIGN",
    tint: 0xc86aff,
    hpMul: 1.28,
    cd: [0.8, 0.5],
    waveSpeed: 205,
    fan: 3,
    slamR: 50,
    ranged: true,
    charges: true,
    adds: ["warrior", "spearman", "archer"],
    banner: "VOID SOVEREIGN · all is dust",
  },
];

export const bossKind = (biome: number): BossKind => {
  const i = (((Math.floor(biome) - 1) % BOSS_KINDS.length) + BOSS_KINDS.length) % BOSS_KINDS.length;
  return BOSS_KINDS[i] ?? SALAMANDER;
};
