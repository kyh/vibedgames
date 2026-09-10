import { ENEMY_NAMES } from "./animations";
import type { EnemyName } from "./animations";

// Per-biome identity. Descending biome 1→5 repaints the whole world — sky
// gradient, ground, silhouettes, neon and a thin atmosphere wash — and reshuffles
// which foes prowl there, so each depth reads as its own place. Beyond biome 5 the
// table cycles (biome 6 looks like 1, etc.). The teal grass-tuft crown is left
// untinted on purpose: it's the game's signature glow and recurs across worlds.
export interface BiomePalette {
  name: string;
  // top → mid → low gradient bands
  sky: readonly [number, number, number];
  // deep ruin-pillar / mist tint
  horizon: number;
  // dirt-body + side-fringe tint (multiplies the dark tile art)
  tile: number;
  // neon one-way platform line
  oneway: number;
  // parallax silhouette hue (multiplied into each layer's depth-grey)
  tree: number;
  // full-field atmosphere wash
  fog: number;
  // wash alpha (0 = none, biome 1 keeps the raw art)
  fogA: number;
  // enemy spawn-weight bias
  roster: Readonly<Record<EnemyName, number>>;
}

// The starting world — also the guaranteed fallback, so lookups never widen to
// undefined and the default render (viewer, first room) matches the raw art.
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

export const biomePalette = (biome: number): BiomePalette => {
  const i = (((Math.floor(biome) - 1) % BIOMES.length) + BIOMES.length) % BIOMES.length;
  return BIOMES[i] ?? MOONWOOD;
};

// Multiply two packed 0xRRGGBB colours channel-wise — used to fold a biome hue
// into the parallax layers' depth-greys while keeping their near/far contrast.
/* oxlint-disable no-bitwise -- unpacking and repacking 0xRRGGBB channels. */
export const mulColor = (a: number, b: number): number => {
  const r = (((a >> 16) & 0xff) * ((b >> 16) & 0xff)) / 255;
  const g = (((a >> 8) & 0xff) * ((b >> 8) & 0xff)) / 255;
  const bl = ((a & 0xff) * (b & 0xff)) / 255;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};
/* oxlint-enable no-bitwise */

// The enemy spawn pool for a biome, with elite rooms biasing toward the
// dangerous (non-warrior) archetypes. Weights come from the biome roster.
export const enemyPool = (biome: number, elite: boolean): [EnemyName, number][] => {
  const pal = biomePalette(biome);
  return ENEMY_NAMES.map((n): [EnemyName, number] => [
    n,
    pal.roster[n] + (elite && n !== "warrior" ? 8 : 0),
  ]);
};
