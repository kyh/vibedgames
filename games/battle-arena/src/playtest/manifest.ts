// What `vg playtest run` may do in the arena, in the words its decision model
// chooses between. Closing distance, facing and swinging inside reach are all
// frame-tight, so every move is a per-frame reflex: the model picks the PLAN a
// few times a second (fight, kite, heal, loot) and the reflex plays it at 60 fps.
// Abilities are keydown-edge casts along the current aim, so they are actions —
// the reflex keeps the champion facing the target they should land on.
import { definePlaytest } from "@vibedgames/playtest";
import type { Diagnostics, PlaytestManifest, ReflexInputs } from "@vibedgames/playtest";
import { CHAMP_BY_ID, DEFAULT_CHAMP } from "../data/champions";
import type { AbilityDef } from "../data/champions";
import { KILL_GOAL_FFA } from "../data/config";
import type { AbilityKey } from "../sim/types";
import type { Bearing, PlaytestSense, TargetSense } from "./sense";

export type BattleDiagnostics = Diagnostics & { fight: PlaytestSense | null };

// Pointer height for every aim: clear of the ability bar and the top plates.
const AIM_Y = 0.42;
const IDLE: ReflexInputs = { keys: [] };

/** The pointer x that faces a world direction. Under `?test=1` the controls map
 *  pointer x to an absolute heading (input/controls.ts), aim = (sin yaw, cos yaw). */
const aimAt = (x: number, y: number, down: boolean): ReflexInputs["pointer"] => {
  const yaw = Math.atan2(x, y);
  return { down, x: Math.min(0.998, Math.max(0.002, 0.5 - yaw / (Math.PI * 2))), y: AIM_Y };
};

const walkTo = (to: Bearing): ReflexInputs => ({
  keys: ["KeyW"],
  pointer: aimAt(to.pathX, to.pathY, false),
});

/** Swing a little before the target is strictly in reach: melee lunges into
 *  the blow, and a ranged shot outflies its nominal range. */
const swingSlack = (fight: PlaytestSense): number => (fight.attackRange > 4 ? 3 : 1.2);

const engage = (fight: PlaytestSense, target: TargetSense): ReflexInputs => {
  const swing = target.dist <= fight.attackRange + swingSlack(fight);
  if (!swing && target.dist > fight.attackRange + 2.5) {
    return walkTo(target);
  }
  return {
    keys: target.dist > fight.attackRange * 0.75 ? ["KeyW"] : [],
    pointer: aimAt(target.dx, target.dy, swing),
  };
};

/** Backpedal from the threat without ever turning away from it, drifting
 *  towards the home fountain so the retreat ends somewhere safe. */
const kite = (fight: PlaytestSense, threat: TargetSense): ReflexInputs => {
  const len = Math.hypot(threat.dx, threat.dy) || 1;
  const ax = threat.dx / len;
  const ay = threat.dy / len;
  // KeyD strafes along (-aimY, aimX) — scenes/game-scene.ts rotateToAim
  const drift = fight.home.pathX * -ay + fight.home.pathY * ax;
  const keys = ["KeyS"];
  if (drift > 0.35) {
    keys.push("KeyD");
  } else if (drift < -0.35) {
    keys.push("KeyA");
  }
  return {
    keys,
    pointer: aimAt(ax, ay, threat.dist <= fight.attackRange + swingSlack(fight)),
  };
};

const heal = (fight: PlaytestSense): ReflexInputs => {
  if (!fight.home.onFountain || fight.home.dist > 2.5) {
    return walkTo(fight.home);
  }
  const { threat } = fight;
  if (threat && threat.dist <= fight.attackRange + swingSlack(fight)) {
    return { keys: [], pointer: aimAt(threat.dx, threat.dy, true) };
  }
  return IDLE;
};

type Plan = (fight: PlaytestSense) => ReflexInputs;
const reflex =
  (plan: Plan) =>
  (game: BattleDiagnostics | null): ReflexInputs => {
    const fight = game?.fight;
    return fight && fight.respawnInMs === 0 ? plan(fight) : IDLE;
  };

const ABILITY_CODES = {
  DASH: "ShiftLeft",
  E: "Digit3",
  JUMP: "Space",
  Q: "Digit1",
  R: "Digit4",
  W: "Digit2",
} satisfies Record<AbilityKey, string>;

