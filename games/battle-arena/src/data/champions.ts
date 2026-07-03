// The champion roster (build-doc §7). Pure data: stats, per-level growth, and
// data-driven ability defs. The ability `effect` tag is dispatched by a switch
// in sim/abilities.ts. Values are per-rank arrays read with valAt().
//
// Mapped to KayKit Adventurers/Skeletons models (Rig_Medium by default → one
// shared clip library; `rig: "large"` champs bind the "Large/"-prefixed set).
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
  windupMs?: number; // melee basic-attack windup override (default MELEE_WINDUP)
  model: string; // GLB basename under public/models/characters
  weaponR?: string; // weapon model attached to handslot.r
  weaponL?: string; // weapon/shield attached to handslot.l
  cleaveTargets?: number; // max enemies a basic attack damages (default 3; rogue 1)
  rig?: "large"; // needs the Rig_Large clip library ("Large/" prefix)
  scale?: number; // render scale multiplier (default 1)
  radius?: number; // sim collision radius override (default 0.62)
  tint: number; // fallback identity color (team color overrides in-match)
  blurb: string;
  difficulty: 1 | 2 | 3; // select-screen difficulty pips (render-only)
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
    windupMs: 100,
    model: "Knight",
    weaponR: "sword_1handed",
    weaponL: "shield_round",
    tint: 0x4f86ff,
    blurb: "A walking wall. Stun, charge in, and spin the throne to bloody mulch.",
    difficulty: 1,
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
    difficulty: 2,
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
    difficulty: 2,
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
    windupMs: 70,
    model: "Rogue_Hooded",
    weaponR: "dagger",
    weaponL: "dagger",
    cleaveTargets: 1, // single-target assassin — daggers don't cleave the cone
    tint: 0xff5a78,
    blurb: "In, out, gone. Poison, vanish, and execute anyone clinging to life.",
    difficulty: 3,
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
    id: "blackknight",
    name: "Aurelius",
    title: "the Dawnward",
    role: "Juggernaut",
    primary: "str",
    attackType: "melee",
    attackDamageType: "physical",
    attackKind: "melee",
    windupMs: 120,
    model: "Paladin_with_Helmet",
    weaponR: "paladin_hammer",
    weaponL: "paladin_shield",
    scale: 1.06,
    radius: 0.75,
    tint: 0xffd76a,
    blurb: "A holy wall with a hammer. Stand where he stands, or learn how cathedrals fall.",
    difficulty: 1,
    base: { hp: 720, mp: 220, hpRegen: 5.0, mpRegen: 1.4, damage: 58, armor: 5, attackRange: 2.6, attackSpeed: 0.85, moveSpeed: 5.6, projectileSpeed: 0 },
    growth: { hp: 100, mp: 18, hpRegen: 0.5, mpRegen: 0.1, damage: 6, armor: 0.8, attackSpeed: 0.014 },
    attr: { str: 30, agi: 8, int: 10 },
    abilities: {
      Q: ab({ key: "Q", name: "Executioner's Arc", effect: "blackknight:Q", targeting: "direction", castRange: 3.8, manaCost: [50, 55, 60, 65], cooldown: [6, 5.5, 5, 4.5], values: { damage: [85, 130, 175, 220], cone: [110, 110, 110, 110], slow: [20, 20, 20, 20], slowDur: [1, 1, 1, 1] }, desc: "A vast sweeping cut — carve and slow everyone in front." }),
      W: ab({ key: "W", name: "Dread March", effect: "blackknight:W", targeting: "dash", castRange: 8, manaCost: [70, 75, 80, 85], cooldown: [12, 11, 10, 9], values: { damage: [70, 110, 150, 190], speed: [20, 20, 20, 20], knockback: [5, 5.5, 6, 6.5], slow: [30, 30, 30, 30], slowDur: [1.5, 1.5, 1.5, 1.5] }, desc: "Advance like doom — shove aside and slow all you trample." }),
      E: ab({ key: "E", name: "Iron Bastion", effect: "blackknight:E", targeting: "self", castRange: 0, manaCost: [55, 60, 65, 70], cooldown: [16, 15, 14, 13], values: { armor: [8, 12, 16, 20], hps: [30, 45, 60, 75], duration: [4, 4, 4, 4] }, desc: "Become the wall — armor up and mend while you march." }),
      R: ab({ key: "R", name: "Oblivion Slam", effect: "blackknight:R", targeting: "self", castRange: 0, manaCost: [110, 130, 150], cooldown: [70, 62, 54], values: { damage: [220, 320, 420], radius: [4.5, 5, 5.5], stun: [0.8, 1.0, 1.2], knockback: [8, 8, 8] }, desc: "Bring the sword down — everything nearby is thrown and stunned." }),
    },
  },
  {
    id: "witch",
    name: "Grimelda",
    title: "the Bog Witch",
    role: "Hex Zoner",
    primary: "int",
    attackType: "ranged",
    attackDamageType: "magic",
    attackKind: "bolt",
    model: "Witch",
    weaponR: "wand_A",
    tint: 0x7fe08a,
    blurb: "Curses bubble, brooms fly, and her enemies make lovely mushrooms.",
    difficulty: 3,
    base: { hp: 500, mp: 300, hpRegen: 3.2, mpRegen: 2.2, damage: 42, armor: 2, attackRange: 7.5, attackSpeed: 1.05, moveSpeed: 6.0, projectileSpeed: 16 },
    growth: { hp: 72, mp: 26, hpRegen: 0.3, mpRegen: 0.18, damage: 4.2, armor: 0.5, attackSpeed: 0.02 },
    attr: { str: 12, agi: 14, int: 26 },
    abilities: {
      Q: ab({ key: "Q", name: "Hex Bolt", effect: "witch:Q", targeting: "direction", castRange: 9, manaCost: [55, 60, 65, 70], cooldown: [7, 6.5, 6, 5.5], values: { damage: [70, 110, 150, 190], slow: [20, 25, 30, 35], slowDur: [1.2, 1.2, 1.2, 1.2], speed: [18, 18, 18, 18] }, desc: "Spit a curdled bolt — damage and slow whoever it strikes." }),
      W: ab({ key: "W", name: "Cauldron Brew", effect: "witch:W", targeting: "ground", castRange: 8, manaCost: [70, 80, 90, 100], cooldown: [13, 12, 11, 10], values: { dps: [45, 70, 95, 120], slow: [25, 30, 35, 40], radius: [3.2, 3.4, 3.6, 3.8], duration: [4, 4, 4, 4] }, desc: "Spill the cauldron — the brew burns and slows all who wade in." }),
      E: ab({ key: "E", name: "Broom Surge", effect: "witch:E", targeting: "dash", castRange: 9, manaCost: [45, 45, 45, 45], cooldown: [12, 11, 10, 9], values: { speed: [24, 24, 24, 24], haste: [25, 30, 35, 40], hasteDur: [2, 2, 2, 2] }, desc: "Take to the broom — dash free and keep the wind after." }),
      R: ab({ key: "R", name: "Grand Hex", effect: "witch:R", targeting: "ground", castRange: 8, manaCost: [110, 130, 150], cooldown: [80, 70, 60], values: { radius: [4, 4.5, 5], duration: [2.0, 2.4, 2.8], slow: [40, 40, 40] }, desc: "Hex the ground — everyone caught becomes a harmless mushroom." }),
    },
  },
];

export const CHAMP_BY_ID: Record<string, ChampDef> = Object.fromEntries(
  CHAMPIONS.map((c) => [c.id, c]),
);

export const DEFAULT_CHAMP = "knight";
