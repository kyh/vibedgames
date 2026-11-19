export const TILE = { BUSH: 2, EMPTY: 0, WALL: 1, WATER: 3 } as const;

export type TileId = (typeof TILE)[keyof typeof TILE];

export const PROP = { BARREL: 2, CACTUS: 3, CRATE: 1, LAMP: 5, ROCK: 4, STONE: 0 } as const;

export type PropId = (typeof PROP)[keyof typeof PROP];

export const BRAWLER_RADIUS = 0.4;

/** Online: seconds the host shows the result before the next brawl starts on its own. */
export const RESTART_DELAY_S = 8;

export const TUNING = {
  bots: 7,
  boxHp: 4200,
  cubeDamage: 0.1,
  cubeHp: 400,
  dayLength: 205,
  endHour: 21.2,
  gasDelay: 26,
  gasDuration: 140,
  gasEndHalf: 4,
  gasStartHalf: 25,
  startHour: 15.4,
} as const;

export const LAMP = {
  angle: 1,
  arm: 0.62,
  far: 10.5,
  height: 3.05,
  near: 0.4,
  nearClamp: 2.3,
  size: 0.55,
} as const;

export type BrawlerId =
  | "dusty"
  | "ace"
  | "fuse"
  | "titan"
  | "rowan"
  | "nyx"
  | "moss"
  | "flint"
  | "pip";

export type MeleeStyle = "cleave" | "smash" | "thrust" | "flurry";

export type ProjectileStyle = "arrow" | "spear" | "thorn" | "bolt";

export type LobStyle = "fire" | "seed" | "potion";

export interface Palette {
  accent: number;
  body: number;
  dark: number;
  skin: number;
}

interface AttackBase {
  big?: boolean;
  breaksWalls?: boolean;
  color: number;
  damage: number;
  knockback?: number;
  pierce?: boolean;
  range: number;
  speed?: number;
}

export interface SpreadAttack extends AttackBase {
  style: ProjectileStyle;
  kind: "spread";
  pellets: number;
  radius: number;
  speed: number;
  spread: number;
}

export interface BurstAttack extends AttackBase {
  style: ProjectileStyle;
  count: number;
  interval: number;
  jitter: number;
  kind: "burst";
  radius: number;
  speed: number;
}

export interface MeleeAttack extends AttackBase {
  style: MeleeStyle;
  /** Full sweep angle in radians; targets behind the weapon are safe. */
  arc: number;
  kind: "melee";
  recovery: number;
  windup: number;
}

export interface LobAttack extends AttackBase {
  style: LobStyle;
  blast: number;
  flight: number;
  fuse: number;
  kind: "lob";
}

export interface LeapAttack extends AttackBase {
  blast: number;
  breaksWalls: boolean;
  flight: number;
  kind: "leap";
  knockback: number;
}

export type AttackDef = SpreadAttack | BurstAttack | MeleeAttack | LobAttack | LeapAttack;

export type ProjectileAttack = SpreadAttack | BurstAttack;

export type VolleyAttack = BurstAttack;

export type BlastAttack = LobAttack | LeapAttack;

export interface BrawlerDef {
  attack: AttackDef;
  blurb: string;
  hp: number;
  id: BrawlerId;
  name: string;
  palette: Palette;
  preferred: number;
  reload: number;
  role: string;
  speed: number;
  super: AttackDef;
  superName: string;
  superBlurb: string;
  superCharge: number;
}

