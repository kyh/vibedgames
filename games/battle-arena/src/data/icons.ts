// Icon URL helpers (HUD, shop, select, touch, kill feed). Pure string
// mapping — the webp files live in public/icons/ (see scripts/import-icons.sh).
// Helpers are total: any input yields a well-formed URL (or null for status
// kinds that deliberately get no chip).
import type { AbilityKey } from "../sim/types";

/** Icon basename (no extension) → served path, e.g. iconUrl("item-boots"). */
export const iconUrl = (name: string): string => `./icons/${name}.webp`;

// Champs whose icon files ship under a different prefix than their champ id
// (identity reskins keep the id for sim/net compat but get fresh art).
const ICON_PREFIX_ALIAS: Record<string, string> = {
  blackknight: "paladin", // Aurelius the Dawnward — gold paladin icon set
};

/** Ability tile icon: `{champId}-{q|w|e|r}.webp` (id → art-prefix aliased). */
export const abilityIcon = (champId: string, key: AbilityKey): string =>
  iconUrl(`${ICON_PREFIX_ALIAS[champId] ?? champId}-${key.toLowerCase()}`);

/** Basic-attack icon, keyed by ChampDef.attackKind (unknown kinds → melee). */
export const attackIcon = (attackKind: string): string =>
  iconUrl(
    attackKind === "arrow"
      ? "attack-arrow"
      : attackKind === "bolt"
        ? "attack-bolt"
        : "attack-melee",
  );

/** A champion's identity mark = their ult icon (kill feed, select cards). */
export const champSigil = (champId: string): string => abilityIcon(champId, "R");

const STATUS_ICONS: Record<string, string> = {
  stun: "status-stun",
  root: "status-root",
  slow: "status-slow",
  speed: "status-speed",
  stealth: "status-stealth",
  shield: "status-shield",
  dot: "status-dot",
  heal: "status-heal",
  damageAmp: "status-damage-amp",
  attackSpeed: "status-attack-speed",
  armor: "status-armor",
  empower: "status-empower",
};

/** Buff-row chip icon; null = status kinds that get no chip (silence etc.). */
export const statusIcon = (kind: string): string | null => {
  const name = STATUS_ICONS[kind];
  return name ? iconUrl(name) : null;
};
