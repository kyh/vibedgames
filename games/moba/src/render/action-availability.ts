import { HERO_BY_ID, valAt } from "../data/heroes";
import type { AbilityKey } from "../data/heroes";
import { disabled, silenced } from "../sim/stats";
import type { Unit } from "../sim/types";

export type UnavailableReason =
  | "unavailable"
  | "dead"
  | "stunned"
  | "silenced"
  | "unlearned"
  | "passive"
  | "cooldown"
  | "mana";

type Action = { kind: "dash" } | { kind: "ability"; key: AbilityKey };
type Availability = { kind: "available" } | { kind: "blocked"; reason: UnavailableReason };

/** HUD readiness before target acquisition. Read the same status predicates as
 * castAbility/dashHero; channels are not a lock and dash can break a channel. */
export const actionAvailability = (u: Unit, now: number, action: Action): Availability => {
  const h = u.hero;
  if (!h) {
    return { kind: "blocked", reason: "unavailable" };
  }
  if (!u.alive) {
    return { kind: "blocked", reason: "dead" };
  }
  if (disabled(u)) {
    return { kind: "blocked", reason: "stunned" };
  }
  if (action.kind === "dash") {
    return now < h.dashReadyAt ? { kind: "blocked", reason: "cooldown" } : { kind: "available" };
  }

  const def = HERO_BY_ID[h.defId]?.abilities[action.key];
  const slot = h.abilities[action.key];
  if (!def || slot.rank <= 0) {
    return { kind: "blocked", reason: "unlearned" };
  }
  if (def.targeting === "passive") {
    return { kind: "blocked", reason: "passive" };
  }
  if (silenced(u)) {
    return {
      kind: "blocked",
      reason: u.statuses.some((status) => status.kind === "stun") ? "stunned" : "silenced",
    };
  }
  if (now < slot.readyAt) {
    return { kind: "blocked", reason: "cooldown" };
  }
  if (u.mp < valAt(def.manaCost, slot.rank)) {
    return { kind: "blocked", reason: "mana" };
  }
  return { kind: "available" };
};
