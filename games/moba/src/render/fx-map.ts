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
  // craftpix packs: projectile + persistent zone art
  { fps: 26, frame: 128, frames: 15, key: "sp-fireball" },
  { fps: 14, frame: 128, frames: 10, key: "sp-fire" },
  { fps: 26, frame: 256, frames: 10, key: "sp-lightning" },
  { fps: 18, frame: 128, frames: 11, key: "sp-water" },
  // generated per-ability cast art (tools: scratch gen-fx/pack-fx, see
  // combat-fx-sources.json) — 12-frame boards, one signature per spell
  { fps: 24, frame: 128, frames: 12, key: "sp-ironvow-q" },
  { fps: 20, frame: 128, frames: 12, key: "sp-ironvow-w" },
  { fps: 18, frame: 128, frames: 12, key: "sp-ironvow-r" },
  { fps: 20, frame: 128, frames: 12, key: "sp-duskblade-q" },
  { fps: 22, frame: 128, frames: 9, key: "sp-duskblade-w" },
  { fps: 18, frame: 128, frames: 12, key: "sp-duskblade-r" },
  { fps: 24, frame: 128, frames: 12, key: "sp-stormcaller-q" },
  { fps: 20, frame: 128, frames: 12, key: "sp-stormcaller-w" },
  { fps: 20, frame: 128, frames: 12, key: "sp-stormcaller-e" },
  { fps: 16, frame: 128, frames: 12, key: "sp-stormcaller-r" },
  { fps: 20, frame: 128, frames: 12, key: "sp-emberhex-q" },
  { fps: 20, frame: 128, frames: 12, key: "sp-emberhex-w" },
  { fps: 20, frame: 128, frames: 12, key: "sp-emberhex-e" },
  { fps: 18, frame: 128, frames: 12, key: "sp-emberhex-r" },
  { fps: 20, frame: 128, frames: 12, key: "sp-boomtinker-q" },
  { fps: 18, frame: 128, frames: 12, key: "sp-boomtinker-w" },
  { fps: 20, frame: 128, frames: 12, key: "sp-boomtinker-e" },
  { fps: 16, frame: 128, frames: 12, key: "sp-boomtinker-r" },
  { fps: 20, frame: 128, frames: 12, key: "sp-brewkeeper-q" },
  { fps: 20, frame: 128, frames: 12, key: "sp-brewkeeper-w" },
  { fps: 20, frame: 128, frames: 12, key: "sp-brewkeeper-e" },
  { fps: 16, frame: 128, frames: 12, key: "sp-brewkeeper-r" },
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
 *  procedural ring/beam). `at` chooses caster vs the targeted point; `aimed`
 *  sits on the caster rotated toward the target (cones, skillshots). */
export interface SpellCastFx {
  sheet: string;
  at: "caster" | "target" | "aimed";
  scale: number;
  tint?: number;
  startFrame?: number;
  /** Energy art is authored on black and composites additively; matter art
   *  (smoke, debris, liquid) is alpha-cut and blends normally. */
  additive?: boolean;
  /** Nudge in sheet pixels (× scale): ground-anchored art lands its base on
   *  the point (offsetY), aimed art starts its origin at the caster (offsetX). */
  offsetX?: number;
  offsetY?: number;
}

export const ABILITY_CAST_FX = {
  "boomtinker:E": { at: "caster", scale: 1.4, sheet: "sp-boomtinker-e" },
  "boomtinker:Q": { at: "caster", offsetY: -20, scale: 1, sheet: "sp-boomtinker-q" },
  "boomtinker:R": { at: "target", offsetY: -20, scale: 2, sheet: "sp-boomtinker-r" },
  "boomtinker:W": { at: "target", scale: 1, sheet: "sp-boomtinker-w" },
  "brewkeeper:E": { at: "caster", scale: 1.5, sheet: "sp-brewkeeper-e" },
  "brewkeeper:Q": { at: "target", offsetY: -10, scale: 1.2, sheet: "sp-brewkeeper-q" },
  "brewkeeper:R": { at: "caster", offsetY: -30, scale: 2, sheet: "sp-brewkeeper-r" },
  "brewkeeper:W": { at: "target", scale: 1.3, sheet: "sp-brewkeeper-w" },
  "duskblade:Q": { at: "caster", offsetY: -16, scale: 1.2, sheet: "sp-duskblade-q" },
  "duskblade:R": {
    additive: true,
    at: "target",
    offsetY: -16,
    scale: 1.3,
    sheet: "sp-duskblade-r",
  },
  "duskblade:W": { at: "aimed", offsetX: 44, scale: 2, sheet: "sp-duskblade-w" },
  "emberhex:E": { additive: true, at: "caster", scale: 1.5, sheet: "sp-emberhex-e" },
  "emberhex:Q": { additive: true, at: "caster", offsetY: -24, scale: 1, sheet: "sp-emberhex-q" },
  // played by the detonation, not the cast (the fuse only warns)
  "emberhex:R": { additive: true, at: "target", offsetY: -34, scale: 2.2, sheet: "sp-emberhex-r" },
  "emberhex:W": { additive: true, at: "target", offsetY: -30, scale: 1.3, sheet: "sp-emberhex-w" },
  "ironvow:Q": { additive: true, at: "target", offsetY: -16, scale: 1, sheet: "sp-ironvow-q" },
  "ironvow:R": { at: "caster", scale: 2.4, sheet: "sp-ironvow-r" },
  "ironvow:W": { additive: true, at: "caster", offsetY: -22, scale: 1.1, sheet: "sp-ironvow-w" },
  "stormcaller:E": { additive: true, at: "caster", scale: 1.2, sheet: "sp-stormcaller-e" },
  // the beam renderer lays several of these along the shot
  "stormcaller:Q": { additive: true, at: "aimed", scale: 2.2, sheet: "sp-stormcaller-q" },
  "stormcaller:R": {
    additive: true,
    at: "target",
    offsetY: -50,
    scale: 1.6,
    sheet: "sp-stormcaller-r",
  },
  "stormcaller:W": {
    additive: true,
    at: "target",
    offsetY: -16,
    scale: 1.1,
    sheet: "sp-stormcaller-w",
  },
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

/** Existing hero palette at contact; neutral sources retain the damage-type cue. */
export const hitColor = (hero: string | undefined, magic: boolean): number => {
  switch (hero) {
    case "ironvow":
    case "duskblade":
    case "stormcaller":
    case "emberhex":
    case "boomtinker":
    case "brewkeeper": {
      return effectColor(hero);
    }
    default: {
      return magic ? 0xc7_8b_ff : 0xff_ff_ff;
    }
  }
};
