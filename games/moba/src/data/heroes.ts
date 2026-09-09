// Hero definitions distilled from the design pass. Pure data: per-rank numbers
// plus an `effect` tag the ability system switches on (see sim/abilities.ts).

export type AbilityKey = "Q" | "W" | "E" | "R";

// How the player aims an ability (drives input + bot targeting).
export type Targeting = "unit" | "point" | "none" | "passive";

export type AbilityValue = number | number[] | boolean;
export type AbilityValues = Record<string, AbilityValue>;

export interface AbilityDef {
  key: AbilityKey;
  name: string;
  /** unique effect id, "<heroId>:<key>" — sim/abilities.ts dispatches on it */
  effect: string;
  targeting: Targeting;
  /** how the design categorised it (for tooltips/fx) */
  flavor: string;
  desc: string;
  // 4 for Q/W/E, 3 for R
  maxRank: number;
  manaCost: number[];
  cooldown: number[];
  castRange: number;
  values: AbilityValues;
  isUltimate: boolean;
}

export interface HeroStats {
  hp: number;
  mp: number;
  hpRegen: number;
  mpRegen: number;
  damage: number;
  armor: number;
  attackRange: number;
  // attacks/sec
  attackSpeed: number;
  // px/sec
  moveSpeed: number;
  // 0 = melee instant
  projectileSpeed: number;
}

export interface HeroDef {
  id: string;
  name: string;
  title: string;
  role: string;
  attackType: "melee" | "ranged";
  /** logical unit sheet base; render resolves `u-<sheet>-<color>` */
  sheet: "warrior" | "pawn" | "archer" | "torch" | "tnt" | "barrel";
  tint: number;
  blurb: string;
  base: HeroStats;
  growth: Partial<HeroStats>;
  abilities: Record<AbilityKey, AbilityDef>;
}

/** Read a per-rank value; scalars apply at every rank. rank is 1-based. */
export const valAt = (v: AbilityValue | undefined, rank: number): number => {
  if (Array.isArray(v)) {
    return v[Math.max(0, Math.min(v.length - 1, rank - 1))] ?? 0;
  }
  if (v === undefined || v === false || v === true) {
    return 0;
  }
  return v;
};

const ab = (d: Omit<AbilityDef, "maxRank" | "isUltimate"> & { maxRank?: number }): AbilityDef => {
  const isUltimate = d.key === "R";
  return { ...d, isUltimate, maxRank: d.maxRank ?? (isUltimate ? 3 : 4) };
};

