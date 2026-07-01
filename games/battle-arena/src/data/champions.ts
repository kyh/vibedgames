// The champion roster (build-doc §7). Pure data: stats, per-level growth, and
// data-driven ability defs. The ability `effect` tag is dispatched by a switch
// in sim/abilities.ts. Values are per-rank arrays read with valAt().
//
// Mapped to KayKit Adventurers/Skeletons models (all share the Rig_Medium
// skeleton → one shared clip library animates every champion).
import type { AbilityKey } from "../sim/types";
import type { DamageType } from "./config";

export type Targeting =
  | "direction" // skillshot aimed by the mouse/right-stick
  | "ground" // AoE placed at a point (clamped to castRange)
  | "self" // centered on the caster
  | "dash" // movement burst along the aim direction
  | "passive";

export type AbilityDef = {
  key: AbilityKey;
  name: string;
  effect: string; // "<champId>:<key>" — the dispatch tag
  targeting: Targeting;
  manaCost: number[];
  cooldown: number[]; // seconds, per rank
  castRange: number;
  maxRank: number;
  isUltimate: boolean;
  values: Record<string, number[]>;
  desc: string;
};

export type ChampStats = {
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
};

export type ChampDef = {
  id: string;
  name: string;
  title: string;
  role: string;
  primary: "str" | "agi" | "int";
  attackType: "melee" | "ranged";
  attackDamageType: DamageType;
  attackKind: string; // projectile visual for ranged; "melee" for melee
  model: string; // GLB basename under public/models/characters
  weaponR?: string; // weapon model attached to handslot.r
  weaponL?: string; // weapon/shield attached to handslot.l
  cleaveTargets?: number; // max enemies a basic attack damages (default 3; rogue 1)
  tint: number; // fallback identity color (team color overrides in-match)
  blurb: string;
  base: ChampStats;
  growth: Partial<ChampStats>;
  attr: { str: number; agi: number; int: number };
  abilities: Record<AbilityKey, AbilityDef>;
};

/** Per-rank value, 1-based rank, clamps to ends. */
export function valAt(arr: number[] | undefined, rank: number): number {
  if (!arr || arr.length === 0) return 0;
  const i = Math.max(0, Math.min(arr.length - 1, rank - 1));
  return arr[i]!;
}

/** Stat at a given level = base + growth × (level-1). */
export function champStatAt(def: ChampDef, key: keyof ChampStats, level: number): number {
  const base = def.base[key];
  const g = def.growth[key] ?? 0;
  return base + g * (level - 1);
}

const ab = (d: Omit<AbilityDef, "isUltimate" | "maxRank"> & { maxRank?: number }): AbilityDef => ({
  ...d,
  isUltimate: d.key === "R",
  maxRank: d.maxRank ?? (d.key === "R" ? 3 : 4),
});

