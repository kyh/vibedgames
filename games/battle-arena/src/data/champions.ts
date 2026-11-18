import type { AbilityKey } from "../sim/types";
import type { DamageType } from "./config";

export type Targeting = "direction" | "ground" | "self" | "dash" | "passive";

export interface AbilityDef {
  key: AbilityKey;
  name: string;
  effect: string;
  targeting: Targeting;
  manaCost: number[];
  cooldown: number[];
  castRange: number;
  maxRank: number;
  isUltimate: boolean;
  values: Record<string, number[]>;
  desc: string;
}

export interface ChampStats {
  hp: number;
  mp: number;
  hpRegen: number;
  mpRegen: number;
  damage: number;
  armor: number;
  attackRange: number;
  attackSpeed: number;
  moveSpeed: number;
  projectileSpeed: number;
}

export interface RhythmStep {
  timeMult: number;
  dmgMult: number;
  aoe?: number;
  slow?: { pct: number; dur: number };
}

export interface ChampDef {
  id: string;
  name: string;
  title: string;
  role: string;
  primary: "str" | "agi" | "int";
  attackType: "melee" | "ranged";
  attackDamageType: DamageType;
  attackKind: string;
  model: string;
  weaponR?: string;
  weaponL?: string;
  cleaveTargets?: number;
  basic?: { pierce?: boolean; splash?: number };
  basicRhythm?: RhythmStep[];
  rig?: "large";
  twoHanded?: boolean;
  scale?: number;
  radius?: number;
  tint: number;
  blurb: string;
  difficulty: 1 | 2 | 3;
  base: ChampStats;
  growth: Partial<ChampStats>;
  attr: { str: number; agi: number; int: number };
  abilities: Record<AbilityKey, AbilityDef>;
}

/** Per-rank value, 1-based rank, clamps to ends. */
export const valAt = (arr: number[] | undefined, rank: number) => {
  if (!arr || arr.length === 0) {
    return 0;
  }

  const i = Math.max(0, Math.min(arr.length - 1, rank - 1));

  return arr[i] ?? 0;
};

/** Stat at a given level = base + growth × (level-1). */
export const champStatAt = (def: ChampDef, key: keyof ChampStats, level: number) => {
  const base = def.base[key];
  const g = def.growth[key] ?? 0;

  return base + g * (level - 1);
};

const ab = (d: Omit<AbilityDef, "isUltimate" | "maxRank"> & { maxRank?: number }) => ({
  ...d,
  isUltimate: d.key === "R",
  maxRank: d.maxRank ?? (d.key === "R" ? 3 : 4),
});

