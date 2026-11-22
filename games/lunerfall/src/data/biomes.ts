import { ENEMY_NAMES } from "./animations";
import type { EnemyName } from "./animations";

export interface BiomePalette {
  name: string;
  sky: readonly [number, number, number];
  horizon: number;
  tile: number;
  oneway: number;
  tree: number;
  fog: number;
  fogA: number;
  roster: Readonly<Record<EnemyName, number>>;
}

const MOONWOOD: BiomePalette = {
  fog: 0x00_00_00,
  fogA: 0,
  horizon: 0x7a_86_9c,
  name: "MOONWOOD",
  oneway: 0xe8_3f_a0,
  roster: { archer: 20, bomber: 10, spearman: 20, warrior: 44 },
  sky: [0x46_4f_66, 0x59_63_7b, 0x6b_76_8e],
  tile: 0xff_ff_ff,
  tree: 0xff_ff_ff,
};

export const BIOMES: readonly BiomePalette[] = [
  MOONWOOD,
  {
    fog: 0xff_5a_2a,
    fogA: 0.1,
    horizon: 0x9a_5c_46,
    name: "EMBERDEEP",
    oneway: 0xff_7a_3c,
    roster: { archer: 14, bomber: 36, spearman: 16, warrior: 30 },
    sky: [0x35_1f_28, 0x5a_2f_33, 0x80_4a_3c],
    tile: 0xe0_99_7a,
    tree: 0xcc_6a_48,
  },
  {
    fog: 0x8f_d6_ff,
    fogA: 0.09,
    horizon: 0x9a_b8_ce,
    name: "FROSTVAULT",
    oneway: 0x5c_c8_ff,
    roster: { archer: 40, bomber: 10, spearman: 16, warrior: 30 },
    sky: [0x2b_3a_50, 0x3f_5a_76, 0x6e_90_ac],
    tile: 0xbc_d8_ea,
    tree: 0x9f_bc_d6,
  },
  {
    fog: 0x8a_ff_3c,
    fogA: 0.1,
    horizon: 0x72_9a_5c,
    name: "VENOMHOLLOW",
    oneway: 0x9c_ff_3c,
    roster: { archer: 16, bomber: 16, spearman: 38, warrior: 26 },
    sky: [0x21_2e_22, 0x33_48_2e, 0x4f_6d_3d],
    tile: 0x9c_ba_78,
    tree: 0x6f_9a_56,
  },
  {
    fog: 0xa2_4c_ff,
    fogA: 0.12,
    horizon: 0x6c_54_94,
    name: "VOIDSANCTUM",
    oneway: 0xc2_3c_ff,
    roster: { archer: 24, bomber: 24, spearman: 24, warrior: 24 },
    sky: [0x1c_17_30, 0x2c_20_46, 0x46_31_62],
    tile: 0x9a_80_cc,
    tree: 0x7a_5a_a8,
  },
];

export const biomePalette = (biome: number) => {
  const i = (((Math.floor(biome) - 1) % BIOMES.length) + BIOMES.length) % BIOMES.length;

  return BIOMES[i] ?? MOONWOOD;
};

/* oxlint-disable no-bitwise -- unpacking and repacking 0xRRGGBB channels. */
export const mulColor = (a: number, b: number) => {
  const r = (((a >> 16) & 0xff) * ((b >> 16) & 0xff)) / 255;
  const g = (((a >> 8) & 0xff) * ((b >> 8) & 0xff)) / 255;
  const bl = ((a & 0xff) * (b & 0xff)) / 255;

  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};
/* oxlint-enable no-bitwise */

export const enemyPool: (biome: number, elite: boolean) => [EnemyName, number][] = (
  biome,
  elite,
) => {
  const pal = biomePalette(biome);

  return ENEMY_NAMES.map(
    (n) => [n, pal.roster[n] + (elite && n !== "warrior" ? 8 : 0)] satisfies [EnemyName, number],
  );
};