// ──────────────────────────────────────────────────────────────────────────
export const CHAMPIONS: ChampDef[] = [
  {
    id: "knight",
    name: "Garran",
    title: "the Bulwark",
    role: "Frontline Bruiser",
    primary: "str",
    attackType: "melee",
    attackDamageType: "physical",
    attackKind: "melee",
    model: "Knight",
    weaponR: "sword_1handed",
    weaponL: "shield_round",
    tint: 0x4f86ff,
    blurb: "A walking wall. Stun, charge in, and spin the throne to bloody mulch.",
    base: { hp: 640, mp: 240, hpRegen: 4.5, mpRegen: 1.6, damage: 46, armor: 4, attackRange: 2.3, attackSpeed: 1.2, moveSpeed: 6.0, projectileSpeed: 0 },
    growth: { hp: 92, mp: 20, hpRegen: 0.45, mpRegen: 0.12, damage: 5, armor: 0.7, attackSpeed: 0.018 },
    attr: { str: 26, agi: 14, int: 12 },
    abilities: {
      Q: ab({ key: "Q", name: "Shield Bash", effect: "knight:Q", targeting: "direction", castRange: 3.2, manaCost: [60, 65, 70, 75], cooldown: [8, 7.5, 7, 6.5], values: { damage: [70, 110, 150, 190], stun: [0.7, 0.9, 1.05, 1.2], cone: [70, 70, 70, 70] }, desc: "Bash a frontal arc — damage and stun." }),
      W: ab({ key: "W", name: "Charge", effect: "knight:W", targeting: "dash", castRange: 9, manaCost: [70, 75, 80, 85], cooldown: [11, 10, 9, 8], values: { damage: [60, 100, 140, 180], knockback: [6, 7, 8, 9], speed: [26, 26, 26, 26] }, desc: "Barrel forward, knocking back everyone you hit." }),
      E: ab({ key: "E", name: "Bulwark", effect: "knight:E", targeting: "self", castRange: 0, manaCost: [50, 55, 60, 65], cooldown: [16, 15, 14, 13], values: { shield: [120, 200, 280, 360], duration: [4, 4, 4, 4], speed: [16, 18, 20, 22] }, desc: "Raise a shield and surge — absorb damage and move faster." }),
      R: ab({ key: "R", name: "Whirlwind", effect: "knight:R", targeting: "self", castRange: 0, manaCost: [120, 140, 160], cooldown: [70, 62, 54], values: { dps: [140, 200, 260], radius: [4.5, 5, 5.5], duration: [2.4, 2.6, 2.8], slow: [30, 35, 40] }, desc: "Spin in a deadly cyclone, shredding and slowing all around you." }),
    },
  },
  {
    id: "ranger",
    name: "Sylva",
    title: "the Keen",
    role: "Kiting Carry",
    primary: "agi",
    attackType: "ranged",
    attackDamageType: "physical",
    attackKind: "arrow",
    model: "Ranger",
    weaponL: "bow",
    tint: 0x49d67a,
    blurb: "Death at range. Spread shots, dodge rolls, and a sky full of arrows.",
    base: { hp: 490, mp: 280, hpRegen: 3.0, mpRegen: 2.0, damage: 48, armor: 2, attackRange: 9.5, attackSpeed: 0.9, moveSpeed: 6.2, projectileSpeed: 26 },
    growth: { hp: 72, mp: 22, hpRegen: 0.3, mpRegen: 0.16, damage: 5.5, armor: 0.5, attackSpeed: 0.03 },
    attr: { str: 15, agi: 26, int: 14 },
    abilities: {
      Q: ab({ key: "Q", name: "Multishot", effect: "ranger:Q", targeting: "direction", castRange: 10, manaCost: [55, 60, 65, 70], cooldown: [6, 5.5, 5, 4.5], values: { damage: [55, 85, 115, 145], arrows: [3, 3, 5, 5], spread: [22, 22, 26, 26] }, desc: "Loose a fan of arrows." }),
      W: ab({ key: "W", name: "Roll", effect: "ranger:W", targeting: "dash", castRange: 7, manaCost: [40, 40, 40, 40], cooldown: [9, 8, 7, 6], values: { speed: [30, 30, 30, 30], invuln: [0.3, 0.35, 0.4, 0.45] }, desc: "Dodge roll, briefly untargetable." }),
      E: ab({ key: "E", name: "Snare Trap", effect: "ranger:E", targeting: "ground", castRange: 10, manaCost: [60, 65, 70, 75], cooldown: [14, 13, 12, 11], values: { damage: [40, 70, 100, 130], root: [1.2, 1.5, 1.8, 2.1], radius: [2.2, 2.2, 2.4, 2.4], life: [8, 8, 8, 8] }, desc: "Arm a trap — first enemy in is rooted and hurt." }),
      R: ab({ key: "R", name: "Rain of Arrows", effect: "ranger:R", targeting: "ground", castRange: 14, manaCost: [110, 130, 150], cooldown: [60, 54, 48], values: { dps: [130, 180, 230], radius: [5.5, 6, 6.5], duration: [3, 3.2, 3.4], slow: [25, 30, 35] }, desc: "Blanket a wide area in arrows." }),
    },
  },
  {
    id: "mage",
    name: "V-yx",
    title: "the Emberhex",
    role: "Burst Caster",
    primary: "int",
    attackType: "ranged",
    attackDamageType: "magic",
    attackKind: "bolt",
    model: "Mage",
    weaponR: "staff",
    tint: 0xc060ff,
    blurb: "Glass and fire. Nuke from afar, freeze the brave, and drop a meteor on the throne.",
    base: { hp: 450, mp: 400, hpRegen: 2.6, mpRegen: 3.0, damage: 44, armor: 1, attackRange: 8.5, attackSpeed: 0.78, moveSpeed: 5.9, projectileSpeed: 20 },
    growth: { hp: 66, mp: 36, hpRegen: 0.26, mpRegen: 0.24, damage: 4.5, armor: 0.4, attackSpeed: 0.014 },
    attr: { str: 13, agi: 13, int: 28 },
    abilities: {
      Q: ab({ key: "Q", name: "Fireball", effect: "mage:Q", targeting: "direction", castRange: 11, manaCost: [70, 80, 90, 100], cooldown: [5, 4.6, 4.2, 3.8], values: { damage: [80, 130, 180, 230], radius: [2.6, 2.8, 3.0, 3.2] }, desc: "Hurl a fireball that bursts on impact." }),
      W: ab({ key: "W", name: "Frost Nova", effect: "mage:W", targeting: "ground", castRange: 9, manaCost: [70, 80, 90, 100], cooldown: [10, 9, 8, 7], values: { damage: [60, 95, 130, 165], slow: [35, 40, 45, 50], slowDur: [2, 2.2, 2.4, 2.6], radius: [3.2, 3.4, 3.6, 3.8] }, desc: "Detonate a ring of frost — damage and heavy slow." }),
      E: ab({ key: "E", name: "Blink", effect: "mage:E", targeting: "dash", castRange: 9, manaCost: [60, 55, 50, 45], cooldown: [14, 12, 10, 8], values: { range: [9, 9, 9, 9] }, desc: "Teleport a short distance instantly." }),
      R: ab({ key: "R", name: "Meteor", effect: "mage:R", targeting: "ground", castRange: 13, manaCost: [130, 160, 190], cooldown: [75, 66, 57], values: { damage: [260, 380, 520], radius: [4.5, 5, 5.5], delay: [1.2, 1.2, 1.2], slow: [40, 45, 50] }, desc: "Call down a meteor after a brief telegraph — massive burst." }),
    },
  },
  {
    id: "rogue",
    name: "Vesper",
    title: "the Veiled",
    role: "Assassin",
    primary: "agi",
    attackType: "melee",
    attackDamageType: "physical",
    attackKind: "melee",
    model: "Rogue_Hooded",
    weaponR: "dagger",
    weaponL: "dagger",
    cleaveTargets: 1, // single-target assassin — daggers don't cleave the cone
    tint: 0xff5a78,
    blurb: "In, out, gone. Poison, vanish, and execute anyone clinging to life.",
    base: { hp: 480, mp: 260, hpRegen: 3.0, mpRegen: 1.8, damage: 44, armor: 2, attackRange: 2.2, attackSpeed: 1.4, moveSpeed: 6.5, projectileSpeed: 0 },
    growth: { hp: 70, mp: 22, hpRegen: 0.3, mpRegen: 0.14, damage: 6, armor: 0.6, attackSpeed: 0.035 },
    attr: { str: 15, agi: 28, int: 13 },
    abilities: {
      Q: ab({ key: "Q", name: "Poison Lunge", effect: "rogue:Q", targeting: "direction", castRange: 4.5, manaCost: [45, 50, 55, 60], cooldown: [7, 6.5, 6, 5.5], values: { damage: [50, 80, 110, 140], dps: [30, 45, 60, 75], dur: [4, 4, 4, 4], speed: [22, 22, 22, 22] }, desc: "Lunge and coat the target in poison." }),
      W: ab({ key: "W", name: "Shadowstep", effect: "rogue:W", targeting: "dash", castRange: 8, manaCost: [50, 50, 50, 50], cooldown: [10, 9, 8, 7], values: { speed: [34, 34, 34, 34], bonus: [80, 130, 180, 230], stealth: [1.2, 1.4, 1.6, 1.8] }, desc: "Dash through shadow — your next strike hits far harder." }),
      E: ab({ key: "E", name: "Smoke", effect: "rogue:E", targeting: "self", castRange: 0, manaCost: [60, 60, 60, 60], cooldown: [18, 16, 14, 12], values: { duration: [3, 3.5, 4, 4.5], speed: [22, 24, 26, 28] }, desc: "Vanish in smoke and slip away (breaks on attack)." }),
      R: ab({ key: "R", name: "Execute", effect: "rogue:R", targeting: "direction", castRange: 6, manaCost: [100, 120, 140], cooldown: [70, 62, 54], values: { damage: [120, 180, 240], execMult: [3, 3.25, 3.5], speed: [40, 40, 40] }, desc: "Blink-strike the enemy ahead — lethal to the wounded." }),
    },
  },
  {
    id: "barbarian",
    name: "Brakka",
    title: "the Unbroken",
    role: "Berserker",
    primary: "str",
    attackType: "melee",
    attackDamageType: "physical",
    attackKind: "melee",
    model: "Barbarian",
    weaponR: "axe_2handed",
    tint: 0xff8a3c,
    blurb: "Leap in, cleave wide, and rage until the throne is yours or you're dead.",
    base: { hp: 600, mp: 290, hpRegen: 4.2, mpRegen: 2.0, damage: 54, armor: 3, attackRange: 2.4, attackSpeed: 1.05, moveSpeed: 6.1, projectileSpeed: 0 },
    growth: { hp: 86, mp: 24, hpRegen: 0.42, mpRegen: 0.14, damage: 6, armor: 0.6, attackSpeed: 0.022 },
    attr: { str: 25, agi: 16, int: 11 },
    abilities: {
      Q: ab({ key: "Q", name: "Cleave", effect: "barbarian:Q", targeting: "direction", castRange: 3.4, manaCost: [50, 55, 60, 65], cooldown: [5, 4.6, 4.2, 3.8], values: { damage: [80, 125, 170, 215], cone: [110, 110, 110, 110] }, desc: "A wide swing that carves everyone in front." }),
      W: ab({ key: "W", name: "Leap", effect: "barbarian:W", targeting: "ground", castRange: 9, manaCost: [70, 75, 80, 85], cooldown: [12, 11, 10, 9], values: { damage: [70, 110, 150, 190], radius: [3, 3.2, 3.4, 3.6], slow: [30, 35, 40, 45], speed: [22, 22, 22, 22] }, desc: "Leap and slam down, hurting and slowing all nearby." }),
      E: ab({ key: "E", name: "Bloodthirst", effect: "barbarian:E", targeting: "self", castRange: 0, manaCost: [55, 60, 65, 70], cooldown: [15, 14, 13, 12], values: { heal: [40, 70, 100, 130], dur: [4, 4, 4, 4], armor: [6, 9, 12, 15] }, desc: "Heal over time and toughen up." }),
      R: ab({ key: "R", name: "Enrage", effect: "barbarian:R", targeting: "self", castRange: 0, manaCost: [110, 130, 150], cooldown: [65, 58, 51], values: { attackSpeed: [50, 65, 80], speed: [24, 28, 32], regen: [60, 80, 100], dur: [6, 6.5, 7] }, desc: "Go berserk — strike faster, move faster, and bleed off the pain." }),
    },
  },
  {
    id: "necromancer",
    name: "Mordrah",
    title: "the Hollow",
    role: "Zoner",
    primary: "int",
    attackType: "ranged",
    attackDamageType: "magic",
    attackKind: "bolt",
    model: "Necromancer",
    weaponR: "Skeleton_Staff",
    tint: 0x7affb0,
    blurb: "Control the ground. Curse the brave, rot their path, and feed on the dying.",
    base: { hp: 500, mp: 360, hpRegen: 2.6, mpRegen: 2.8, damage: 46, armor: 1, attackRange: 8, attackSpeed: 0.8, moveSpeed: 6.05, projectileSpeed: 19 },
    growth: { hp: 68, mp: 32, hpRegen: 0.26, mpRegen: 0.22, damage: 4.6, armor: 0.4, attackSpeed: 0.015 },
    attr: { str: 13, agi: 14, int: 27 },
    abilities: {
      Q: ab({ key: "Q", name: "Bone Spear", effect: "necromancer:Q", targeting: "direction", castRange: 12, manaCost: [60, 70, 80, 90], cooldown: [5, 4.6, 4.2, 3.8], values: { damage: [80, 125, 170, 215] }, desc: "Fire a spear of bone that pierces everyone in its path." }),
      W: ab({ key: "W", name: "Curse", effect: "necromancer:W", targeting: "ground", castRange: 10, manaCost: [70, 80, 90, 100], cooldown: [12, 11, 10, 9], values: { damage: [40, 65, 90, 115], amp: [20, 25, 30, 35], dur: [4, 4, 4, 4], radius: [3.2, 3.4, 3.6, 3.8] }, desc: "Curse a zone — cursed enemies take extra damage." }),
      E: ab({ key: "E", name: "Decay", effect: "necromancer:E", targeting: "ground", castRange: 11, manaCost: [70, 80, 90, 100], cooldown: [13, 12, 11, 10], values: { dps: [70, 100, 130, 160], slow: [25, 30, 35, 40], radius: [3, 3.2, 3.4, 3.6], dur: [4, 4, 4, 4] }, desc: "Rot the ground — damage and slow over time." }),
      R: ab({ key: "R", name: "Soul Harvest", effect: "necromancer:R", targeting: "self", castRange: 0, manaCost: [120, 150, 180], cooldown: [70, 62, 54], values: { damage: [180, 260, 340], heal: [60, 90, 120], radius: [5, 5.5, 6] }, desc: "Tear the souls from everyone around you, healing for each one struck." }),
    },
  },
];

export const CHAMP_BY_ID: Record<string, ChampDef> = Object.fromEntries(
  CHAMPIONS.map((c) => [c.id, c]),
);

export const DEFAULT_CHAMP = "knight";
