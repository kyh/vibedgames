// Presentation mapping for abilities: which HUD icon and which sprite effect each
// ability's `effect` id draws. Pure data keyed by the effect id (e.g. "emberhex:Q")
// so the sim stays art-free and the renderer/HUD share one source of truth.

/** Packed effect spritesheets (authored horizontal strips, one row of `frames`). */
export interface SpellSheet {
  key: string;
  frame: number;
  frames: number;
  fps: number;
}
export const SPELL_SHEETS: SpellSheet[] = [
  { fps: 26, frame: 128, frames: 15, key: "sp-fireball" },
  { fps: 14, frame: 128, frames: 10, key: "sp-fire" },
  { fps: 26, frame: 256, frames: 10, key: "sp-lightning" },
  { fps: 22, frame: 128, frames: 11, key: "sp-spikes" },
  { fps: 18, frame: 128, frames: 11, key: "sp-water" },
  { fps: 20, frame: 128, frames: 10, key: "sp-smoke" },
  { fps: 16, frame: 128, frames: 4, key: "sp-light" },
  { fps: 18, frame: 128, frames: 11, key: "sp-tornado" },
  { fps: 20, frame: 64, frames: 14, key: "sp-gypno" },
];

/** Frame order inside `assets/spell/icons.webp` — one packed 6×3 sheet of 64px
 *  icons, so the index here IS the Phaser frame. Repack in this order. */
const SPELL_ICON_FRAME: Record<string, number> = Object.fromEntries(
  [
    "ic-burst",
    "ic-chain",
    "ic-claw",
    "ic-comet",
    "ic-fire",
    "ic-firering",
    "ic-gypno",
    "ic-light",
    "ic-lightning",
    "ic-nature",
    "ic-shadow",
    "ic-shield",
    "ic-skull",
    "ic-spikes",
    "ic-tesla",
    "ic-tornado",
    "ic-vortex",
    "ic-water",
  ].map((name, i) => [name, i]),
);

/** 64px HUD icon for every ability slot, keyed by effect id. */
export const ABILITY_ICON = {
  "boomtinker:E": "ic-comet",
  "boomtinker:Q": "ic-burst",
  "boomtinker:R": "ic-burst",
  "boomtinker:W": "ic-spikes",
  "brewkeeper:E": "ic-shield",
  "brewkeeper:Q": "ic-water",
  "brewkeeper:R": "ic-nature",
  "brewkeeper:W": "ic-gypno",
  "duskblade:E": "ic-vortex",
  "duskblade:Q": "ic-shadow",
  "duskblade:R": "ic-skull",
  "duskblade:W": "ic-claw",
  "emberhex:E": "ic-claw",
  "emberhex:Q": "ic-fire",
  "emberhex:R": "ic-burst",
  "emberhex:W": "ic-firering",
  "ironvow:E": "ic-nature",
  "ironvow:Q": "ic-light",
  "ironvow:R": "ic-burst",
  "ironvow:W": "ic-shield",
  "stormcaller:E": "ic-tornado",
  "stormcaller:Q": "ic-lightning",
  "stormcaller:R": "ic-chain",
  "stormcaller:W": "ic-tesla",
} satisfies Record<string, string>;

const ABILITY_ICON_LOOKUP = new Map<string, string>(Object.entries(ABILITY_ICON));

/** Frame in the packed spell-icon sheet for an ability's HUD icon. */
export const abilityIconFrame = (effect: string): number | null => {
  const name = ABILITY_ICON_LOOKUP.get(effect);
  return name === undefined ? null : (SPELL_ICON_FRAME[name] ?? null);
};

/** A one-shot sprite burst played when an ability is cast (on top of the
 *  procedural ring/beam). `at` chooses caster vs the targeted point. */
export interface SpellCastFx {
  sheet: string;
  at: "caster" | "target";
  scale: number;
  tint?: number;
}

