import { type EnemyName, ENEMY_NAMES } from "./animations";

// Per-biome identity. Descending biome 1→5 repaints the whole world — sky
// gradient, ground, silhouettes, neon and a thin atmosphere wash — and reshuffles
// which foes prowl there, so each depth reads as its own place. Beyond biome 5 the
// table cycles (biome 6 looks like 1, etc.). The teal grass-tuft crown is left
// untinted on purpose: it's the game's signature glow and recurs across worlds.
export type BiomePalette = {
  name: string;
  sky: readonly [number, number, number]; // top → mid → low gradient bands
  horizon: number; // deep ruin-pillar / mist tint
  tile: number; // dirt-body + side-fringe tint (multiplies the dark tile art)
  oneway: number; // neon one-way platform line
  tree: number; // parallax silhouette hue (multiplied into each layer's depth-grey)
  fog: number; // full-field atmosphere wash
  fogA: number; // wash alpha (0 = none, biome 1 keeps the raw art)
  roster: Readonly<Record<EnemyName, number>>; // enemy spawn-weight bias
};

// The starting world — also the guaranteed fallback, so lookups never widen to
// undefined and the default render (editor, first room) matches the raw art.
const MOONWOOD: BiomePalette = {
  name: "MOONWOOD",
  sky: [0x464f66, 0x59637b, 0x6b768e],
  horizon: 0x7a869c,
  tile: 0xffffff,
  oneway: 0xe83fa0,
  tree: 0xffffff,
  fog: 0x000000,
  fogA: 0,
  roster: { warrior: 44, spearman: 20, archer: 20, bomber: 10 },
};

export const BIOMES: readonly BiomePalette[] = [
  MOONWOOD,
  {
    name: "EMBERDEEP",
    sky: [0x351f28, 0x5a2f33, 0x804a3c],
    horizon: 0x9a5c46,
    tile: 0xe0997a,
    oneway: 0xff7a3c,
    tree: 0xcc6a48,
    fog: 0xff5a2a,
    fogA: 0.1,
    roster: { warrior: 30, spearman: 16, archer: 14, bomber: 36 },
  },
  {
    name: "FROSTVAULT",
    sky: [0x2b3a50, 0x3f5a76, 0x6e90ac],
    horizon: 0x9ab8ce,
    tile: 0xbcd8ea,
    oneway: 0x5cc8ff,
    tree: 0x9fbcd6,
    fog: 0x8fd6ff,
    fogA: 0.09,
    roster: { warrior: 30, spearman: 16, archer: 40, bomber: 10 },
  },
  {
    name: "VENOMHOLLOW",
    sky: [0x212e22, 0x33482e, 0x4f6d3d],
    horizon: 0x729a5c,
    tile: 0x9cba78,
    oneway: 0x9cff3c,
    tree: 0x6f9a56,
    fog: 0x8aff3c,
    fogA: 0.1,
    roster: { warrior: 26, spearman: 38, archer: 16, bomber: 16 },
  },
  {
    name: "VOIDSANCTUM",
    sky: [0x1c1730, 0x2c2046, 0x463162],
    horizon: 0x6c5494,
    tile: 0x9a80cc,
    oneway: 0xc23cff,
    tree: 0x7a5aa8,
    fog: 0xa24cff,
    fogA: 0.12,
    roster: { warrior: 24, spearman: 24, archer: 24, bomber: 24 },
  },
];

export const biomePalette = (biome: number): BiomePalette => {
  const i = (((Math.floor(biome) - 1) % BIOMES.length) + BIOMES.length) % BIOMES.length;
  return BIOMES[i] ?? MOONWOOD;
};

// Multiply two packed 0xRRGGBB colours channel-wise — used to fold a biome hue
// into the parallax layers' depth-greys while keeping their near/far contrast.
export const mulColor = (a: number, b: number): number => {
  const r = (((a >> 16) & 0xff) * ((b >> 16) & 0xff)) / 255;
  const g = (((a >> 8) & 0xff) * ((b >> 8) & 0xff)) / 255;
  const bl = ((a & 0xff) * (b & 0xff)) / 255;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};

// The enemy spawn pool for a biome, with elite rooms biasing toward the
// dangerous (non-warrior) archetypes. Weights come from the biome roster.
export const enemyPool = (biome: number, elite: boolean): [EnemyName, number][] => {
  const pal = biomePalette(biome);
  return ENEMY_NAMES.map(
    (n): [EnemyName, number] => [n, pal.roster[n] + (elite && n !== "warrior" ? 8 : 0)],
  );
};