export const CHAMPIONS: ChampDef[] = [
  {
    abilities: {
      DASH: ab({
        castRange: 7,
        cooldown: [6],
        desc: "Barrel forward, briefly unstoppable.",
        effect: "knight:DASH",
        key: "DASH",
        manaCost: [0],
        maxRank: 1,
        name: "Charge",
        targeting: "dash",
        values: { iframe: [0.24], speed: [26] },
      }),
      E: ab({
        castRange: 0,
        cooldown: [16, 15, 14, 13],
        desc: "Plant your feet — a shield of will absorbs damage and steadies your march.",
        effect: "knight:E",
        key: "E",
        manaCost: [0, 0, 0, 0],
        name: "Iron Stance",
        targeting: "self",
        values: { duration: [4, 4, 4, 4], shield: [120, 200, 280, 360], speed: [16, 18, 20, 22] },
      }),
      JUMP: ab({
        castRange: 5,
        cooldown: [8],
        desc: "Leap and bring the greatsword down — a slowing shockwave on landing.",
        effect: "knight:JUMP",
        key: "JUMP",
        manaCost: [0],
        maxRank: 1,
        name: "Skyfall Cleave",
        targeting: "self",
        values: { base: [90], perLevel: [9], radius: [2.6], slow: [25], slowDur: [1] },
      }),
      Q: ab({
        castRange: 3.6,
        cooldown: [8, 7.5, 7, 6.5],
        desc: "A sweeping two-handed arc — damage and stun everyone in front.",
        effect: "knight:Q",
        key: "Q",
        manaCost: [0, 0, 0, 0],
        name: "Cleaving Blow",
        targeting: "direction",
        values: {
          cone: [90, 90, 90, 90],
          damage: [125, 170, 215, 260],
          stun: [0.7, 0.9, 1.05, 1.2],
        },
      }),
      R: ab({
        castRange: 0,
        cooldown: [70, 62, 54],
        desc: "Spin in a deadly cyclone, shredding and slowing all around you.",
        effect: "knight:R",
        key: "R",
        manaCost: [0, 0, 0],
        name: "Whirlwind",
        targeting: "self",
        values: {
          dps: [220, 290, 360],
          duration: [2.4, 2.6, 2.8],
          radius: [4.5, 5, 5.5],
          slow: [30, 35, 40],
        },
      }),
      W: ab({
        castRange: 7,
        cooldown: [10, 9.5, 9, 8.5],
        desc: "Slam a fissure forward, damaging and slowing a line of enemies.",
        effect: "knight:W",
        key: "W",
        manaCost: [0, 0, 0, 0],
        name: "Seismic Slam",
        targeting: "direction",
        values: {
          damage: [125, 175, 225, 275],
          slow: [25, 25, 30, 30],
          slowDur: [1, 1, 1.25, 1.25],
          width: [2, 2, 2, 2],
        },
      }),
    },
    attackDamageType: "physical",
    attackKind: "melee",
    attackType: "melee",
    attr: { agi: 14, int: 12, str: 26 },
    base: {
      armor: 4,
      attackRange: 2.3,
      attackSpeed: 1.2,
      damage: 46,
      hp: 640,
      hpRegen: 4.5,
      moveSpeed: 6,
      mp: 240,
      mpRegen: 1.6,
      projectileSpeed: 0,
    },
    basicRhythm: [
      { dmgMult: 1, timeMult: 1 },
      { dmgMult: 1, timeMult: 1 },
      { aoe: 4, dmgMult: 2.5, timeMult: 1.92 },
    ],
    blurb: "A walking wall. Stun, charge in, and spin the throne to bloody mulch.",
    difficulty: 1,
    growth: {
      armor: 0.7,
      attackSpeed: 0.018,
      damage: 5,
      hp: 92,
      hpRegen: 0.45,
      mp: 20,
      mpRegen: 0.12,
    },
    id: "knight",
    model: "Knight",
    name: "Garran",
    primary: "str",
    role: "Frontline Bruiser",
    tint: 0x4f_86_ff,
    title: "the Bulwark",
    twoHanded: true,
    weaponR: "sword_2handed",
  },
  {
    abilities: {
      DASH: ab({
        castRange: 7,
        cooldown: [5],
        desc: "Combat roll — briefly untargetable.",
        effect: "ranger:DASH",
        key: "DASH",
        manaCost: [0],
        maxRank: 1,
        name: "Roll",
        targeting: "dash",
        values: { iframe: [0.28], speed: [30] },
      }),
      E: ab({
        castRange: 10,
        cooldown: [14, 13, 12, 11],
        desc: "Arm a trap — first enemy in is rooted and hurt.",
        effect: "ranger:E",
        key: "E",
        manaCost: [0, 0, 0, 0],
        name: "Snare Trap",
        targeting: "ground",
        values: {
          damage: [95, 130, 160, 190],
          life: [8, 8, 8, 8],
          radius: [2.2, 2.2, 2.4, 2.4],
          root: [1.2, 1.5, 1.8, 2.1],
        },
      }),
      JUMP: ab({
        castRange: 0,
        cooldown: [8],
        desc: "Spring up, spin, and loose arrows in every direction — untouchable until you land.",
        effect: "ranger:JUMP",
        key: "JUMP",
        manaCost: [0],
        maxRank: 1,
        name: "Tempest Volley",
        targeting: "self",
        values: {
          air: [0.88],
          damage: [58],
          iframe: [1],
          perLevel: [6],
          radius: [3.2],
          shots: [9],
        },
      }),
      Q: ab({
        castRange: 10,
        cooldown: [6, 5.5, 5, 4.5],
        desc: "Loose a fan of arrows.",
        effect: "ranger:Q",
        key: "Q",
        manaCost: [0, 0, 0, 0],
        name: "Multishot",
        targeting: "direction",
        values: { arrows: [3, 3, 5, 5], damage: [65, 90, 115, 135], spread: [22, 22, 26, 26] },
      }),
      R: ab({
        castRange: 14,
        cooldown: [60, 54, 48],
        desc: "Blanket a wide area in arrows.",
        effect: "ranger:R",
        key: "R",
        manaCost: [0, 0, 0],
        name: "Rain of Arrows",
        targeting: "ground",
        values: {
          dps: [200, 260, 320],
          duration: [3, 3.2, 3.4],
          radius: [5.5, 6, 6.5],
          slow: [25, 30, 35],
        },
      }),
      W: ab({
        castRange: 0,
        cooldown: [14, 13, 12, 11],
        desc: "Draw a bead — attack and move faster for a few seconds.",
        effect: "ranger:W",
        key: "W",
        manaCost: [0, 0, 0, 0],
        name: "Hunter's Focus",
        targeting: "self",
        values: {
          atkSpeed: [30, 35, 40, 45],
          duration: [4, 4.5, 5, 5.5],
          moveSpeed: [12, 14, 16, 18],
        },
      }),
    },
    attackDamageType: "physical",
    attackKind: "arrow",
    attackType: "ranged",
    attr: { agi: 26, int: 14, str: 15 },
    base: {
      armor: 2,
      attackRange: 12,
      attackSpeed: 0.9,
      damage: 48,
      hp: 490,
      hpRegen: 3,
      moveSpeed: 6.5,
      mp: 280,
      mpRegen: 2,
      projectileSpeed: 35,
    },
    basic: { pierce: true },
    basicRhythm: [
      { dmgMult: 1, timeMult: 1 },
      { dmgMult: 1, timeMult: 1 },
      { dmgMult: 1.25, slow: { dur: 1.2, pct: 30 }, timeMult: 1.15 },
    ],
    blurb: "Death at range. Spread shots, dodge rolls, and a sky full of arrows.",
    difficulty: 2,
    growth: {
      armor: 0.5,
      attackSpeed: 0.03,
      damage: 5.5,
      hp: 72,
      hpRegen: 0.3,
      mp: 22,
      mpRegen: 0.16,
    },
    id: "ranger",
    model: "Ranger",
    name: "Sylva",
    primary: "agi",
    role: "Kiting Carry",
    tint: 0x49_d6_7a,
    title: "the Keen",
    weaponL: "bow",
  },
  {
    abilities: {
      DASH: ab({
        castRange: 9,
        cooldown: [6],
        desc: "Teleport a short distance instantly.",
        effect: "mage:DASH",
        key: "DASH",
        manaCost: [0],
        maxRank: 1,
        name: "Blink",
        targeting: "dash",
        values: { iframe: [0.22], range: [9] },
      }),
      E: ab({
        castRange: 10,
        cooldown: [12, 11, 10, 9],
        desc: "Rain embers over an area — burns and slows all who stand in it.",
        effect: "mage:E",
        key: "E",
        manaCost: [0, 0, 0, 0],
        name: "Cinderfall",
        targeting: "ground",
        values: {
          dps: [70, 100, 130, 160],
          duration: [4, 4, 4, 4],
          radius: [3, 3.2, 3.4, 3.6],
          slow: [15, 15, 20, 20],
        },
      }),
      JUMP: ab({
        castRange: 0,
        cooldown: [9],
        desc: "Rise, hang, and detonate a wheel of fire around you — untouchable until you land.",
        effect: "mage:JUMP",
        key: "JUMP",
        manaCost: [0],
        maxRank: 1,
        name: "Emberburst",
        targeting: "self",
        values: {
          air: [0.88],
          damage: [62],
          iframe: [1],
          perLevel: [7],
          radius: [3.4],
          shots: [7],
          splash: [1.7],
        },
      }),
      Q: ab({
        castRange: 11,
        cooldown: [5, 4.6, 4.2, 3.8],
        desc: "Hurl a fireball that bursts on impact.",
        effect: "mage:Q",
        key: "Q",
        manaCost: [0, 0, 0, 0],
        name: "Fireball",
        targeting: "direction",
        values: { damage: [150, 200, 250, 300], radius: [2.6, 2.8, 3, 3.2] },
      }),
      R: ab({
        castRange: 13,
        cooldown: [75, 66, 57],
        desc: "Call down a meteor after a brief telegraph — massive burst.",
        effect: "mage:R",
        key: "R",
        manaCost: [0, 0, 0],
        name: "Meteor",
        targeting: "ground",
        values: {
          damage: [420, 600, 780],
          delay: [1.2, 1.2, 1.2],
          radius: [4.5, 5, 5.5],
          slow: [40, 45, 50],
        },
      }),
      W: ab({
        castRange: 9,
        cooldown: [10, 9, 8, 7],
        desc: "Detonate a ring of frost — damage and heavy slow.",
        effect: "mage:W",
        key: "W",
        manaCost: [0, 0, 0, 0],
        name: "Frost Nova",
        targeting: "ground",
        values: {
          damage: [130, 175, 220, 265],
          radius: [3.2, 3.4, 3.6, 3.8],
          slow: [35, 40, 45, 50],
          slowDur: [2, 2.2, 2.4, 2.6],
        },
      }),
    },
    attackDamageType: "magic",
    attackKind: "bolt",
    attackType: "ranged",
    attr: { agi: 13, int: 28, str: 13 },
    base: {
      armor: 1,
      attackRange: 11,
      attackSpeed: 0.78,
      damage: 44,
      hp: 450,
      hpRegen: 2.6,
      moveSpeed: 6.2,
      mp: 400,
      mpRegen: 3,
      projectileSpeed: 27,
    },
    basic: { splash: 1.6 },
    basicRhythm: [
      { dmgMult: 1, timeMult: 1 },
      { dmgMult: 1, timeMult: 1 },
      { dmgMult: 1.25, slow: { dur: 1, pct: 25 }, timeMult: 1.15 },
    ],
    blurb: "Glass and fire. Nuke from afar, freeze the brave, and drop a meteor on the throne.",
    difficulty: 2,
    growth: {
      armor: 0.4,
      attackSpeed: 0.014,
      damage: 4.5,
      hp: 66,
      hpRegen: 0.26,
      mp: 36,
      mpRegen: 0.24,
    },
    id: "mage",
    model: "Mage",
    name: "V-yx",
    primary: "int",
    role: "Burst Caster",
    tint: 0xc0_60_ff,
    title: "the Emberhex",
    weaponR: "staff",
  },
  {
    abilities: {
      DASH: ab({
        castRange: 8,
        cooldown: [5],
        desc: "Slip through shadow — briefly untargetable.",
        effect: "rogue:DASH",
        key: "DASH",
        manaCost: [0],
        maxRank: 1,
        name: "Shadowstep",
        targeting: "dash",
        values: { iframe: [0.26], speed: [34] },
      }),
      E: ab({
        castRange: 0,
        cooldown: [18, 16, 14, 12],
        desc: "Vanish in smoke — your first strike from the shadows CRITS for double damage.",
        effect: "rogue:E",
        key: "E",
        manaCost: [0, 0, 0, 0],
        name: "Smoke",
        targeting: "self",
        values: { duration: [3, 3.5, 4, 4.5], speed: [22, 24, 26, 28] },
      }),
      JUMP: ab({
        castRange: 5,
        cooldown: [7],
        desc: "Plunge from above with both blades — a tight burst on landing.",
        effect: "rogue:JUMP",
        key: "JUMP",
        manaCost: [0],
        maxRank: 1,
        name: "Deathfall",
        targeting: "self",
        values: { base: [110], perLevel: [10], radius: [1.8], slow: [20], slowDur: [0.75] },
      }),
      Q: ab({
        castRange: 4.5,
        cooldown: [7, 6.5, 6, 5.5],
        desc: "Lunge and coat the target in poison.",
        effect: "rogue:Q",
        key: "Q",
        manaCost: [0, 0, 0, 0],
        name: "Poison Lunge",
        targeting: "direction",
        values: {
          damage: [95, 135, 180, 225],
          dps: [40, 55, 70, 85],
          dur: [4, 4, 4, 4],
          speed: [22, 22, 22, 22],
        },
      }),
      R: ab({
        castRange: 6,
        cooldown: [70, 62, 54],
        desc: "Blink-strike the enemy ahead — lethal to the wounded.",
        effect: "rogue:R",
        key: "R",
        manaCost: [0, 0, 0],
        name: "Execute",
        targeting: "direction",
        values: { damage: [220, 310, 400], execMult: [3, 3.25, 3.5], speed: [40, 40, 40] },
      }),
      W: ab({
        castRange: 7,
        cooldown: [9, 8.5, 8, 7.5],
        desc: "Open a bleeding wound — the target bleeds and takes more damage.",
        effect: "rogue:W",
        key: "W",
        manaCost: [0, 0, 0, 0],
        name: "Rupture",
        targeting: "direction",
        values: {
          ampDur: [3, 3, 3.5, 3.5],
          bleedDps: [35, 50, 62, 75],
          bleedDur: [3, 3, 3, 3],
          damage: [95, 135, 180, 225],
          dmgAmp: [12, 15, 18, 21],
        },
      }),
    },
    attackDamageType: "physical",
    attackKind: "melee",
    attackType: "melee",
    attr: { agi: 28, int: 13, str: 15 },
    base: {
      armor: 2,
      attackRange: 2.2,
      attackSpeed: 1.4,
      damage: 44,
      hp: 480,
      hpRegen: 3,
      moveSpeed: 6.5,
      mp: 260,
      mpRegen: 1.8,
      projectileSpeed: 0,
    },
    blurb: "In, out, gone. Poison, vanish, and execute anyone clinging to life.",
    cleaveTargets: 1,
    difficulty: 3,
    growth: {
      armor: 0.6,
      attackSpeed: 0.035,
      damage: 6,
      hp: 70,
      hpRegen: 0.3,
      mp: 22,
      mpRegen: 0.14,
    },
    id: "rogue",
    model: "Rogue_Hooded",
    name: "Vesper",
    primary: "agi",
    role: "Assassin",
    tint: 0xff_5a_78,
    title: "the Veiled",
    weaponL: "dagger",
    weaponR: "dagger",
  },
  {
    abilities: {
      DASH: ab({
        castRange: 7,
        cooldown: [6.5],
        desc: "Advance like doom — briefly unstoppable.",
        effect: "blackknight:DASH",
        key: "DASH",
        manaCost: [0],
        maxRank: 1,
        name: "Dread March",
        targeting: "dash",
        values: { iframe: [0.24], speed: [20] },
      }),
      E: ab({
        castRange: 0,
        cooldown: [16, 15, 14, 13],
        desc: "Become the wall — armor up and mend while you march.",
        effect: "blackknight:E",
        key: "E",
        manaCost: [0, 0, 0, 0],
        name: "Iron Bastion",
        targeting: "self",
        values: { armor: [8, 12, 16, 20], duration: [4, 4, 4, 4], hps: [30, 45, 60, 75] },
      }),
      JUMP: ab({
        castRange: 5,
        cooldown: [9],
        desc: "Leap and shatter the earth — a wide stunning slam.",
        effect: "blackknight:JUMP",
        key: "JUMP",
        manaCost: [0],
        maxRank: 1,
        name: "Dawnbreaker",
        targeting: "self",
        values: { base: [100], perLevel: [9], radius: [3], stun: [0.4] },
      }),
      Q: ab({
        castRange: 3.8,
        cooldown: [6, 5.5, 5, 4.5],
        desc: "A vast sweeping cut — carve and slow everyone in front.",
        effect: "blackknight:Q",
        key: "Q",
        manaCost: [0, 0, 0, 0],
        name: "Executioner's Arc",
        targeting: "direction",
        values: {
          cone: [110, 110, 110, 110],
          damage: [140, 190, 240, 290],
          slow: [20, 20, 20, 20],
          slowDur: [1, 1, 1, 1],
        },
      }),
      R: ab({
        castRange: 0,
        cooldown: [70, 62, 54],
        desc: "Bring the hammer down — everything nearby is thrown and stunned.",
        effect: "blackknight:R",
        key: "R",
        manaCost: [0, 0, 0],
        name: "Oblivion Slam",
        targeting: "self",
        values: {
          damage: [360, 500, 640],
          knockback: [8, 8, 8],
          radius: [4.5, 5, 5.5],
          stun: [0.8, 1, 1.2],
        },
      }),
      W: ab({
        castRange: 8,
        cooldown: [11, 10.5, 10, 9.5],
        desc: "Call down a pillar of holy light — damage and stun where it lands.",
        effect: "blackknight:W",
        key: "W",
        manaCost: [0, 0, 0, 0],
        name: "Consecrating Smite",
        targeting: "ground",
        values: {
          damage: [130, 180, 230, 285],
          radius: [2.4, 2.6, 2.8, 3],
          stun: [0.5, 0.6, 0.7, 0.8],
        },
      }),
    },
    attackDamageType: "physical",
    attackKind: "melee",
    attackType: "melee",
    attr: { agi: 8, int: 10, str: 30 },
    base: {
      armor: 5,
      attackRange: 2.6,
      attackSpeed: 0.85,
      damage: 58,
      hp: 720,
      hpRegen: 5,
      moveSpeed: 5.6,
      mp: 220,
      mpRegen: 1.4,
      projectileSpeed: 0,
    },
    blurb: "A holy wall with a hammer. Stand where he stands, or learn how cathedrals fall.",
    difficulty: 1,
    growth: {
      armor: 0.8,
      attackSpeed: 0.014,
      damage: 6,
      hp: 100,
      hpRegen: 0.5,
      mp: 18,
      mpRegen: 0.1,
    },
    id: "blackknight",
    model: "Paladin_with_Helmet",
    name: "Aurelius",
    primary: "str",
    radius: 0.75,
    role: "Juggernaut",
    scale: 1.06,
    tint: 0xff_d7_6a,
    title: "the Dawnward",
    weaponL: "paladin_shield",
    weaponR: "paladin_hammer",
  },
  {
    abilities: {
      DASH: ab({
        castRange: 9,
        cooldown: [5.5],
        desc: "Take to the broom — a quick, untargetable dash.",
        effect: "witch:DASH",
        key: "DASH",
        manaCost: [0],
        maxRank: 1,
        name: "Broom Surge",
        targeting: "dash",
        values: { iframe: [0.22], speed: [24] },
      }),
      E: ab({
        castRange: 8,
        cooldown: [13, 12, 11, 10],
        desc: "Vines erupt from the bog — damage and root everyone caught.",
        effect: "witch:E",
        key: "E",
        manaCost: [0, 0, 0, 0],
        name: "Bog Grasp",
        targeting: "ground",
        values: {
          damage: [95, 130, 160, 190],
          radius: [2.2, 2.2, 2.4, 2.4],
          root: [1, 1.25, 1.5, 1.75],
        },
      }),
      JUMP: ab({
        castRange: 5,
        cooldown: [8],
        desc: "Dive off the broom — a cursed burst that slows on landing.",
        effect: "witch:JUMP",
        key: "JUMP",
        manaCost: [0],
        maxRank: 1,
        name: "Hexfall",
        targeting: "self",
        values: { base: [90], perLevel: [8], radius: [2.8], slow: [25], slowDur: [1] },
      }),
      Q: ab({
        castRange: 9,
        cooldown: [7, 6.5, 6, 5.5],
        desc: "Spit a curdled bolt — damage and slow whoever it strikes.",
        effect: "witch:Q",
        key: "Q",
        manaCost: [0, 0, 0, 0],
        name: "Hex Bolt",
        targeting: "direction",
        values: {
          damage: [125, 165, 210, 255],
          slow: [20, 25, 30, 35],
          slowDur: [1.2, 1.2, 1.2, 1.2],
          speed: [18, 18, 18, 18],
        },
      }),
      R: ab({
        castRange: 8,
        cooldown: [80, 70, 60],
        desc: "Tear a void open over the ground — everyone it swallows becomes a harmless mushroom.",
        effect: "witch:R",
        key: "R",
        manaCost: [0, 0, 0],
        name: "Grand Hex",
        targeting: "ground",
        values: { duration: [2, 2.4, 2.8], radius: [4, 4.5, 5], slow: [40, 40, 40] },
      }),
      W: ab({
        castRange: 8,
        cooldown: [13, 12, 11, 10],
        desc: "Spill the cauldron — acid eats the floor, burning and slowing all who wade in.",
        effect: "witch:W",
        key: "W",
        manaCost: [0, 0, 0, 0],
        name: "Cauldron Brew",
        targeting: "ground",
        values: {
          dps: [75, 105, 140, 170],
          duration: [4, 4, 4, 4],
          radius: [3.2, 3.4, 3.6, 3.8],
          slow: [25, 30, 35, 40],
        },
      }),
    },
    attackDamageType: "magic",
    attackKind: "bolt",
    attackType: "ranged",
    attr: { agi: 14, int: 26, str: 12 },
    base: {
      armor: 2,
      attackRange: 7.5,
      attackSpeed: 1.05,
      damage: 42,
      hp: 500,
      hpRegen: 3.2,
      moveSpeed: 6,
      mp: 300,
      mpRegen: 2.2,
      projectileSpeed: 16,
    },
    basic: { splash: 1.6 },
    blurb: "Curses bubble, brooms fly, and her enemies make lovely mushrooms.",
    difficulty: 3,
    growth: {
      armor: 0.5,
      attackSpeed: 0.02,
      damage: 4.2,
      hp: 72,
      hpRegen: 0.3,
      mp: 26,
      mpRegen: 0.18,
    },
    id: "witch",
    model: "Witch",
    name: "Grimelda",
    primary: "int",
    role: "Hex Zoner",
    tint: 0x7f_e0_8a,
    title: "the Bog Witch",
    weaponR: "wand_A",
  },
];

export const CHAMP_BY_ID: Record<string, ChampDef> = Object.fromEntries(
  CHAMPIONS.map((c) => [c.id, c]),
);

export const DEFAULT_CHAMP = "knight";