export const BRAWLERS: Record<BrawlerId, BrawlerDef> = {
  dusty: {
    attack: {
      arc: 1.92,
      color: 0xc8_ef_c5,
      damage: 1420,
      kind: "melee",
      knockback: 3,
      range: 2.2,
      recovery: 0.42,
      style: "cleave",
      windup: 0.2,
    },
    blurb: "Sword and shield. A sweeping blade for close duels.",
    hp: 4600,
    id: "dusty",
    name: "BRIAR",
    palette: { accent: 0xd7_b8_64, body: 0x47_73_64, dark: 0x2d_3c_3b, skin: 0xed_be_97 },
    preferred: 1.35,
    reload: 1.05,
    role: "Thorn Knight",
    speed: 3.65,
    super: {
      arc: 5.2,
      breaksWalls: true,
      color: 0xe7_ef_ad,
      damage: 2050,
      kind: "melee",
      knockback: 8,
      range: 3.1,
      recovery: 0.6,
      style: "cleave",
      windup: 0.26,
    },
    superBlurb: "Sweep a wide arc, shoving rivals and breaking nearby cover.",
    superCharge: 3500,
    superName: "Crowncleave",
  },
  ace: {
    attack: {
      color: 0xe8_d4_95,
      count: 3,
      damage: 470,
      interval: 0.14,
      jitter: 0.025,
      kind: "burst",
      radius: 0.12,
      range: 10,
      speed: 18,
      style: "arrow",
    },
    blurb: "A hooded ranger. Loose three arrows, keep your distance.",
    hp: 3200,
    id: "ace",
    name: "WREN",
    palette: { accent: 0xe0_b2_5a, body: 0x72_83_52, dark: 0x3b_45_34, skin: 0xe8_b4_8a },
    preferred: 6.8,
    reload: 1.4,
    role: "Wildwood Ranger",
    speed: 3.4,
    super: {
      color: 0xde_f7_be,
      damage: 490,
      kind: "spread",
      knockback: 2.5,
      pellets: 7,
      radius: 0.15,
      range: 12,
      speed: 21,
      spread: 0.64,
      style: "arrow",
    },
    superBlurb: "Release seven enchanted arrows in a long, sweeping fan.",
    superCharge: 3300,
    superName: "Arrowstorm",
  },
  fuse: {
    attack: {
      blast: 1.65,
      color: 0xff_a2_53,
      damage: 1100,
      flight: 0.68,
      fuse: 0.25,
      kind: "lob",
      range: 8,
      style: "fire",
    },
    blurb: "A wayward fire mage. Cast arcing embers over cover.",
    hp: 3000,
    id: "fuse",
    name: "EMBER",
    palette: { accent: 0xf3_ba_68, body: 0x9c_57_64, dark: 0x42_35_50, skin: 0xec_be_a2 },
    preferred: 5.8,
    reload: 1.45,
    role: "Hearth Witch",
    speed: 3.15,
    super: {
      big: true,
      blast: 2.8,
      breaksWalls: true,
      color: 0xff_d2_83,
      damage: 2350,
      flight: 0.95,
      fuse: 0.55,
      kind: "lob",
      knockback: 9,
      range: 9,
      style: "fire",
    },
    superBlurb: "Lob a blazing meteor that breaks cover in a broad blast.",
    superCharge: 3200,
    superName: "Falling Star",
  },
  titan: {
    attack: {
      arc: 1.57,
      color: 0xbd_db_ed,
      damage: 1950,
      kind: "melee",
      knockback: 5,
      range: 2.65,
      recovery: 0.62,
      style: "smash",
      windup: 0.32,
    },
    blurb: "A stone warden. Heavy hammer sweeps and a leaping slam.",
    hp: 6100,
    id: "titan",
    name: "ROOK",
    palette: { accent: 0xcc_a1_62, body: 0x76_86_99, dark: 0x38_3f_52, skin: 0xcf_a8_83 },
    preferred: 1.7,
    reload: 1.45,
    role: "Stone Warden",
    speed: 3.25,
    super: {
      blast: 2.6,
      breaksWalls: true,
      color: 0xbe_de_e8,
      damage: 1800,
      flight: 0.75,
      kind: "leap",
      knockback: 11,
      range: 8,
    },
    superBlurb: "Leap across the field and crush nearby foes on landing.",
    superCharge: 3800,
    superName: "Castlefall",
  },
  rowan: {
    attack: {
      color: 0xff_e0_92,
      count: 1,
      damage: 1180,
      interval: 0.22,
      jitter: 0,
      kind: "burst",
      knockback: 2.5,
      radius: 0.18,
      range: 9,
      speed: 18,
      style: "spear",
    },
    blurb: "A sun-sworn javelin thrower. Hurl a single spear, then pierce the line with Sunlance.",
    hp: 4100,
    id: "rowan",
    name: "ROWAN",
    palette: { accent: 0xf0_c7_62, body: 0xcf_7d_43, dark: 0x53_40_35, skin: 0xc9_8c_68 },
    preferred: 5.4,
    reload: 1.2,
    role: "Sun Lancer",
    speed: 3.5,
    super: {
      color: 0xff_ee_b8,
      count: 1,
      damage: 2350,
      interval: 0.12,
      jitter: 0,
      kind: "burst",
      knockback: 4,
      pierce: true,
      radius: 0.2,
      range: 11,
      speed: 20,
      style: "spear",
    },
    superBlurb: "Hurl a radiant spear through every rival in its path.",
    superCharge: 3400,
    superName: "Sunlance",
  },
  nyx: {
    attack: {
      arc: 1.8,
      color: 0xd9_c1_ff,
      damage: 890,
      kind: "melee",
      knockback: 1.2,
      range: 1.65,
      recovery: 0.32,
      style: "flurry",
      windup: 0.14,
    },
    blurb: "A moonlit rogue. Quick twin daggers and a vault into the fray.",
    hp: 3300,
    id: "nyx",
    name: "NYX",
    palette: { accent: 0xc4_98_d9, body: 0x64_53_86, dark: 0x2d_2a_42, skin: 0xc9_a2_8c },
    preferred: 0.95,
    reload: 0.72,
    role: "Nightblade",
    speed: 4.05,
    super: {
      blast: 1.7,
      breaksWalls: false,
      color: 0xd7_c0_ff,
      damage: 1650,
      flight: 0.45,
      kind: "leap",
      knockback: 4,
      range: 6,
    },
    superBlurb: "Vault a short distance and strike nearby foes on landing.",
    superCharge: 2800,
    superName: "Shadowstep",
  },
  moss: {
    attack: {
      color: 0xc1_e8_82,
      damage: 400,
      kind: "spread",
      pellets: 3,
      radius: 0.18,
      range: 7.2,
      speed: 13,
      spread: 0.42,
      style: "thorn",
    },
    blurb: "A wandering grove-keeper. Scatter thorns and awaken a bursting seedpod.",
    hp: 3850,
    id: "moss",
    name: "MOSS",
    palette: { accent: 0xd1_b7_69, body: 0x6d_8d_53, dark: 0x39_4c_38, skin: 0xb7_89_65 },
    preferred: 4.4,
    reload: 1.15,
    role: "Grove Druid",
    speed: 3.2,
    super: {
      big: true,
      blast: 3.1,
      color: 0xc1_e8_82,
      damage: 2000,
      flight: 0.82,
      fuse: 0.45,
      kind: "lob",
      knockback: 6,
      range: 8.5,
      style: "seed",
    },
    superBlurb: "Lob a giant seedpod that bursts into a wide spray of thorns.",
    superCharge: 3100,
    superName: "Brambleburst",
  },
  flint: {
    attack: {
      color: 0xd2_da_e4,
      count: 1,
      damage: 1550,
      interval: 0.64,
      jitter: 0,
      kind: "burst",
      knockback: 2,
      radius: 0.14,
      range: 11.5,
      speed: 24,
      style: "bolt",
    },
    blurb: "A patient iron marksman. One weighty bolt, or three that pierce the line.",
    hp: 3400,
    id: "flint",
    name: "FLINT",
    palette: { accent: 0xc8_a2_63, body: 0x68_7c_91, dark: 0x34_3a_44, skin: 0xd4_aa_89 },
    preferred: 7.3,
    reload: 1.75,
    role: "Iron Crossbow",
    speed: 3.05,
    super: {
      color: 0xe2_f3_ff,
      count: 3,
      damage: 950,
      interval: 0.18,
      jitter: 0,
      kind: "burst",
      knockback: 2.5,
      pierce: true,
      radius: 0.19,
      range: 12.5,
      speed: 25,
      style: "bolt",
    },
    superBlurb: "Fire three heavy bolts that pierce through lined-up rivals.",
    superCharge: 3500,
    superName: "Iron Volley",
  },
  pip: {
    attack: {
      blast: 1.35,
      color: 0x82_d9_c8,
      damage: 700,
      flight: 0.45,
      fuse: 0.14,
      kind: "lob",
      range: 5.8,
      style: "potion",
    },
    blurb: "A pocketful of trouble. Toss quick potions and one spectacular concoction.",
    hp: 3550,
    id: "pip",
    name: "PIP",
    palette: { accent: 0xf0_b6_65, body: 0x52_94_95, dark: 0x39_42_50, skin: 0xe9_b9_96 },
    preferred: 3.8,
    reload: 0.86,
    role: "Patchwork Alchemist",
    speed: 3.55,
    super: {
      big: true,
      blast: 2.8,
      color: 0xb8_ae_f5,
      damage: 1900,
      flight: 0.68,
      fuse: 0.35,
      kind: "lob",
      knockback: 7,
      range: 7,
      style: "potion",
    },
    superBlurb: "Throw a volatile brew with a wide blast and a strong shove.",
    superCharge: 2600,
    superName: "Grand Brew",
  },
};

