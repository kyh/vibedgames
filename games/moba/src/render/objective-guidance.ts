import { enemyOf } from "../data/config";
import type { StructTier, Team } from "../data/config";
import type { AbilityKey } from "../data/heroes";
import { ITEMS, MAX_ITEMS } from "../data/items";
import { BASES } from "../data/map";
import type { LaneId } from "../data/map";
import type { FxEvent, Unit, World } from "../sim/types";
import { abilityUpgrade } from "./hud-presentation";

export interface ObjectiveGuidance {
  targetId: string;
  lane: LaneId | "base";
  text: string;
  respawnTip: string | null;
}

export interface StructureAnnouncement {
  text: string;
  tone: "good" | "bad" | "neutral";
  priority: "objective" | "major" | "ending";
}

const TIER_DEPTH = { ancient: 3, base: 2, t1: 0, t2: 1 } satisfies Record<StructTier, number>;
const ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R"];

function exposed(world: World, team: Team, tier: StructTier, lane?: LaneId): boolean {
  for (const unit of world.units.values()) {
    const { structure } = unit;
    if (
      unit.kind === "structure" &&
      unit.team === team &&
      unit.alive &&
      structure?.attackable &&
      structure.tier === tier &&
      (lane === undefined || structure.lane === lane)
    ) {
      return true;
    }
  }
  return false;
}

function respawnTip(world: World, player: Unit): string | null {
  const { hero } = player;
  if (player.alive || !hero || hero.respawnAt <= 0) {
    return null;
  }
  if (exposed(world, player.team, "ancient")) {
    return "Your Ancient is exposed. Regroup at base on return.";
  }
  const upgrade = ABILITY_KEYS.find((key) => abilityUpgrade(hero, key).kind === "available");
  if (upgrade) {
    return `Unspent skill point: upgrade ${upgrade} before returning to lane.`;
  }
  if (
    hero.items.length < MAX_ITEMS &&
    ITEMS.some((item) => item.cost <= hero.gold && !hero.items.includes(item.id))
  ) {
    return "You can afford an item. Visit the base shop after respawning.";
  }
  return "Return with your creeps. Tower damage ramps on the same target.";
}

/** Follow the sim's attackable flags; a lane breach can expose both base towers. */
export function objectiveGuidance(
  world: World,
  player: Unit | undefined,
): ObjectiveGuidance | null {
  if (world.phase !== "playing" || !player?.hero || player.neutral) {
    return null;
  }
  const enemy = enemyOf(player.team);
  const origin = player.alive ? player : BASES[player.team].heroSpawn;
  let target: Unit | undefined;
  let depth = -1;
  let distance = Infinity;
  let baseTowers = 0;
  for (const unit of world.units.values()) {
    const { structure } = unit;
    if (
      unit.kind !== "structure" ||
      unit.team !== enemy ||
      unit.neutral ||
      !unit.alive ||
      !structure?.attackable
    ) {
      continue;
    }
    if (structure.tier === "base") {
      baseTowers++;
    }
    const candidateDepth = TIER_DEPTH[structure.tier];
    const candidateDistance = (unit.x - origin.x) ** 2 + (unit.y - origin.y) ** 2;
    if (
      candidateDepth > depth ||
      (candidateDepth === depth &&
        (candidateDistance < distance ||
          (candidateDistance === distance && (!target || unit.id < target.id))))
    ) {
      target = unit;
      depth = candidateDepth;
      distance = candidateDistance;
    }
  }
  if (!target?.structure) {
    return null;
  }
  const { tier, lane } = target.structure;
  const text =
    tier === "ancient"
      ? "FINISH THE ENEMY ANCIENT"
      : tier === "base"
        ? baseTowers === 1
          ? "BREAK THE LAST ENEMY BASE TOWER"
          : "PUSH THE ENEMY BASE TOWERS"
        : `PUSH ${lane.toUpperCase()} · ${tier === "t1" ? "OUTER" : "INNER"} TOWER`;
  return { lane, respawnTip: respawnTip(world, player), targetId: target.id, text };
}

/** Structure events carry coordinates, while retained rubble supplies the lane. */
export function structureAnnouncement(
  world: World,
  event: Extract<FxEvent, { t: "structureDown" }>,
  localTeam: Team | null,
): StructureAnnouncement {
  const owner = localTeam
    ? event.team === localTeam
      ? "YOUR"
      : "ENEMY"
    : event.team.toUpperCase();
  const fallen = [...world.units.values()].find(
    (unit) =>
      unit.kind === "structure" &&
      unit.team === event.team &&
      unit.structure?.tier === event.tier &&
      unit.x === event.x &&
      unit.y === event.y,
  );
  const lane = fallen?.structure?.lane;
  let text = `${owner} ${event.tier === "ancient" ? "ANCIENT" : event.tier === "base" ? "BASE TOWER" : "TOWER"} HAS FALLEN`;
  if (event.tier !== "ancient" && lane && lane !== "base") {
    const position = `${owner} ${lane.toUpperCase()}`;
    if (event.tier === "t1") {
      text = `${position} OUTER TOWER DOWN`;
      if (exposed(world, event.team, "t2", lane)) {
        text += " · INNER TOWER EXPOSED";
      }
    } else if (event.tier === "t2") {
      text = `${position} LANE OPEN`;
      if (exposed(world, event.team, "base")) {
        text += " · BASE TOWERS EXPOSED";
      }
    }
  } else if (event.tier === "base" && exposed(world, event.team, "ancient")) {
    text += " · ANCIENT EXPOSED";
  }
  return {
    priority:
      event.tier === "ancient"
        ? "ending"
        : event.tier === "base" || event.tier === "t2"
          ? "major"
          : "objective",
    text,
    tone: localTeam ? (event.team === localTeam ? "bad" : "good") : "neutral",
  };
}
