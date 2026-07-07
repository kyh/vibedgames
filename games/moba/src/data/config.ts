// Global tuning distilled from the design doc. All distances in PIXELS, all
// times in SECONDS unless a name says *Ms. Pure data — no Phaser.

export type Team = "radiant" | "dire";
export type DamageType = "physical" | "magic" | "pure";

export const TEAMS: Team[] = ["radiant", "dire"];
export function enemyOf(t: Team): Team {
  return t === "radiant" ? "dire" : "radiant";
}

// ---- match pacing ----------------------------------------------------------
export const MAX_LEVEL = 16;
export const HERO_MAGIC_RESIST = 0.25; // flat 25% magic reduction on heroes
export const PASSIVE_GOLD_PER_SEC = 1.5;

// Cumulative XP required to *reach* each level (index 0 = level 1).
export const XP_CURVE = [
  0, 240, 600, 1080, 1680, 2400, 3240, 4200, 5280, 6480, 7800, 9240, 10800, 12480, 14280, 16200,
];

export function levelForXp(xp: number): number {
  let lvl = 1;
  for (let i = 1; i < XP_CURVE.length; i++) {
    if (xp >= (XP_CURVE[i] ?? Infinity)) lvl = i + 1;
    else break;
  }
  return Math.min(lvl, MAX_LEVEL);
}

export function respawnTime(level: number): number {
  return Math.min(6 + 4 * level, 70);
}

// 1 ability point per level. Q/W/E unlock ranks at hero levels 1,3,5,7.
// Ultimate R ranks unlock at 6, 11, 16.
export function abilityRankCap(key: "Q" | "W" | "E" | "R", heroLevel: number): number {
  if (key === "R") return heroLevel >= 16 ? 3 : heroLevel >= 11 ? 2 : heroLevel >= 6 ? 1 : 0;
  const unlocks = [1, 3, 5, 7];
  let cap = 0;
  for (const u of unlocks) if (heroLevel >= u) cap++;
  return cap;
}

// ---- combat math -----------------------------------------------------------
// Standard MOBA armor curve: multiplier = 1 - (0.06*armor)/(1+0.06*|armor|).
// Well-behaved for negative armor (amplifies symmetrically).
export function physicalMultiplier(armor: number): number {
  const k = 0.06 * armor;
  return 1 - k / (1 + Math.abs(k));
}

export function magicMultiplier(isHero: boolean): number {
  return isHero ? 1 - HERO_MAGIC_RESIST : 1;
}

/** Convert attacks/sec into ms between attacks. */
export function attackIntervalMs(attackSpeed: number): number {
  return 1000 / Math.max(0.1, attackSpeed);
}

// ---- creeps ----------------------------------------------------------------
export type CreepKind = "melee" | "ranged" | "siege";

export type CreepDef = {
  kind: CreepKind;
  hp: number;
  damage: number;
  armor: number;
  attackRange: number;
  moveSpeed: number;
  attackSpeed: number;
  projectileSpeed: number; // 0 = melee
  goldBounty: [number, number];
  xpBounty: number;
  radius: number;
  /** physical-damage multiplier this creep deals to structures */
  structureDamageMult: number;
  /** multiplier on damage this creep *takes* from heroes/creeps (siege is tanky vs them) */
  incomingFromUnitsMult: number;
};

export const CREEPS: Record<CreepKind, CreepDef> = {
  melee: {
    kind: "melee",
    hp: 280,
    damage: 19,
    armor: 2,
    attackRange: 70,
    moveSpeed: 240,
    attackSpeed: 1,
    projectileSpeed: 0,
    goldBounty: [28, 40],
    xpBounty: 36,
    radius: 26,
    structureDamageMult: 1.5,
    incomingFromUnitsMult: 1,
  },
  ranged: {
    kind: "ranged",
    hp: 170,
    damage: 24,
    armor: 0,
    attackRange: 380,
    moveSpeed: 240,
    attackSpeed: 0.85,
    projectileSpeed: 800,
    goldBounty: [34, 46],
    xpBounty: 44,
    radius: 24,
    structureDamageMult: 1.2,
    incomingFromUnitsMult: 1,
  },
  siege: {
    kind: "siege",
    hp: 420,
    damage: 40,
    armor: 4,
    attackRange: 200,
    moveSpeed: 220,
    attackSpeed: 0.5,
    projectileSpeed: 0,
    goldBounty: [60, 75],
    xpBounty: 70,
    radius: 30,
    structureDamageMult: 3.5,
    incomingFromUnitsMult: 0.4,
  },
};

// Wave composition + cadence.
export const WAVE = {
  firstWaveSec: 15,
  intervalSec: 30,
  melee: 3,
  ranged: 1,
  siegeEveryNthWave: 4,
  /** creep stats ramp to push the game to a close. Damage ramps hard so lane
   * fights resolve decisively (breaking the symmetric stalemate) and waves push. */
  hpRampPer60s: 10,
  dmgRampPer60s: 3.5,
};

// ---- towers / ancient ------------------------------------------------------
export type StructTier = "t1" | "t2" | "base" | "ancient";

export type StructDef = {
  tier: StructTier;
  hp: number;
  damage: number;
  armor: number;
  attackRange: number;
  attackSpeed: number;
  projectileSpeed: number;
  bountyTeam: number;
  bountyLocal: number;
  regenPerSec: number; // when no enemy creeps near (backdoor protection)
  radius: number;
};

export const STRUCTS: Record<StructTier, StructDef> = {
  t1: {
    tier: "t1",
    hp: 1050,
    damage: 90,
    armor: 6,
    attackRange: 560,
    attackSpeed: 1,
    projectileSpeed: 900,
    bountyTeam: 100,
    bountyLocal: 150,
    regenPerSec: 22,
    radius: 60,
  },
  t2: {
    tier: "t2",
    hp: 1500,
    damage: 130,
    armor: 9,
    attackRange: 560,
    attackSpeed: 1.05,
    projectileSpeed: 900,
    bountyTeam: 140,
    bountyLocal: 190,
    regenPerSec: 22,
    radius: 60,
  },
  base: {
    tier: "base",
    hp: 1000,
    damage: 80,
    armor: 7,
    attackRange: 600,
    attackSpeed: 1.2,
    projectileSpeed: 1000,
    bountyTeam: 40,
    bountyLocal: 60,
    regenPerSec: 0,
    radius: 56,
  },
  // ancient radius is generous: the castle sits on a blocked plateau, so melee
  // attackers must be able to reach its hitbox from the flat ground at the edge
  ancient: {
    tier: "ancient",
    hp: 2400,
    damage: 0,
    armor: 10,
    attackRange: 0,
    attackSpeed: 0,
    projectileSpeed: 0,
    bountyTeam: 0,
    bountyLocal: 0,
    regenPerSec: 20,
    radius: 170,
  },
};

export const TOWER_RAMP_PER_HIT = 0.25; // +25% dmg per consecutive hit, resets on switch
export const TOWER_RAMP_MAX = 4; // cap stacks

// ---- economy ---------------------------------------------------------------
export const ECON = {
  startingGold: 600,
  heroKillBaseBounty: 200,
  heroKillPerLevel: 12,
  streakBonusPerKill: 40,
  streakBonusCap: 280,
  shutdownBonus: 75,
  assistFraction: 0.6,
  xpShareRadius: 1200,
  denyXpFraction: 0.5,
};

// ---- sim timing ------------------------------------------------------------
export const SIM_HZ = 30; // fixed-step host simulation
export const SIM_DT = 1 / SIM_HZ;
export const SNAPSHOT_HZ = 15; // host -> client broadcast cadence
