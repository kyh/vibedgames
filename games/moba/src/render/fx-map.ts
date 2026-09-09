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
  { fps: 30, frame: 128, frames: 12, key: "sp-arc" },
  { fps: 24, frame: 128, frames: 8, key: "sp-flare-ring" },
  { fps: 22, frame: 160, frames: 8, key: "sp-fire-pillar" },
  { fps: 22, frame: 128, frames: 7, key: "sp-geyser" },
  { fps: 28, frame: 128, frames: 20, key: "sp-skull" },
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
export function abilityIconFrame(effect: string): number | null {
  const name = ABILITY_ICON_LOOKUP.get(effect);
  return name === undefined ? null : (SPELL_ICON_FRAME[name] ?? null);
}

/** A one-shot sprite burst played when an ability is cast (on top of the
 *  procedural ring/beam). `at` chooses caster vs the targeted point. */
export interface SpellCastFx {
  sheet: string;
  at: "caster" | "target";
  scale: number;
  tint?: number;
  startFrame?: number;
}

export const ABILITY_CAST_FX = {
  "boomtinker:E": { at: "caster", scale: 1.2, sheet: "sp-light", tint: 0xffe08a },
  "boomtinker:Q": { at: "caster", scale: 0.9, sheet: "sp-smoke", tint: 0xd8c0a0 }, // toss puff
  "boomtinker:R": { at: "target", scale: 1.6, sheet: "fx-explode1" },
  "boomtinker:W": { at: "target", scale: 1.0, sheet: "sp-smoke", tint: 0xffd24d },
  "brewkeeper:E": { at: "caster", scale: 1.5, sheet: "sp-light", tint: 0x9bf0b0 },
  "brewkeeper:Q": { at: "target", scale: 0.9, sheet: "sp-geyser", startFrame: 2 },
  "brewkeeper:R": { at: "caster", scale: 2.3, sheet: "sp-light", tint: 0x9bf0b0 }, // last call
  "brewkeeper:W": { at: "target", scale: 1.9, sheet: "sp-gypno", tint: 0xc78bff },
  "duskblade:Q": { at: "caster", scale: 1.0, sheet: "sp-smoke", tint: 0xb06bff },
  "duskblade:R": { at: "target", scale: 2.2, sheet: "sp-skull", startFrame: 5, tint: 0xc89bff },
  "duskblade:W": { at: "target", scale: 1.4, sheet: "sp-spikes", startFrame: 3 },
  "emberhex:E": { at: "caster", scale: 1.1, sheet: "sp-flare-ring", startFrame: 1 },
  "emberhex:Q": { at: "caster", scale: 0.9, sheet: "sp-fire", startFrame: 3 },
  "emberhex:W": { at: "caster", scale: 1.0, sheet: "sp-fire", startFrame: 6 },
  "ironvow:Q": { at: "target", scale: 0.9, sheet: "sp-light" },
  "ironvow:R": { at: "caster", scale: 2.6, sheet: "sp-light", tint: 0xbcd6ff },
  "ironvow:W": { at: "caster", scale: 1.3, sheet: "sp-light", tint: 0xbcd6ff },
  "stormcaller:E": { at: "caster", scale: 1.25, sheet: "sp-tornado", tint: 0xbfe6ff },
  "stormcaller:R": { at: "target", scale: 1.3, sheet: "sp-lightning", startFrame: 3 },
  "stormcaller:W": { at: "target", scale: 1.2, sheet: "sp-arc", startFrame: 3 },
} satisfies Record<string, SpellCastFx>;

const CAST_FX_LOOKUP = new Map<string, SpellCastFx>(Object.entries(ABILITY_CAST_FX));

export function abilityCastFx(effect: string): SpellCastFx | null {
  return CAST_FX_LOOKUP.get(effect) ?? null;
}

/** Persistent zone visuals for ground effects, keyed off the GroundEffect.effect.
 *  "fire" tiles a looping flame; "storm" rains lightning bolts; "heal" pools water. */
export type GroundFxKind = "fire" | "storm" | "heal" | "none";
export function groundFxKind(effect: string, isHeal: boolean): GroundFxKind {
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
}

/** Colour an ability/cast effect by its element keyword (rings, beams, numbers). */
export function effectColor(effect: string): number {
  if (
    effect.startsWith("emberhex") ||
    effect.includes("fire") ||
    effect.includes("flash") ||
    effect.includes("conflag")
  ) {
    return 0xff7a2a;
  }
  if (effect.startsWith("stormcaller") || effect.includes("storm") || effect.includes("pierc")) {
    return 0x6ab8ff;
  }
  if (effect.startsWith("brewkeeper")) {
    return 0x8be07a;
  }
  if (effect.startsWith("boomtinker")) {
    return 0xffd24d;
  }
  if (effect.startsWith("duskblade")) {
    return 0xb06bff;
  }
  if (effect.startsWith("ironvow")) {
    return 0x9cc4ff;
  }
  return 0xff_ff_ff;
}

/** Existing hero palette at contact; neutral sources retain the damage-type cue. */
export function hitColor(hero: string | undefined, magic: boolean): number {
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
      return magic ? 0xc78bff : 0xffffff;
    }
  }
}
