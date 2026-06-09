// Hero definitions distilled from the design pass. Pure data: per-rank numbers
// plus an `effect` tag the ability system switches on (see sim/abilities.ts).

export type AbilityKey = "Q" | "W" | "E" | "R";

// How the player aims an ability (drives input + bot targeting).
export type Targeting = "unit" | "point" | "none" | "passive";

export type AbilityValue = number | number[] | boolean;
export type AbilityValues = Record<string, AbilityValue>;

export type AbilityDef = {
  key: AbilityKey;
  name: string;
  /** unique effect id, "<heroId>:<key>" — sim/abilities.ts dispatches on it */
  effect: string;
  targeting: Targeting;
  /** how the design categorised it (for tooltips/fx) */
  flavor: string;
  desc: string;
  maxRank: number; // 4 for Q/W/E, 3 for R
  manaCost: number[];
  cooldown: number[];
  castRange: number;
  values: AbilityValues;
  isUltimate: boolean;
};

export type HeroStats = {
  hp: number;
  mp: number;
  hpRegen: number;
  mpRegen: number;
  damage: number;
  armor: number;
  attackRange: number;
  attackSpeed: number; // attacks/sec
  moveSpeed: number; // px/sec
  projectileSpeed: number; // 0 = melee instant
};

export type HeroDef = {
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
};

/** Read a per-rank value; scalars apply at every rank. rank is 1-based. */
export function valAt(v: AbilityValue | undefined, rank: number): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return (v[Math.max(0, Math.min(v.length - 1, rank - 1))] as number) ?? 0;
  return 0;
}
export function flag(v: AbilityValue | undefined): boolean {
  return v === true;
}

function ab(d: Omit<AbilityDef, "maxRank" | "isUltimate"> & { maxRank?: number }): AbilityDef {
  const isUltimate = d.key === "R";
  return { ...d, isUltimate, maxRank: d.maxRank ?? (isUltimate ? 3 : 4) };
}

