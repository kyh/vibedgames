// Static game data: the tile and prop vocabularies, match tuning, the four
// brawler kits, bot names, and the difficulty / quality tables the settings
// panel exposes. Everything here is read-only at runtime.

export const TILE = { BUSH: 2, EMPTY: 0, WALL: 1, WATER: 3 } as const;
export type TileId = (typeof TILE)[keyof typeof TILE];

export const PROP = { BARREL: 2, CACTUS: 3, CRATE: 1, LAMP: 5, ROCK: 4, STONE: 0 } as const;
export type PropId = (typeof PROP)[keyof typeof PROP];

export const BRAWLER_RADIUS = 0.4;

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

// Street lamp geometry and spot-light frustum, shared by the world builder,
// the lighting rig and the shadow shader patch.
export const LAMP = {
  angle: 1,
  arm: 0.62,
  far: 10.5,
  height: 3.05,
  near: 0.4,
  // spot attenuation is clamped to this distance so the bulb never blows out the post
  nearClamp: 2.3,
  size: 0.55,
} as const;

export type BrawlerId = "dusty" | "ace" | "fuse" | "titan";

export interface Palette {
  accent: number;
  body: number;
  dark: number;
  skin: number;
}

// Fields every attack carries. The kind-specific extras that only some kinds
// use are optional here so callers that branch on a subset of kinds (a bullet
// checking `pierce`, an explosion checking `big`) can read them without a
// second narrowing step; each concrete kind tightens the ones it requires.
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
  kind: "spread";
  pellets: number;
  radius: number;
  speed: number;
  spread: number;
}

export interface BurstAttack extends AttackBase {
  count: number;
  interval: number;
  jitter: number;
  kind: "burst";
  radius: number;
  speed: number;
}

export interface MeleeAttack extends AttackBase {
  count: number;
  interval: number;
  jitter: number;
  kind: "melee";
  radius: number;
  speed: number;
}