export const isBrawlerId = (id: string): id is BrawlerId => Object.hasOwn(BRAWLERS, id);

export const BOT_NAMES: readonly string[] = [
  "Alder",
  "Orla",
  "Bramble",
  "Fen",
  "Maple",
  "Onyx",
  "Wick",
  "Hollis",
  "Pepper",
  "Thistle",
  "Tansy",
  "Clover",
  "Puck",
  "Sable",
];

export type DifficultyName = "easy" | "normal" | "hard";

export interface Difficulty {
  cadence: number;
  damage: number;
  engage: number;
  hunters: number;
  label: string;
  react: number;
  skill: readonly [number, number];
}

export const DIFFICULTIES: Record<DifficultyName, Difficulty> = {
  easy: {
    cadence: 1.6,
    damage: 0.5,
    engage: 5.5,
    hunters: 1,
    label: "Easy",
    react: 1.9,
    skill: [0.3, 0.6],
  },
  normal: {
    cadence: 1,
    damage: 0.88,
    engage: 8,
    hunters: 3,
    label: "Normal",
    react: 0.95,
    skill: [0.6, 0.9],
  },
  hard: {
    cadence: 0.9,
    damage: 0.95,
    engage: 9,
    hunters: 4,
    label: "Hard",
    react: 0.85,
    skill: [0.68, 0.96],
  },
};

