// Presentation mapping for abilities: which HUD icon and which sprite effect each
// ability's `effect` id draws. Pure data keyed by the effect id (e.g. "emberhex:Q")
// so the sim stays art-free and the renderer/HUD share one source of truth.

/** Packed effect spritesheets (authored horizontal strips, one row of `frames`). */
export type SpellSheet = { key: string; frame: number; frames: number; fps: number };
export const SPELL_SHEETS: SpellSheet[] = [
  { key: "sp-fireball", frame: 128, frames: 15, fps: 26 },
  { key: "sp-fire", frame: 128, frames: 10, fps: 14 },
  { key: "sp-lightning", frame: 256, frames: 10, fps: 26 },
  { key: "sp-spikes", frame: 128, frames: 11, fps: 22 },
  { key: "sp-water", frame: 128, frames: 11, fps: 18 },
  { key: "sp-smoke", frame: 128, frames: 10, fps: 20 },
  { key: "sp-light", frame: 128, frames: 4, fps: 16 },
  { key: "sp-tornado", frame: 128, frames: 11, fps: 18 },
  { key: "sp-gypno", frame: 64, frames: 14, fps: 20 },
];

/** 64px HUD icon for every ability slot, keyed by effect id. */
export const ABILITY_ICON: Record<string, string> = {
  "ironvow:Q": "ic-light",
  "ironvow:W": "ic-shield",
  "ironvow:E": "ic-nature",
  "ironvow:R": "ic-burst",
  "duskblade:Q": "ic-shadow",
  "duskblade:W": "ic-claw",
  "duskblade:E": "ic-vortex",
  "duskblade:R": "ic-skull",
  "stormcaller:Q": "ic-lightning",
  "stormcaller:W": "ic-tesla",
  "stormcaller:E": "ic-tornado",
  "stormcaller:R": "ic-chain",
  "emberhex:Q": "ic-fire",
  "emberhex:W": "ic-firering",
  "emberhex:E": "ic-claw",
  "emberhex:R": "ic-burst",
  "boomtinker:Q": "ic-burst",
  "boomtinker:W": "ic-spikes",
  "boomtinker:E": "ic-comet",
  "boomtinker:R": "ic-burst",
  "brewkeeper:Q": "ic-water",
  "brewkeeper:W": "ic-gypno",
  "brewkeeper:E": "ic-shield",
  "brewkeeper:R": "ic-nature",
};

export function abilityIcon(effect: string): string | null {
  return ABILITY_ICON[effect] ?? null;
}

/** A one-shot sprite burst played when an ability is cast (on top of the
 *  procedural ring/beam). `at` chooses caster vs the targeted point. */
export type SpellCastFx = {
  sheet: string;
  at: "caster" | "target";
  scale: number;
  tint?: number;
};

export const ABILITY_CAST_FX: Record<string, SpellCastFx> = {
  "ironvow:Q": { sheet: "sp-light", at: "target", scale: 0.9 },
  "ironvow:W": { sheet: "sp-light", at: "caster", scale: 1.3, tint: 0xbcd6ff },
  "ironvow:R": { sheet: "sp-light", at: "caster", scale: 2.6, tint: 0xbcd6ff },
  "duskblade:Q": { sheet: "sp-smoke", at: "caster", scale: 1.0, tint: 0xb06bff },
  "duskblade:W": { sheet: "sp-spikes", at: "target", scale: 1.4, tint: 0xc89bff },
  "duskblade:R": { sheet: "sp-smoke", at: "target", scale: 1.5, tint: 0x9b6bff },
  "stormcaller:W": { sheet: "sp-light", at: "target", scale: 0.7, tint: 0x6ab8ff },
  "stormcaller:E": { sheet: "sp-tornado", at: "caster", scale: 1.25, tint: 0xbfe6ff },
  "emberhex:E": { sheet: "sp-fire", at: "caster", scale: 1.7, tint: 0xffcaa0 },
  "boomtinker:E": { sheet: "sp-light", at: "caster", scale: 1.2, tint: 0xffe08a },
  "brewkeeper:Q": { sheet: "sp-water", at: "target", scale: 1.1, tint: 0x8bf0a8 },
  "brewkeeper:W": { sheet: "sp-gypno", at: "target", scale: 1.9, tint: 0xc78bff },
  "brewkeeper:E": { sheet: "sp-light", at: "caster", scale: 1.5, tint: 0x9bf0b0 },
};

export function abilityCastFx(effect: string): SpellCastFx | null {
  return ABILITY_CAST_FX[effect] ?? null;
}

/** Persistent zone visuals for ground effects, keyed off the GroundEffect.effect.
 *  "fire" tiles a looping flame; "storm" rains lightning bolts; "heal" pools water. */
export type GroundFxKind = "fire" | "storm" | "heal" | "none";
export function groundFxKind(effect: string, isHeal: boolean): GroundFxKind {
  if (isHeal || effect.startsWith("brewkeeper")) return "heal";
  if (effect.includes("storm") || effect.startsWith("stormcaller")) return "storm";
  if (
    effect.includes("fire") ||
    effect.includes("flash") ||
    effect.includes("conflag") ||
    effect.startsWith("emberhex")
  )
    return "fire";
  return "none";
}

/** Colour an ability/cast effect by its element keyword (rings, beams, numbers). */
export function effectColor(effect: string): number {
  if (
    effect.startsWith("emberhex") ||
    effect.includes("fire") ||
    effect.includes("flash") ||
    effect.includes("conflag")
  )
    return 0xff7a2a;
  if (effect.startsWith("stormcaller") || effect.includes("storm") || effect.includes("pierc"))
    return 0x6ab8ff;
  if (effect.startsWith("brewkeeper")) return 0x8be07a;
  if (effect.startsWith("boomtinker")) return 0xffd24d;
  if (effect.startsWith("duskblade")) return 0xb06bff;
  if (effect.startsWith("ironvow")) return 0x9cc4ff;
  return 0xffffff;
}