export interface LobAttack extends AttackBase {
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
// Attacks that spawn bullets.
export type ProjectileAttack = SpreadAttack | BurstAttack | MeleeAttack;
// Attacks fired as a timed sequence of shots.
export type VolleyAttack = BurstAttack | MeleeAttack;
// Attacks that resolve as an area blast on arrival.
export type BlastAttack = LobAttack | LeapAttack;

export interface BrawlerDef {
  attack: AttackDef;
  blurb: string;
  hp: number;
  id: BrawlerId;
  name: string;
  palette: Palette;
  // bots try to hold this distance from their target
  preferred: number;
  // seconds to recover one ammo
  reload: number;
  role: string;
  speed: number;
  super: AttackDef;
  // damage dealt to fully charge the super
  superCharge: number;
}

// oxlint-disable-next-line sort-keys -- the roster cards are laid out in this order
export const BRAWLERS: Record<BrawlerId, BrawlerDef> = {
  dusty: {
    attack: {
      color: 0xff_a5_3a,
      damage: 330,
      kind: "spread",
      pellets: 5,
      radius: 0.15,
      range: 7,
      speed: 15,
      spread: 0.5,
    },
    blurb: "Wide buckshot cone. Deadly up close.",
    hp: 3900,
    id: "dusty",
    name: "DUSTY",
    palette: { accent: 0x8a_4f_d8, body: 0xf2_b6_32, dark: 0x3a_2a_4a, skin: 0xf1_c4_9a },
    preferred: 3.6,
    reload: 1.35,
    role: "Shotgunner",
    speed: 3.15,
    super: {
      breaksWalls: true,
      color: 0xff_e1_4a,
      damage: 340,
      kind: "spread",
      knockback: 9,
      pellets: 9,
      radius: 0.2,
      range: 8,
      speed: 16,
      spread: 0.85,
    },
    superCharge: 3000,
  },
  ace: {
    attack: {
      color: 0x6f_d2_ff,
      count: 6,
      damage: 330,
      interval: 0.08,
      jitter: 0.035,
      kind: "burst",
      radius: 0.13,
      range: 9.5,
      speed: 19,
    },
    blurb: "Long range six-shot burst.",
    hp: 3000,
    id: "ace",
    name: "ACE",
    palette: { accent: 0xc2_3a_2a, body: 0x2f_6f_d6, dark: 0x1f_2a_44, skin: 0xe8_b4_8a },
    preferred: 6.8,
    reload: 1.5,
    role: "Sharpshooter",
    speed: 3.25,
    super: {
      breaksWalls: true,
      color: 0xff_f0_7a,
      count: 12,
      damage: 340,
      interval: 0.06,
      jitter: 0.05,
      kind: "burst",
      pierce: true,
      radius: 0.2,
      range: 11.5,
      speed: 21,
    },
    superCharge: 3600,
  },
  fuse: {
    attack: {
      blast: 1.55,
      color: 0xff_7a_2a,
      damage: 920,
      flight: 0.72,
      fuse: 0.38,
      kind: "lob",
      range: 7.5,
    },
    blurb: "Lobs bombs over walls.",
    hp: 2900,
    id: "fuse",
    name: "FUSE",
    palette: { accent: 0xf6_d2_3a, body: 0xe2_62_2a, dark: 0x3b_30_29, skin: 0xe9_bd_96 },
    preferred: 5.8,
    reload: 1.55,
    role: "Thrower",
    speed: 3,
    super: {
      big: true,
      blast: 2.8,
      breaksWalls: true,
      color: 0xff_d2_3a,
      damage: 2400,
      flight: 0.95,
      fuse: 0.7,
      kind: "lob",
      knockback: 10,
      range: 8.5,
    },
    superCharge: 3000,
  },
  titan: {
    attack: {
      color: 0xff_5a_4a,
      count: 4,
      damage: 390,
      interval: 0.09,
      jitter: 0.12,
      kind: "melee",
      radius: 0.48,
      range: 2.7,
      speed: 13,
    },
    blurb: "Huge health. Punches and leaps.",
    hp: 6200,
    id: "titan",
    name: "TITAN",
    palette: { accent: 0xe2_3a_3a, body: 0x2a_4f_b8, dark: 0x1a_20_38, skin: 0xd9_a2_7a },
    preferred: 1.6,
    reload: 0.85,
    role: "Heavyweight",
    speed: 3.45,
    super: {
      blast: 2.3,
      breaksWalls: true,
      color: 0xff_d2_3a,
      damage: 1000,
      flight: 0.75,
      kind: "leap",
      knockback: 11,
      range: 8,
    },
    superCharge: 3200,
  },
};

export const isBrawlerId = (id: string): id is BrawlerId => Object.hasOwn(BRAWLERS, id);

export const BOT_NAMES: readonly string[] = [
  "Rusty",
  "Nova",
  "Pixel",
  "Bolt",
  "Maple",
  "Onyx",
  "Ziggy",
  "Comet",
  "Pepper",
  "Havoc",
  "Mango",
  "Sprocket",
  "Biscuit",
  "Turbo",
];

export type DifficultyName = "easy" | "normal" | "hard";

export interface Difficulty {
  // bot reaction delay multiplier
  cadence: number;
  // bot damage multiplier against the player
  damage: number;
  // distance at which bots start a fight
  engage: number;
  // how many bots actively hunt the player
  hunters: number;
  label: string;
  react: number;
  // [min, max] bot aim skill
  skill: readonly [number, number];
}

// oxlint-disable-next-line sort-keys -- the settings buttons are laid out in this order
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
    cadence: 1.3,
    damage: 0.68,
    engage: 6.5,
    hunters: 2,
    label: "Normal",
    react: 1.4,
    skill: [0.45, 0.78],
  },
  hard: {
    cadence: 1,
    damage: 0.85,
    engage: 9,
    hunters: 3,
    label: "Hard",
    react: 1,
    skill: [0.62, 0.95],
  },
};

export const isDifficultyName = (name: string): name is DifficultyName =>
  Object.hasOwn(DIFFICULTIES, name);

export type QualityName = "low" | "medium" | "high" | "ultra";

export interface Quality {
  ao: boolean;
  bloom: boolean;
  // device pixel ratio cap
  dpr: number;
  label: string;
  // shadow map size of each lamp spot light
  lampMap: number;
  lampShadows: boolean;
  msaa: number;
  pcss: boolean;
  // how many lamps get a real point light at once
  poolLights: number;
  // sun shadow map size
  shadowMap: number;
  // soft-shadow sample tier, 0-3
  tier: number;
}

// oxlint-disable-next-line sort-keys -- the settings buttons are laid out in this order
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