export const HEROES: HeroDef[] = [
  {
    abilities: {
      E: ab({
        castRange: 0,
        cooldown: [0],
        desc: "Aura: nearby allies gain move speed and HP regen.",
        effect: "ironvow:E",
        flavor: "passive aura",
        key: "E",
        manaCost: [0],
        name: "Banner of Resolve",
        targeting: "passive",
        values: { auraRadius: 600, hpRegen: [2, 3.5, 5, 6.5], moveSpeedPct: [4, 6, 8, 10] },
      }),
      Q: ab({
        castRange: 150,
        cooldown: [11, 10, 9, 8],
        desc: "Charge the buckler into a target for damage and a hard STUN.",
        effect: "ironvow:Q",
        flavor: "targeted-unit",
        key: "Q",
        manaCost: [75, 80, 85, 90],
        name: "Shield Bash",
        targeting: "unit",
        values: { damage: [70, 120, 170, 220], stun: [1, 1.3, 1.6, 1.9] },
      }),
      R: ab({
        castRange: 0,
        cooldown: [90, 80, 70],
        desc: "Slam the ground: TAUNT all nearby enemies to attack you while you gain heavy damage reduction.",
        effect: "ironvow:R",
        flavor: "point-aoe taunt",
        key: "R",
        manaCost: [120, 150, 180],
        name: "Unbreaking Vow",
        targeting: "none",
        values: {
          buffDuration: [4, 5, 6],
          damage: [80, 130, 180],
          damageReductionPct: [40, 50, 60],
          radius: 360,
          taunt: [1.4, 1.8, 2.2],
        },
      }),
      W: ab({
        castRange: 0,
        cooldown: [16, 15, 14, 13],
        desc: "Aegis: bonus armor + a damage SHIELD; melee attackers take reflected damage.",
        effect: "ironvow:W",
        flavor: "self-buff",
        key: "W",
        manaCost: [60, 65, 70, 75],
        name: "Oathguard",
        targeting: "none",
        values: {
          bonusArmor: [3, 5, 7, 9],
          duration: 6,
          reflectPct: [20, 25, 30, 35],
          shield: [80, 140, 200, 260],
        },
      }),
    },
    attackType: "melee",
    base: {
      armor: 4,
      attackRange: 90,
      attackSpeed: 0.65,
      damage: 48,
      hp: 660,
      hpRegen: 3,
      moveSpeed: 290,
      mp: 220,
      mpRegen: 0.8,
      projectileSpeed: 0,
    },
    blurb:
      "Frontline anchor. Taunt the enemy core, stun the priority target, soak the focus while allies clean up. The forgiving starter pick.",
    growth: {
      armor: 0.45,
      attackSpeed: 0.012,
      damage: 3.4,
      hp: 88,
      hpRegen: 0.22,
      mp: 14,
      mpRegen: 0.05,
    },
    id: "ironvow",
    name: "Sir Garran",
    role: "Tank / Initiator",
    sheet: "warrior",
    tint: 0x9c_c4_ff,
    title: "the Ironvow",
  },
  {
    abilities: {
      E: ab({
        castRange: 0,
        cooldown: [0],
        desc: "Attacks LIFESTEAL and stack attack speed; stacks decay out of combat.",
        effect: "duskblade:E",
        flavor: "passive",
        key: "E",
        manaCost: [0],
        name: "Bloodthirst",
        targeting: "passive",
        values: {
          asPerStack: [4, 5, 6, 7],
          lifestealPct: [10, 15, 20, 25],
          maxStacks: 5,
          stackDuration: 4,
        },
      }),
      Q: ab({
        castRange: 360,
        cooldown: [9, 8, 7, 6],
        desc: "Blink toward the cursor; your next attack soon strikes for bonus damage.",
        effect: "duskblade:Q",
        flavor: "dash",
        key: "Q",
        manaCost: [50, 55, 60, 65],
        name: "Shadowstep",
        targeting: "point",
        values: { blink: 360, bonusNextAttack: [30, 55, 80, 105], window: 3 },
      }),
      R: ab({
        castRange: 350,
        cooldown: [75, 65, 55],
        desc: "Lock onto a hero, become briefly untargetable, strike several times then a backstab CRIT.",
        effect: "duskblade:R",
        flavor: "targeted-unit",
        key: "R",
        manaCost: [100, 130, 160],
        name: "Death Waltz",
        targeting: "unit",
        values: {
          critMult: 2,
          damagePerStrike: [60, 80, 100],
          strikes: [3, 4, 5],
          untargetable: [1.2, 1.5, 1.8],
        },
      }),
      W: ab({
        castRange: 420,
        cooldown: [8, 7.5, 7, 6.5],
        desc: "Hurl a cone of daggers: damage + brief SLOW.",
        effect: "duskblade:W",
        flavor: "skillshot-aoe",
        key: "W",
        manaCost: [70, 80, 90, 100],
        name: "Fanned Daggers",
        targeting: "point",
        values: {
          coneAngle: 45,
          coneRange: 420,
          damage: [70, 110, 150, 190],
          slowDuration: 1.5,
          slowPct: [20, 25, 30, 35],
        },
      }),
    },
    attackType: "melee",
    base: {
      armor: 2,
      attackRange: 95,
      attackSpeed: 0.75,
      damage: 52,
      hp: 520,
      hpRegen: 1.8,
      moveSpeed: 320,
      mp: 250,
      mpRegen: 0.9,
      projectileSpeed: 0,
    },
    blurb:
      "Snowball assassin. Dodge ganks with a blink, fan daggers to push, dive squishies with an untargetable execute. High skill, high reward.",
    growth: {
      armor: 0.3,
      attackSpeed: 0.02,
      damage: 3.8,
      hp: 64,
      hpRegen: 0.16,
      mp: 16,
      mpRegen: 0.06,
    },
    id: "duskblade",
    name: "Vesper",
    role: "Carry / Assassin",
    sheet: "pawn",
    tint: 0x7a_f0_c8,
    title: "the Duskblade",
  },
  {
    abilities: {
      E: ab({
        castRange: 0,
        cooldown: [16, 14, 12, 10],
        desc: "Burst of move + attack speed; your hits briefly SLOW. Pure kiting.",
        effect: "stormcaller:E",
        flavor: "self-buff",
        key: "E",
        manaCost: [40, 45, 50, 55],
        name: "Windfoot",
        targeting: "none",
        values: {
          attackSpeed: [25, 35, 45, 55],
          duration: [3, 3.5, 4, 4.5],
          moveSpeed: [60, 80, 100, 120],
          onHitSlowPct: 12,
        },
      }),
      Q: ab({
        castRange: 800,
        cooldown: [7, 6.5, 6, 5.5],
        desc: "A long arrow that PIERCES every unit in a line, damage falling off per target.",
        effect: "stormcaller:Q",
        flavor: "skillshot-line",
        key: "Q",
        manaCost: [70, 80, 90, 100],
        name: "Piercing Shot",
        targeting: "point",
        values: { damage: [90, 140, 190, 240], falloffPct: 12, length: 800, minPct: 50, width: 90 },
      }),
      R: ab({
        castRange: 850,
        cooldown: [100, 90, 80],
        desc: "CHANNEL: rain storm arrows on an area, ticking AoE damage and slow.",
        effect: "stormcaller:R",
        flavor: "channel point-aoe",
        key: "R",
        manaCost: [150, 175, 200],
        name: "Storm Volley",
        targeting: "point",
        values: {
          channel: [3, 3.5, 4],
          damagePerTick: [55, 75, 95],
          radius: 320,
          slowPct: 25,
          tick: 0.5,
        },
      }),
      W: ab({
        castRange: 700,
        cooldown: [14, 13, 12, 11],
        desc: "Mark a hero: they take amplified damage; you attack them faster.",
        effect: "stormcaller:W",
        flavor: "targeted-unit",
        key: "W",
        manaCost: [50, 55, 60, 65],
        name: "Hunter's Mark",
        targeting: "unit",
        values: {
          ampPct: [12, 16, 20, 24],
          bonusAsVsMarked: [20, 30, 40, 50],
          duration: [5, 6, 7, 8],
        },
      }),
    },
    attackType: "ranged",
    base: {
      armor: 1,
      attackRange: 520,
      attackSpeed: 0.7,
      damage: 46,
      hp: 480,
      hpRegen: 1.6,
      moveSpeed: 300,
      mp: 300,
      mpRegen: 1.1,
      projectileSpeed: 900,
    },
    blurb:
      "Position-and-poke ranged carry. Pierce waves, mark the carry, kite with a speed burst, rain a storm to win fights and break towers.",
    growth: {
      armor: 0.28,
      attackSpeed: 0.018,
      damage: 3.6,
      hp: 56,
      hpRegen: 0.14,
      mp: 18,
      mpRegen: 0.07,
    },
    id: "stormcaller",
    name: "Aelwyn",
    role: "Carry / Ranged",
    sheet: "archer",
    tint: 0xbf_e0_ff,
    title: "Stormcaller",
  },
  {
    abilities: {
      E: ab({
        castRange: 0,
        cooldown: [18, 16, 14, 12],
        desc: "Wreath yourself in flame: burn nearby enemies and gain spell amp.",
        effect: "emberhex:E",
        flavor: "self-buff aura",
        key: "E",
        manaCost: [60, 65, 70, 75],
        name: "Flashfire",
        targeting: "none",
        values: { dps: [25, 40, 55, 70], duration: 5, radius: 200, spellAmpPct: [8, 12, 16, 20] },
      }),
      Q: ab({
        castRange: 550,
        cooldown: [6, 5.5, 5, 4.5],
        desc: "Lob a fireball that explodes for magic damage in an area.",
        effect: "emberhex:Q",
        flavor: "skillshot-aoe",
        key: "Q",
        manaCost: [80, 90, 100, 110],
        name: "Fireball",
        targeting: "point",
        values: { damage: [90, 150, 210, 270], projectileSpeed: 700, radius: 180 },
      }),
      R: ab({
        castRange: 700,
        cooldown: [90, 80, 70],
        desc: "A delayed firestorm erupts for huge magic damage and lingering burn.",
        effect: "emberhex:R",
        flavor: "skillshot-aoe nuke",
        key: "R",
        manaCost: [160, 210, 260],
        name: "Conflagration",
        targeting: "point",
        values: {
          burnDps: [40, 60, 80],
          burnDuration: 3,
          damage: [240, 340, 440],
          fuse: 0.9,
          radius: 340,
        },
      }),
      W: ab({
        castRange: 500,
        cooldown: [12, 11, 10, 9],
        desc: "Ignite the ground: burning DoT that SLOWS those who linger.",
        effect: "emberhex:W",
        flavor: "point-aoe DoT",
        key: "W",
        manaCost: [70, 80, 90, 100],
        name: "Cinder Trail",
        targeting: "point",
        values: { dps: [30, 45, 60, 75], duration: 4, radius: 200, slowPct: 30 },
      }),
    },
    attackType: "ranged",
    base: {
      armor: 1,
      attackRange: 320,
      attackSpeed: 0.6,
      damage: 40,
      hp: 500,
      hpRegen: 1.7,
      moveSpeed: 300,
      mp: 340,
      mpRegen: 1.3,
      projectileSpeed: 700,
    },
    blurb:
      "Burst mage. Lob fireballs, lay burning ground, immolate in melee, then delete a clump with a delayed firestorm.",
    growth: {
      armor: 0.26,
      attackSpeed: 0.01,
      damage: 2.8,
      hp: 58,
      hpRegen: 0.15,
      mp: 22,
      mpRegen: 0.09,
    },
    id: "emberhex",
    name: "Grix",
    role: "Nuker / Mage",
    sheet: "torch",
    tint: 0xff_8a_4d,
    title: "the Emberhex",
  },
  {
    abilities: {
      E: ab({
        castRange: 0,
        cooldown: [15, 14, 13, 12],
        desc: "Next attacks splash AoE; passive bonus building damage.",
        effect: "boomtinker:E",
        flavor: "self-buff",
        key: "E",
        manaCost: [50, 55, 60, 65],
        name: "Powder Keg",
        targeting: "none",
        values: {
          attacks: [3, 4, 5, 6],
          passiveBuildingPct: [10, 15, 20, 25],
          splashPct: [50, 60, 70, 80],
          splashRadius: 160,
        },
      }),
      Q: ab({
        castRange: 520,
        cooldown: [7, 6.5, 6, 5.5],
        desc: "Dynamite explodes for magic damage in an area; BONUS vs buildings.",
        effect: "boomtinker:Q",
        flavor: "skillshot-aoe",
        key: "Q",
        manaCost: [65, 75, 85, 95],
        name: "Lob Dynamite",
        targeting: "point",
        values: {
          buildingBonusPct: 60,
          damage: [80, 125, 170, 215],
          projectileSpeed: 650,
          radius: 160,
        },
      }),
      R: ab({
        castRange: 900,
        cooldown: [100, 90, 80],
        desc: "Sprint with a megabomb (unstoppable), then SLAM for huge AoE + STUN.",
        effect: "boomtinker:R",
        flavor: "dash slam",
        key: "R",
        manaCost: [140, 180, 220],
        name: "Demolition Run",
        targeting: "point",
        values: {
          buildingBonusPct: 100,
          damage: [220, 320, 420],
          dashSpeed: 220,
          maxDash: 2.5,
          radius: 280,
          stun: [1.2, 1.5, 1.8],
        },
      }),
      W: ab({
        castRange: 500,
        cooldown: [9, 8, 7, 6],
        desc: "Plant a hidden mine; arms then detonates near an enemy for burst + SLOW.",
        effect: "boomtinker:W",
        flavor: "summon",
        key: "W",
        manaCost: [60, 70, 80, 90],
        name: "Proximity Mines",
        targeting: "point",
        values: {
          armDelay: 1.2,
          damage: [70, 110, 150, 190],
          lifetime: 45,
          maxMines: [3, 4, 5, 6],
          slowPct: 25,
          triggerRadius: 140,
        },
      }),
    },
    attackType: "melee",
    base: {
      armor: 2,
      attackRange: 120,
      attackSpeed: 0.62,
      damage: 44,
      hp: 560,
      hpRegen: 2.2,
      moveSpeed: 305,
      mp: 240,
      mpRegen: 0.9,
      projectileSpeed: 0,
    },
    blurb:
      "Demolitions pusher. Chunk towers with dynamite, zone with mines, splash waves, then megabomb a stunned clump. Ends games.",
    growth: {
      armor: 0.34,
      attackSpeed: 0.012,
      damage: 3,
      hp: 70,
      hpRegen: 0.18,
      mp: 15,
      mpRegen: 0.05,
    },
    id: "boomtinker",
    name: "Fizzle",
    role: "Pusher / Sapper",
    sheet: "tnt",
    tint: 0xff_d2_4d,
    title: "Boomtinker",
  },
  {
    abilities: {
      E: ab({
        castRange: 0,
        cooldown: [18, 17, 16, 15],
        desc: "Grant nearby allies a SHIELD + bonus armor.",
        effect: "brewkeeper:E",
        flavor: "self-buff aura",
        key: "E",
        manaCost: [70, 80, 90, 100],
        name: "Warding Keg",
        targeting: "none",
        values: {
          auraRadius: 450,
          bonusArmor: [2, 3, 4, 5],
          duration: 5,
          shield: [70, 120, 170, 220],
        },
      }),
      Q: ab({
        castRange: 550,
        cooldown: [8, 7.5, 7, 6.5],
        desc: "Splash ale on an ally (or self): instant HEAL + regen over time.",
        effect: "brewkeeper:Q",
        flavor: "targeted-unit heal",
        key: "Q",
        manaCost: [75, 85, 95, 105],
        name: "Restoring Brew",
        targeting: "unit",
        values: { heal: [80, 130, 180, 230], regenDuration: 4, regenPerSec: [10, 15, 20, 25] },
      }),
      R: ab({
        castRange: 0,
        cooldown: [110, 100, 90],
        desc: "CHANNEL a great cask: a zone that rapidly restores HP/mana and cleanses slows.",
        effect: "brewkeeper:R",
        flavor: "channel point-aoe",
        key: "R",
        manaCost: [150, 190, 230],
        name: "Last Call",
        targeting: "point",
        values: {
          channel: [4, 5, 6],
          cleanse: true,
          healPerTick: [40, 60, 80],
          manaPerTick: [8, 12, 16],
          radius: 380,
          tick: 0.5,
        },
      }),
      W: ab({
        castRange: 600,
        cooldown: [16, 15, 14, 13],
        desc: "Shatters in an area: SILENCE + SLOW + minor magic damage.",
        effect: "brewkeeper:W",
        flavor: "skillshot-aoe",
        key: "W",
        manaCost: [80, 90, 100, 110],
        name: "Hex Bottle",
        targeting: "point",
        values: {
          damage: [50, 80, 110, 140],
          radius: 220,
          silence: [1.2, 1.6, 2, 2.4],
          slowPct: [25, 30, 35, 40],
        },
      }),
    },
    attackType: "melee",
    base: {
      armor: 3,
      attackRange: 95,
      attackSpeed: 0.6,
      damage: 38,
      hp: 600,
      hpRegen: 2.6,
      moveSpeed: 295,
      mp: 320,
      mpRegen: 1.2,
      projectileSpeed: 0,
    },
    blurb:
      "Team support. Heal saves, silence-slow the enemy initiation, shield the frontline, then pour a great cask to out-sustain a teamfight.",
    growth: {
      armor: 0.36,
      attackSpeed: 0.01,
      damage: 2.6,
      hp: 72,
      hpRegen: 0.2,
      mp: 19,
      mpRegen: 0.08,
    },
    id: "brewkeeper",
    name: "Old Bramblecask",
    role: "Support / Healer",
    sheet: "barrel",
    tint: 0xc8_a0_6a,
    title: "the Brewkeeper",
  },
];

export const HERO_BY_ID: Record<string, HeroDef> = Object.fromEntries(HEROES.map((h) => [h.id, h]));

const failEmptyHeroes = (): never => {
  throw new Error("HEROES must not be empty");
};

/** Fallback definition (ironvow) for lookups by an unknown hero id. */
export const DEFAULT_HERO: HeroDef = HEROES[0] ?? failEmptyHeroes();

export const heroStatAt = (h: HeroDef, stat: keyof HeroStats, level: number): number => {
  const base = h.base[stat];
  const g = h.growth[stat] ?? 0;
  return base + g * (level - 1);
};
