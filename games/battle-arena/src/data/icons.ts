import type { AbilityKey } from "../sim/types";

/** Icon basename (no extension) → served path, e.g. iconUrl("item-boots"). */
export const iconUrl = (name: string) => `./icons/${name}.webp`;

const ICON_PREFIX_ALIAS = new Map<string, string>([["blackknight", "paladin"]]);

/** Ability tile icon. Q/W/E/R → per-champ `{prefix}-{q|w|e|r}.webp` (id →
 *  art-prefix aliased). DASH/JUMP are the flat util pair: they share one glyph
 *  each (`ability-dash`/`ability-jump`) across every champion. */
export const abilityIcon = (champId: string, key: AbilityKey) =>
  key === "DASH" || key === "JUMP"
    ? iconUrl(`ability-${key.toLowerCase()}`)
    : iconUrl(`${ICON_PREFIX_ALIAS.get(champId) ?? champId}-${key.toLowerCase()}`);

const ATTACK_ICON_BY_KIND = new Map([
  ["arrow", "attack-arrow"],
  ["bolt", "attack-bolt"],
]);

export const attackIcon = (attackKind: string) =>
  iconUrl(ATTACK_ICON_BY_KIND.get(attackKind) ?? "attack-melee");

/** A champion's identity mark = their ult icon (kill feed, select cards). */
export const champSigil = (champId: string) => abilityIcon(champId, "R");

const STATUS_ICONS = new Map<string, string>([
  ["stun", "status-stun"],
  ["root", "status-root"],
  ["slow", "status-slow"],
  ["speed", "status-speed"],
  ["stealth", "status-stealth"],
  ["shield", "status-shield"],
  ["dot", "status-dot"],
  ["heal", "status-heal"],
  ["damageAmp", "status-damage-amp"],
  ["attackSpeed", "status-attack-speed"],
  ["armor", "status-armor"],
  ["empower", "status-empower"],
]);

/** Buff-row chip icon; null = status kinds that get no chip (silence etc.). */
export const statusIcon = (kind: string) => {
  const name = STATUS_ICONS.get(kind);

  return name !== undefined && name !== "" ? iconUrl(name) : null;
};