export const HEROES: HeroDef[] = [
  {
    id: "ironvow",
    name: "Sir Garran",
    title: "the Ironvow",
    role: "Tank / Initiator",
    attackType: "melee",
    sheet: "warrior",
    tint: 0x9cc4ff,
    blurb: "Frontline anchor. Taunt the enemy core, stun the priority target, soak the focus while allies clean up. The forgiving starter pick.",
    base: { hp: 660, mp: 220, hpRegen: 3, mpRegen: 0.8, damage: 48, armor: 4, attackRange: 90, attackSpeed: 0.65, moveSpeed: 290, projectileSpeed: 0 },
    growth: { hp: 88, mp: 14, damage: 3.4, armor: 0.45, hpRegen: 0.22, mpRegen: 0.05, attackSpeed: 0.012 },
    abilities: {
      Q: ab({ key: "Q", name: "Shield Bash", effect: "ironvow:Q", targeting: "unit", flavor: "targeted-unit", desc: "Charge the buckler into a target for damage and a hard STUN.", manaCost: [75, 80, 85, 90], cooldown: [11, 10, 9, 8], castRange: 150, values: { damage: [70, 120, 170, 220], stun: [1, 1.3, 1.6, 1.9] } }),
      W: ab({ key: "W", name: "Oathguard", effect: "ironvow:W", targeting: "none", flavor: "self-buff", desc: "Aegis: bonus armor + a damage SHIELD; melee attackers take reflected damage.", manaCost: [60, 65, 70, 75], cooldown: [16, 15, 14, 13], castRange: 0, values: { bonusArmor: [3, 5, 7, 9], shield: [80, 140, 200, 260], reflectPct: [20, 25, 30, 35], duration: 6 } }),
      E: ab({ key: "E", name: "Banner of Resolve", effect: "ironvow:E", targeting: "passive", flavor: "passive aura", desc: "Aura: nearby allies gain move speed and HP regen.", manaCost: [0], cooldown: [0], castRange: 0, values: { auraRadius: 600, moveSpeedPct: [4, 6, 8, 10], hpRegen: [2, 3.5, 5, 6.5] } }),
      R: ab({ key: "R", name: "Unbreaking Vow", effect: "ironvow:R", targeting: "none", flavor: "point-aoe taunt", desc: "Slam the ground: TAUNT all nearby enemies to attack you while you gain heavy damage reduction.", manaCost: [120, 150, 180], cooldown: [90, 80, 70], castRange: 0, values: { radius: 360, taunt: [1.4, 1.8, 2.2], damageReductionPct: [40, 50, 60], buffDuration: [4, 5, 6], damage: [80, 130, 180] } }),
    },
  },
  {
    id: "duskblade",
    name: "Vesper",
    title: "the Duskblade",
    role: "Carry / Assassin",
    attackType: "melee",
    sheet: "pawn",
    tint: 0x7af0c8,
    blurb: "Snowball assassin. Dodge ganks with a blink, fan daggers to push, dive squishies with an untargetable execute. High skill, high reward.",
    base: { hp: 520, mp: 250, hpRegen: 1.8, mpRegen: 0.9, damage: 52, armor: 2, attackRange: 95, attackSpeed: 0.75, moveSpeed: 320, projectileSpeed: 0 },
    growth: { hp: 64, mp: 16, damage: 3.8, armor: 0.3, hpRegen: 0.16, mpRegen: 0.06, attackSpeed: 0.02 },
    abilities: {
      Q: ab({ key: "Q", name: "Shadowstep", effect: "duskblade:Q", targeting: "point", flavor: "dash", desc: "Blink toward the cursor; your next attack soon strikes for bonus damage.", manaCost: [50, 55, 60, 65], cooldown: [9, 8, 7, 6], castRange: 360, values: { blink: 360, bonusNextAttack: [30, 55, 80, 105], window: 3 } }),
      W: ab({ key: "W", name: "Fanned Daggers", effect: "duskblade:W", targeting: "point", flavor: "skillshot-aoe", desc: "Hurl a cone of daggers: damage + brief SLOW.", manaCost: [70, 80, 90, 100], cooldown: [8, 7.5, 7, 6.5], castRange: 420, values: { damage: [70, 110, 150, 190], coneRange: 420, coneAngle: 45, slowPct: [20, 25, 30, 35], slowDuration: 1.5 } }),
      E: ab({ key: "E", name: "Bloodthirst", effect: "duskblade:E", targeting: "passive", flavor: "passive", desc: "Attacks LIFESTEAL and stack attack speed; stacks decay out of combat.", manaCost: [0], cooldown: [0], castRange: 0, values: { lifestealPct: [10, 15, 20, 25], asPerStack: [4, 5, 6, 7], maxStacks: 5, stackDuration: 4 } }),
      R: ab({ key: "R", name: "Death Waltz", effect: "duskblade:R", targeting: "unit", flavor: "targeted-unit", desc: "Lock onto a hero, become briefly untargetable, strike several times then a backstab CRIT.", manaCost: [100, 130, 160], cooldown: [75, 65, 55], castRange: 350, values: { strikes: [3, 4, 5], damagePerStrike: [60, 80, 100], critMult: 2, untargetable: [1.2, 1.5, 1.8] } }),
    },
  },
  {
    id: "stormcaller",
    name: "Aelwyn",
    title: "Stormcaller",
    role: "Carry / Ranged",
    attackType: "ranged",
    sheet: "archer",
    tint: 0xbfe0ff,
    blurb: "Position-and-poke ranged carry. Pierce waves, mark the carry, kite with a speed burst, rain a storm to win fights and break towers.",
    base: { hp: 480, mp: 300, hpRegen: 1.6, mpRegen: 1.1, damage: 46, armor: 1, attackRange: 520, attackSpeed: 0.7, moveSpeed: 300, projectileSpeed: 900 },
    growth: { hp: 56, mp: 18, damage: 3.6, armor: 0.28, hpRegen: 0.14, mpRegen: 0.07, attackSpeed: 0.018 },
    abilities: {
      Q: ab({ key: "Q", name: "Piercing Shot", effect: "stormcaller:Q", targeting: "point", flavor: "skillshot-line", desc: "A long arrow that PIERCES every unit in a line, damage falling off per target.", manaCost: [70, 80, 90, 100], cooldown: [7, 6.5, 6, 5.5], castRange: 800, values: { damage: [90, 140, 190, 240], length: 800, width: 90, falloffPct: 12, minPct: 50 } }),
      W: ab({ key: "W", name: "Hunter's Mark", effect: "stormcaller:W", targeting: "unit", flavor: "targeted-unit", desc: "Mark a hero: they take amplified damage; you attack them faster.", manaCost: [50, 55, 60, 65], cooldown: [14, 13, 12, 11], castRange: 700, values: { ampPct: [12, 16, 20, 24], bonusAsVsMarked: [20, 30, 40, 50], duration: [5, 6, 7, 8] } }),
      E: ab({ key: "E", name: "Windfoot", effect: "stormcaller:E", targeting: "none", flavor: "self-buff", desc: "Burst of move + attack speed; your hits briefly SLOW. Pure kiting.", manaCost: [40, 45, 50, 55], cooldown: [16, 14, 12, 10], castRange: 0, values: { moveSpeed: [60, 80, 100, 120], attackSpeed: [25, 35, 45, 55], onHitSlowPct: 12, duration: [3, 3.5, 4, 4.5] } }),
      R: ab({ key: "R", name: "Storm Volley", effect: "stormcaller:R", targeting: "point", flavor: "channel point-aoe", desc: "CHANNEL: rain storm arrows on an area, ticking AoE damage and slow.", manaCost: [150, 175, 200], cooldown: [100, 90, 80], castRange: 850, values: { channel: [3, 3.5, 4], tick: 0.5, damagePerTick: [55, 75, 95], radius: 320, slowPct: 25 } }),
    },
  },
  {
    id: "emberhex",
    name: "Grix",
    title: "the Emberhex",
    role: "Nuker / Mage",
    attackType: "ranged",
    sheet: "torch",
    tint: 0xff8a4d,
    blurb: "Burst mage. Lob fireballs, lay burning ground, immolate in melee, then delete a clump with a delayed firestorm.",
    base: { hp: 500, mp: 340, hpRegen: 1.7, mpRegen: 1.3, damage: 40, armor: 1, attackRange: 320, attackSpeed: 0.6, moveSpeed: 300, projectileSpeed: 700 },
    growth: { hp: 58, mp: 22, damage: 2.8, armor: 0.26, hpRegen: 0.15, mpRegen: 0.09, attackSpeed: 0.01 },
    abilities: {
      Q: ab({ key: "Q", name: "Fireball", effect: "emberhex:Q", targeting: "point", flavor: "skillshot-aoe", desc: "Lob a fireball that explodes for magic damage in an area.", manaCost: [80, 90, 100, 110], cooldown: [6, 5.5, 5, 4.5], castRange: 550, values: { damage: [90, 150, 210, 270], radius: 180, projectileSpeed: 700 } }),
      W: ab({ key: "W", name: "Cinder Trail", effect: "emberhex:W", targeting: "point", flavor: "point-aoe DoT", desc: "Ignite the ground: burning DoT that SLOWS those who linger.", manaCost: [70, 80, 90, 100], cooldown: [12, 11, 10, 9], castRange: 500, values: { dps: [30, 45, 60, 75], duration: 4, radius: 200, slowPct: 30 } }),
      E: ab({ key: "E", name: "Flashfire", effect: "emberhex:E", targeting: "none", flavor: "self-buff aura", desc: "Wreath yourself in flame: burn nearby enemies and gain spell amp.", manaCost: [60, 65, 70, 75], cooldown: [18, 16, 14, 12], castRange: 0, values: { dps: [25, 40, 55, 70], radius: 200, spellAmpPct: [8, 12, 16, 20], duration: 5 } }),
      R: ab({ key: "R", name: "Conflagration", effect: "emberhex:R", targeting: "point", flavor: "skillshot-aoe nuke", desc: "A delayed firestorm erupts for huge magic damage and lingering burn.", manaCost: [160, 210, 260], cooldown: [90, 80, 70], castRange: 700, values: { damage: [240, 340, 440], radius: 340, fuse: 0.9, burnDps: [40, 60, 80], burnDuration: 3 } }),
    },
  },
  {
    id: "boomtinker",
    name: "Fizzle",
    title: "Boomtinker",
    role: "Pusher / Sapper",
    attackType: "melee",
    sheet: "tnt",
    tint: 0xffd24d,
    blurb: "Demolitions pusher. Chunk towers with dynamite, zone with mines, splash waves, then megabomb a stunned clump. Ends games.",
    base: { hp: 560, mp: 240, hpRegen: 2.2, mpRegen: 0.9, damage: 44, armor: 2, attackRange: 120, attackSpeed: 0.62, moveSpeed: 305, projectileSpeed: 0 },
    growth: { hp: 70, mp: 15, damage: 3, armor: 0.34, hpRegen: 0.18, mpRegen: 0.05, attackSpeed: 0.012 },
    abilities: {
      Q: ab({ key: "Q", name: "Lob Dynamite", effect: "boomtinker:Q", targeting: "point", flavor: "skillshot-aoe", desc: "Dynamite explodes for magic damage in an area; BONUS vs buildings.", manaCost: [65, 75, 85, 95], cooldown: [7, 6.5, 6, 5.5], castRange: 520, values: { damage: [80, 125, 170, 215], buildingBonusPct: 60, radius: 160, projectileSpeed: 650 } }),
      W: ab({ key: "W", name: "Proximity Mines", effect: "boomtinker:W", targeting: "point", flavor: "summon", desc: "Plant a hidden mine; arms then detonates near an enemy for burst + SLOW.", manaCost: [60, 70, 80, 90], cooldown: [9, 8, 7, 6], castRange: 500, values: { damage: [70, 110, 150, 190], maxMines: [3, 4, 5, 6], armDelay: 1.2, triggerRadius: 140, slowPct: 25, lifetime: 45 } }),
      E: ab({ key: "E", name: "Powder Keg", effect: "boomtinker:E", targeting: "none", flavor: "self-buff", desc: "Next attacks splash AoE; passive bonus building damage.", manaCost: [50, 55, 60, 65], cooldown: [15, 14, 13, 12], castRange: 0, values: { splashRadius: 160, splashPct: [50, 60, 70, 80], attacks: [3, 4, 5, 6], passiveBuildingPct: [10, 15, 20, 25] } }),
      R: ab({ key: "R", name: "Demolition Run", effect: "boomtinker:R", targeting: "point", flavor: "dash slam", desc: "Sprint with a megabomb (unstoppable), then SLAM for huge AoE + STUN.", manaCost: [140, 180, 220], cooldown: [100, 90, 80], castRange: 900, values: { dashSpeed: 220, maxDash: 2.5, damage: [220, 320, 420], radius: 280, stun: [1.2, 1.5, 1.8], buildingBonusPct: 100 } }),
    },
  },
  {
    id: "brewkeeper",
    name: "Old Bramblecask",
    title: "the Brewkeeper",
    role: "Support / Healer",
    attackType: "melee",
    sheet: "barrel",
    tint: 0xc8a06a,
    blurb: "Team support. Heal saves, silence-slow the enemy initiation, shield the frontline, then pour a great cask to out-sustain a teamfight.",
    base: { hp: 600, mp: 320, hpRegen: 2.6, mpRegen: 1.2, damage: 38, armor: 3, attackRange: 95, attackSpeed: 0.6, moveSpeed: 295, projectileSpeed: 0 },
    growth: { hp: 72, mp: 19, damage: 2.6, armor: 0.36, hpRegen: 0.2, mpRegen: 0.08, attackSpeed: 0.01 },
    abilities: {
      Q: ab({ key: "Q", name: "Restoring Brew", effect: "brewkeeper:Q", targeting: "unit", flavor: "targeted-unit heal", desc: "Splash ale on an ally (or self): instant HEAL + regen over time.", manaCost: [75, 85, 95, 105], cooldown: [8, 7.5, 7, 6.5], castRange: 550, values: { heal: [80, 130, 180, 230], regenPerSec: [10, 15, 20, 25], regenDuration: 4 } }),
      W: ab({ key: "W", name: "Hex Bottle", effect: "brewkeeper:W", targeting: "point", flavor: "skillshot-aoe", desc: "Shatters in an area: SILENCE + SLOW + minor magic damage.", manaCost: [80, 90, 100, 110], cooldown: [16, 15, 14, 13], castRange: 600, values: { damage: [50, 80, 110, 140], silence: [1.2, 1.6, 2, 2.4], slowPct: [25, 30, 35, 40], radius: 220 } }),
      E: ab({ key: "E", name: "Warding Keg", effect: "brewkeeper:E", targeting: "none", flavor: "self-buff aura", desc: "Grant nearby allies a SHIELD + bonus armor.", manaCost: [70, 80, 90, 100], cooldown: [18, 17, 16, 15], castRange: 0, values: { shield: [70, 120, 170, 220], bonusArmor: [2, 3, 4, 5], auraRadius: 450, duration: 5 } }),
      R: ab({ key: "R", name: "Last Call", effect: "brewkeeper:R", targeting: "point", flavor: "channel point-aoe", desc: "CHANNEL a great cask: a zone that rapidly restores HP/mana and cleanses slows.", manaCost: [150, 190, 230], cooldown: [110, 100, 90], castRange: 0, values: { channel: [4, 5, 6], tick: 0.5, healPerTick: [40, 60, 80], manaPerTick: [8, 12, 16], radius: 380, cleanse: true } }),
    },
  },
];

export const HERO_BY_ID: Record<string, HeroDef> = Object.fromEntries(HEROES.map((h) => [h.id, h]));

export function heroStatAt(h: HeroDef, stat: keyof HeroStats, level: number): number {
  const base = h.base[stat];
  const g = h.growth[stat] ?? 0;
  return base + g * (level - 1);
}