const ACTION_NAMES = {
  DASH: "dash",
  E: "skill3",
  JUMP: "leap",
  Q: "skill1",
  R: "ultimate",
  W: "skill2",
} satisfies Record<AbilityKey, string>;

/** When to say yes, from how the ability is aimed. Every window is wide on
 *  purpose: the state is a decision old by the time the key lands. */
const castWindow = (def: AbilityDef): string => {
  const ready = `game.fight.ready.${def.key} is true`;
  const d = "game.fight.bestTarget.dist";
  if (def.key === "JUMP") {
    return def.values["air"]
      ? `Yes when ${ready} and ${d} <= 6.`
      : `Leaps ${def.castRange} forward then slams. Yes when ${ready} and ${d} is between 2 and ${def.castRange + 2}.`;
  }
  switch (def.targeting) {
    case "dash": {
      return `Bursts ${def.castRange} in the direction you are moving: closes the gap during fight, escapes during kite/heal. Yes when ${ready} and ${d} is between 5 and ${def.castRange + 5}, or when kiting with game.fight.incoming set.`;
    }
    case "direction": {
      return `Fires along your aim (the fight move aims it). Yes when ${ready} and ${d} <= ${def.castRange}.`;
    }
    case "ground": {
      const lands = Math.min(8, def.castRange);
      return `Lands ${lands} in front of you. Yes when ${ready} and ${d} is between ${Math.max(0, lands - 3)} and ${lands + 2}.`;
    }
    default: {
      return `Centred on you. Yes when ${ready} and ${d} <= ${def.values["radius"]?.[0] ?? 4}.`;
    }
  }
};

export const buildPlaytestManifest = (champId: string): PlaytestManifest<BattleDiagnostics> => {
  const champ = CHAMP_BY_ID[champId] ?? CHAMP_BY_ID[DEFAULT_CHAMP];
  const actions: NonNullable<PlaytestManifest["actions"]> = {};
  for (const def of Object.values(champ?.abilities ?? {})) {
    actions[ACTION_NAMES[def.key]] = {
      description: `${def.name} — ${def.desc} ${castWindow(def)} Otherwise no.`,
      keys: [ABILITY_CODES[def.key]],
    };
  }
  return definePlaytest<BattleDiagnostics>({
    actions,
    goal: `You are ${champ?.name ?? "a champion"} in a free-for-all dungeon arena. game.score counts enemies you have slain — skeleton creeps guarding camps and enemy champions; first champion to ${KILL_GOAL_FFA} champion kills wins. Everything about the fight is in game.fight, as vectors FROM you in world units. bestTarget is the enemy worth fighting now (dist is the gap to its edge, hpPct its health, windingUp/strikeInMs its blow already in motion, stunned = free hits). threat is the nearest enemy of any kind, enemiesNear how many are within 8. incoming is a blow that WILL hit you if you stay put. hpPct is YOUR health (0-1) and game.fight.condition is what it means: "healthy" = go and fight, "hurt" = kite, "critical" or "recovering" = heal. home is your base fountain: standing on it (home.onFountain) restores 18% health a second and burns enemies who follow. loot is dropped gold on the floor. You die at hpPct 0 and lose seconds respawning (condition "dead": nothing works). Score only comes from fighting, so whenever condition is "healthy" choose fight — even when bestTarget is far away, the fight move walks you there. Cast every ready ability that is in range — abilities are most of your damage.`,
    // one decision's hold walks ~1.1 world units
    minDisplacement: 0.2,
    move: {
      fight: {
        description:
          'Fight bestTarget: run to it however far, face it and keep swinging once in reach — choose whenever game.fight.condition is "healthy"',
        reflex: reflex((fight) => (fight.bestTarget ? engage(fight, fight.bestTarget) : IDLE)),
      },
      heal: {
        description:
          'Run home to the fountain and stand on it — only when game.fight.condition is "critical" or "recovering"',
        reflex: reflex(heal),
      },
      kite: {
        description:
          'Back away from the threat while still facing and hitting it — only when game.fight.condition is "hurt"',
        reflex: reflex((fight) => (fight.threat ? kite(fight, fight.threat) : heal(fight))),
      },
      loot: {
        description:
          'Walk onto the dropped gold at game.fight.loot — only when condition is "healthy", loot is not null and enemiesNear is 0',
        reflex: reflex((fight) => {
          if (fight.loot) {
            return walkTo(fight.loot);
          }
          return fight.bestTarget ? engage(fight, fight.bestTarget) : IDLE;
        }),
      },
    },
  });
};
