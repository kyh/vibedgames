import { CHAMP_BY_ID } from "../data/champions";
import type { AbilityKey, Unit } from "../sim/types";

export interface PlateAnchor {
  x: number;
  y: number;
  z: number;
}
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface PlateCandidate {
  id: string;
  x: number;
  y: number;
  distance: number;
  priority: number;
  compact: boolean;
}

/** Greedy priority is stable across snapshot iteration order. Labels never
 * move away from their actor to find space; lower-priority clutter yields. */
export function readablePlates(
  candidates: PlateCandidate[],
  keepOut: readonly ScreenBox[],
): PlateCandidate[] {
  const accepted: PlateCandidate[] = [];
  const occupied: ScreenBox[] = [...keepOut];
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target; sort only the copy.
  for (const candidate of [...candidates].sort(
    (a, b) => a.priority - b.priority || a.distance - b.distance || a.id.localeCompare(b.id),
  )) {
    const half = candidate.compact ? 17 : 56;
    const box = {
      bottom: candidate.y + (candidate.compact ? 6 : 22),
      left: candidate.x - half,
      right: candidate.x + half,
      top: candidate.y - 4,
    };
    if (
      occupied.some(
        (other) =>
          box.left < other.right &&
          box.right > other.left &&
          box.top < other.bottom &&
          box.bottom > other.top,
      )
    ) {
      continue;
    }
    accepted.push(candidate);
    occupied.push(box);
  }
  return accepted;
}

type Block = "DEAD" | "LOCKED" | "STUN" | "SILENCE" | "HEX";
export type AbilityReadiness =
  | { kind: "blocked"; label: Block; queued: boolean }
  | { kind: "cooldown"; queued: boolean }
  | { kind: "available"; queued: boolean };

/** The cast admission gates, not target prediction. Ready does not promise
 * that a directional spell will find a target. Mana is not a cast gate here. */
export function abilityReadiness(unit: Unit, key: AbilityKey, now: number): AbilityReadiness {
  const queued = unit.alive && unit.queuedCast?.key === key && unit.queuedCast.until >= now;
  if (!unit.alive) {
    return { kind: "blocked", label: "DEAD", queued: false };
  }
  if (!CHAMP_BY_ID[unit.champId] || unit.kind !== "hero" || unit.abilities[key].rank < 1) {
    return { kind: "blocked", label: "LOCKED", queued: false };
  }
  for (const [kind, label] of [
    ["stun", "STUN"],
    ["silence", "SILENCE"],
    ["hex", "HEX"],
  ] satisfies ["stun" | "silence" | "hex", Block][]) {
    if (unit.statuses.some((status) => status.kind === kind)) {
      return { kind: "blocked", label, queued };
    }
  }
  return { kind: unit.abilities[key].readyAt > now ? "cooldown" : "available", queued };
}
