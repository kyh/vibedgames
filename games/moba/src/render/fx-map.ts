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
  { key: "sp-arc", frame: 128, frames: 12, fps: 30 },
  { key: "sp-flare-ring", frame: 128, frames: 8, fps: 24 },
  { key: "sp-fire-pillar", frame: 160, frames: 8, fps: 22 },
  { key: "sp-geyser", frame: 128, frames: 7, fps: 22 },
  { key: "sp-skull", frame: 128, frames: 20, fps: 28 },
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
} satisfies Record<string, string>;

const ABILITY_ICON_LOOKUP = new Map<string, string>(Object.entries(ABILITY_ICON));

/** Frame in the packed spell-icon sheet for an ability's HUD icon. */
export function abilityIconFrame(effect: string): number | null {
  const name = ABILITY_ICON_LOOKUP.get(effect);
  return name === undefined ? null : (SPELL_ICON_FRAME[name] ?? null);
}

/** A one-shot sprite burst played when an ability is cast (on top of the
 *  procedural ring/beam). `at` chooses caster vs the targeted point. */
export type SpellCastFx = {
  sheet: string;
  at: "caster" | "target";
  scale: number;
  tint?: number;
  startFrame?: number;
};

export const ABILITY_CAST_FX = {
  "ironvow:Q": { sheet: "sp-light", at: "target", scale: 0.9 },
  "ironvow:W": { sheet: "sp-light", at: "caster", scale: 1.3, tint: 0xbcd6ff },
  "ironvow:R": { sheet: "sp-light", at: "caster", scale: 2.6, tint: 0xbcd6ff },
  "duskblade:Q": { sheet: "sp-smoke", at: "caster", scale: 1.0, tint: 0xb06bff },
  "duskblade:W": { sheet: "sp-spikes", at: "target", scale: 1.4, startFrame: 3 },
  "duskblade:R": { sheet: "sp-skull", at: "target", scale: 2.2, tint: 0xc89bff, startFrame: 5 },
  "stormcaller:W": { sheet: "sp-arc", at: "target", scale: 1.2, startFrame: 3 },
  "stormcaller:E": { sheet: "sp-tornado", at: "caster", scale: 1.25, tint: 0xbfe6ff },
  "stormcaller:R": { sheet: "sp-lightning", at: "target", scale: 1.3, startFrame: 3 },
  "emberhex:Q": { sheet: "sp-fire", at: "caster", scale: 0.9, startFrame: 3 },
  "emberhex:W": { sheet: "sp-fire", at: "caster", scale: 1.0, startFrame: 6 },
  "emberhex:E": { sheet: "sp-flare-ring", at: "caster", scale: 1.1, startFrame: 1 },
  "boomtinker:Q": { sheet: "sp-smoke", at: "caster", scale: 0.9, tint: 0xd8c0a0 }, // toss puff
  "boomtinker:W": { sheet: "sp-smoke", at: "target", scale: 1.0, tint: 0xffd24d },
  "boomtinker:E": { sheet: "sp-light", at: "caster", scale: 1.2, tint: 0xffe08a },
  "boomtinker:R": { sheet: "fx-explode1", at: "target", scale: 1.6 },
  "brewkeeper:Q": { sheet: "sp-geyser", at: "target", scale: 0.9, startFrame: 2 },
  "brewkeeper:W": { sheet: "sp-gypno", at: "target", scale: 1.9, tint: 0xc78bff },
  "brewkeeper:E": { sheet: "sp-light", at: "caster", scale: 1.5, tint: 0x9bf0b0 },
  "brewkeeper:R": { sheet: "sp-light", at: "caster", scale: 2.3, tint: 0x9bf0b0 }, // last call
} satisfies Record<string, SpellCastFx>;

const CAST_FX_LOOKUP = new Map<string, SpellCastFx>(Object.entries(ABILITY_CAST_FX));

export function abilityCastFx(effect: string): SpellCastFx | null {
  return CAST_FX_LOOKUP.get(effect) ?? null;
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

/** Existing hero palette at contact; neutral sources retain the damage-type cue. */
export function hitColor(hero: string | undefined, magic: boolean): number {
  switch (hero) {
    case "ironvow":
    case "duskblade":
    case "stormcaller":
    case "emberhex":
    case "boomtinker":
    case "brewkeeper":
      return effectColor(hero);
    default:
      return magic ? 0xc78bff : 0xffffff;
  }
}
