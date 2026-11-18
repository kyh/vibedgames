export type Team = "radiant" | "dire";

export type DamageType = "physical" | "magic" | "pure";

export const TEAMS: Team[] = ["radiant", "dire"];
export const enemyOf: (t: Team) => Team = (t) => (t === "radiant" ? "dire" : "radiant");

export const MAX_LEVEL = 16;
export const HERO_MAGIC_RESIST = 0.25;
export const PASSIVE_GOLD_PER_SEC = 1.5;

export const XP_CURVE = [
  0, 240, 600, 1080, 1680, 2400, 3240, 4200, 5280, 6480, 7800, 9240, 10_800, 12_480, 14_280, 16_200,
];

export const levelForXp = (xp: number) => {
  let lvl = 1;

  for (let i = 1; i < XP_CURVE.length; i += 1) {
    if (xp >= (XP_CURVE[i] ?? Infinity)) {
      lvl = i + 1;
    } else {
      break;
    }
  }

  return Math.min(lvl, MAX_LEVEL);
};

export const respawnTime = (level: number) => Math.min(6 + 4 * level, 70);

export const abilityRankCap = (key: "Q" | "W" | "E" | "R", heroLevel: number) => {
  const unlocks = key === "R" ? [6, 11, 16] : [1, 3, 5, 7];
  let cap = 0;

  for (const u of unlocks) {
    if (heroLevel >= u) {
      cap += 1;
    }
  }

  return cap;
};

export const physicalMultiplier = (armor: number) => {
  const k = 0.06 * armor;

  return 1 - k / (1 + Math.abs(k));
};

export const magicMultiplier = (isHero: boolean) => (isHero ? 1 - HERO_MAGIC_RESIST : 1);

/** Convert attacks/sec into ms between attacks. */
export const attackIntervalMs = (attackSpeed: number) => 1000 / Math.max(0.1, attackSpeed);

export type CreepKind = "melee" | "ranged" | "siege";

export interface CreepDef {
  kind: CreepKind;
  hp: number;
  damage: number;
  armor: number;
  attackRange: number;
  moveSpeed: number;
  attackSpeed: number;
  projectileSpeed: number;
  goldBounty: [number, number];
  xpBounty: number;
  radius: number;
  /** physical-damage multiplier this creep deals to structures */
  structureDamageMult: number;
  /** multiplier on damage this creep *takes* from heroes/creeps (siege is tanky vs them) */
  incomingFromUnitsMult: number;
}

export const CREEPS = {
  melee: {
    armor: 2,
    attackRange: 70,
    attackSpeed: 1,
    damage: 19,
    goldBounty: [28, 40],
    hp: 280,
    incomingFromUnitsMult: 1,
    kind: "melee",
    moveSpeed: 240,
    projectileSpeed: 0,
    radius: 26,
    structureDamageMult: 1.5,
    xpBounty: 36,
  },
  ranged: {
    armor: 0,
    attackRange: 380,
    attackSpeed: 0.85,
    damage: 24,
    goldBounty: [34, 46],
    hp: 170,
    incomingFromUnitsMult: 1,
    kind: "ranged",
    moveSpeed: 240,
    projectileSpeed: 800,
    radius: 24,
    structureDamageMult: 1.2,
    xpBounty: 44,
  },
  siege: {
    armor: 4,
    attackRange: 200,
    attackSpeed: 0.5,
    damage: 40,
    goldBounty: [60, 75],
    hp: 420,
    incomingFromUnitsMult: 0.4,
    kind: "siege",
    moveSpeed: 220,
    projectileSpeed: 0,
    radius: 30,
    structureDamageMult: 3.5,
    xpBounty: 70,
  },
} satisfies Record<CreepKind, CreepDef>;

export const WAVE = {
  dmgRampPer60s: 3.5,
  firstWaveSec: 15,
  /** creep stats ramp to push the game to a close. Damage ramps hard so lane
   * fights resolve decisively (breaking the symmetric stalemate) and waves push. */
  hpRampPer60s: 10,
  intervalSec: 30,
  melee: 3,
  ranged: 1,
  siegeEveryNthWave: 4,
};

export type StructTier = "t1" | "t2" | "base" | "ancient";

export interface StructDef {
  tier: StructTier;
  hp: number;
  damage: number;
  armor: number;
  attackRange: number;
  attackSpeed: number;
  projectileSpeed: number;
  bountyTeam: number;
  bountyLocal: number;
  regenPerSec: number;
  radius: number;
}

export const STRUCTS = {
  ancient: {
    armor: 10,
    attackRange: 0,
    attackSpeed: 0,
    bountyLocal: 0,
    bountyTeam: 0,
    damage: 0,
    hp: 2400,
    projectileSpeed: 0,
    radius: 170,
    regenPerSec: 20,
    tier: "ancient",
  },
  base: {
    armor: 7,
    attackRange: 600,
    attackSpeed: 1.2,
    bountyLocal: 60,
    bountyTeam: 40,
    damage: 80,
    hp: 1000,
    projectileSpeed: 1000,
    radius: 56,
    regenPerSec: 0,
    tier: "base",
  },
  t1: {
    armor: 6,
    attackRange: 560,
    attackSpeed: 1,
    bountyLocal: 150,
    bountyTeam: 100,
    damage: 90,
    hp: 1050,
    projectileSpeed: 900,
    radius: 60,
    regenPerSec: 22,
    tier: "t1",
  },
  t2: {
    armor: 9,
    attackRange: 560,
    attackSpeed: 1.05,
    bountyLocal: 190,
    bountyTeam: 140,
    damage: 130,
    hp: 1500,
    projectileSpeed: 900,
    radius: 60,
    regenPerSec: 22,
    tier: "t2",
  },
} satisfies Record<StructTier, StructDef>;

export const TOWER_RAMP_PER_HIT = 0.25;
export const TOWER_RAMP_MAX = 4;

export const ECON = {
  assistFraction: 0.6,
  denyXpFraction: 0.5,
  heroKillBaseBounty: 200,
  heroKillPerLevel: 12,
  shutdownBonus: 75,
  startingGold: 600,
  streakBonusCap: 280,
  streakBonusPerKill: 40,
  xpShareRadius: 1200,
};

export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ;
export const KEYFRAME_MS = 5000;