export const ABILITY_CAST_FX = {
  "boomtinker:E": { at: "caster", scale: 1.2, sheet: "sp-light", tint: 0xff_e0_8a },
  // toss puff
  "boomtinker:Q": { at: "caster", scale: 0.9, sheet: "sp-smoke", tint: 0xd8_c0_a0 },
  "boomtinker:R": { at: "caster", scale: 1.6, sheet: "sp-fire", tint: 0xff_d2_4d },
  "boomtinker:W": { at: "target", scale: 1, sheet: "sp-smoke", tint: 0xff_d2_4d },
  "brewkeeper:E": { at: "caster", scale: 1.5, sheet: "sp-light", tint: 0x9b_f0_b0 },
  "brewkeeper:Q": { at: "target", scale: 1.1, sheet: "sp-water", tint: 0x8b_f0_a8 },
  // last call
  "brewkeeper:R": { at: "caster", scale: 2.3, sheet: "sp-light", tint: 0x9b_f0_b0 },
  "brewkeeper:W": { at: "target", scale: 1.9, sheet: "sp-gypno", tint: 0xc7_8b_ff },
  "duskblade:Q": { at: "caster", scale: 1, sheet: "sp-smoke", tint: 0xb0_6b_ff },
  "duskblade:R": { at: "target", scale: 1.5, sheet: "sp-smoke", tint: 0x9b_6b_ff },
  "duskblade:W": { at: "target", scale: 1.4, sheet: "sp-spikes", tint: 0xc8_9b_ff },
  "emberhex:E": { at: "caster", scale: 1.7, sheet: "sp-fire", tint: 0xff_ca_a0 },
  // muzzle flare
  "emberhex:Q": { at: "caster", scale: 0.9, sheet: "sp-fire", tint: 0xff_b2_7a },
  "emberhex:R": { at: "target", scale: 2.1, sheet: "sp-fire", tint: 0xff_7a_2a },
  "emberhex:W": { at: "caster", scale: 1, sheet: "sp-fire", tint: 0xff_8a_4a },
  "ironvow:Q": { at: "target", scale: 0.9, sheet: "sp-light" },
  "ironvow:R": { at: "caster", scale: 2.6, sheet: "sp-light", tint: 0xbc_d6_ff },
  "ironvow:W": { at: "caster", scale: 1.3, sheet: "sp-light", tint: 0xbc_d6_ff },
  "stormcaller:E": { at: "caster", scale: 1.25, sheet: "sp-tornado", tint: 0xbf_e6_ff },
  "stormcaller:R": { at: "target", scale: 1.3, sheet: "sp-lightning", tint: 0x8f_d0_ff },
  "stormcaller:W": { at: "target", scale: 0.7, sheet: "sp-light", tint: 0x6a_b8_ff },
} satisfies Record<string, SpellCastFx>;

const CAST_FX_LOOKUP = new Map<string, SpellCastFx>(Object.entries(ABILITY_CAST_FX));

export const abilityCastFx = (effect: string): SpellCastFx | null =>
  CAST_FX_LOOKUP.get(effect) ?? null;

/** Persistent zone visuals for ground effects, keyed off the GroundEffect.effect.
 *  "fire" tiles a looping flame; "storm" rains lightning bolts; "heal" pools water. */
export type GroundFxKind = "fire" | "storm" | "heal" | "none";
export const groundFxKind = (effect: string, isHeal: boolean): GroundFxKind => {
  if (isHeal || effect.startsWith("brewkeeper")) {
    return "heal";
  }
  if (effect.includes("storm") || effect.startsWith("stormcaller")) {
    return "storm";
  }
  if (
    effect.includes("fire") ||
    effect.includes("flash") ||
    effect.includes("conflag") ||
    effect.startsWith("emberhex")
  ) {
    return "fire";
  }
  return "none";
};

/** Colour an ability/cast effect by its element keyword (rings, beams, numbers). */
export const effectColor = (effect: string): number => {
  if (
    effect.startsWith("emberhex") ||
    effect.includes("fire") ||
    effect.includes("flash") ||
    effect.includes("conflag")
  ) {
    return 0xff_7a_2a;
  }
  if (effect.startsWith("stormcaller") || effect.includes("storm") || effect.includes("pierc")) {
    return 0x6a_b8_ff;
  }
  if (effect.startsWith("brewkeeper")) {
    return 0x8b_e0_7a;
  }
  if (effect.startsWith("boomtinker")) {
    return 0xff_d2_4d;
  }
  if (effect.startsWith("duskblade")) {
    return 0xb0_6b_ff;
  }
  if (effect.startsWith("ironvow")) {
    return 0x9c_c4_ff;
  }
  return 0xff_ff_ff;
};