export const isDifficultyName = (name: string): name is DifficultyName =>
  Object.hasOwn(DIFFICULTIES, name);

export type QualityName = "low" | "medium" | "high" | "ultra";

export interface Quality {
  ao: boolean;
  bloom: boolean;
  dpr: number;
  label: string;
  lampMap: number;
  lampShadows: boolean;
  msaa: number;
  pcss: boolean;
  poolLights: number;
  shadowMap: number;
  tier: number;
}

export const QUALITIES: Record<QualityName, Quality> = {
  low: {
    ao: false,
    bloom: true,
    dpr: 1,
    label: "Low",
    lampMap: 512,
    lampShadows: false,
    msaa: 0,
    pcss: false,
    poolLights: 4,
    shadowMap: 1024,
    tier: 0,
  },
  medium: {
    ao: false,
    bloom: true,
    dpr: 1,
    label: "Medium",
    lampMap: 512,
    lampShadows: true,
    msaa: 2,
    pcss: true,
    poolLights: 6,
    shadowMap: 2048,
    tier: 1,
  },
  high: {
    ao: true,
    bloom: true,
    dpr: 1.25,
    label: "High",
    lampMap: 1024,
    lampShadows: true,
    msaa: 4,
    pcss: true,
    poolLights: 10,
    shadowMap: 4096,
    tier: 2,
  },
  ultra: {
    ao: true,
    bloom: true,
    dpr: 2,
    label: "Ultra",
    lampMap: 2048,
    lampShadows: true,
    msaa: 4,
    pcss: true,
    poolLights: 12,
    shadowMap: 4096,
    tier: 3,
  },
};

export const isQualityName = (name: string): name is QualityName => Object.hasOwn(QUALITIES, name);
