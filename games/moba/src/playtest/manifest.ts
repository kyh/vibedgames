// What `vg playtest run` may do here, in the words its decision model picks
// between. The model chooses the PLAN a few times a second — push, duel, hold,
// retreat; the reflexes below do the hands at 60 fps: walking the A* route,
// stopping at attack range, clicking the creep that is one hit from death.

import type { ActionOption, PlaytestManifest, ReflexInputs } from "@vibedgames/playtest";

import { HERO_BY_ID } from "../data/heroes";
import type { AbilityKey } from "../data/heroes";
import type { GameScene } from "../scenes/game-scene";
import type { TargetSense } from "./sense";

export type MobaDiagnostics = ReturnType<GameScene["diagnostics"]>;

interface Step {
  x: number;
  y: number;
}

// tan(22.5°): inside it an axis is "off", so a step snaps to the nearest of 8 headings.
const AXIS_DEADZONE = 0.38;

const walk = (step: Step | undefined): ReflexInputs => {
  const keys: string[] = [];
  if (!step) {
    return { keys, pointer: null };
  }
  if (step.x > AXIS_DEADZONE) {
    keys.push("ArrowRight");
  } else if (step.x < -AXIS_DEADZONE) {
    keys.push("ArrowLeft");
  }
  if (step.y > AXIS_DEADZONE) {
    keys.push("ArrowDown");
  } else if (step.y < -AXIS_DEADZONE) {
    keys.push("ArrowUp");
  }
  return { keys, pointer: null };
};

/** Left-click a unit once: a click is an attack order, and re-issuing it every
 *  frame would restart the swing it is waiting on. */
const click = (target: TargetSense | null): ReflexInputs | null =>
  target?.screen && !target.targeted
    ? { keys: [], pointer: { down: true, x: target.screen.sx, y: target.screen.sy } }
    : null;

/** Stand and fight: no keys is a HOLD, which auto-attacks the nearest enemy in
 *  range; the parked cursor is where Q/W/E/R will fly. */
const stand = (diag: MobaDiagnostics): ReflexInputs => ({
  keys: [],
  pointer: diag.aim ? { x: diag.aim.sx, y: diag.aim.sy } : null,
});

const fight = (diag: MobaDiagnostics): ReflexInputs =>
  (diag.channeling ? null : click(diag.lastHit ?? null)) ?? stand(diag);

// Stop this far outside a tower's range: a decision's worth of walking, so a
// stale "safe" reading cannot carry the hero under it.
const TOWER_MARGIN = 120;

/** Walking further would put the hero under a tower with no creeps to take its shots. */
const towerAhead = (diag: MobaDiagnostics): boolean => {
  const tower = diag.enemyTower;
  return (
    tower !== null &&
    tower !== undefined &&
    tower.alliedCreepsInItsRange === 0 &&
    (tower.dist ?? Infinity) < tower.range + TOWER_MARGIN
  );
};

const canHit = (diag: MobaDiagnostics): boolean =>
  diag.enemyCreep?.inRange === true ||
  diag.enemyHero?.inRange === true ||
  (diag.enemyTower?.inRange === true && diag.enemyTower.attackable);

const ABILITY_KEYS: readonly AbilityKey[] = ["Q", "W", "E", "R"];

const abilityActions = (heroId: string) => {
  const def = HERO_BY_ID[heroId];
  const actions = new Map<string, ActionOption>();
  for (const key of ABILITY_KEYS) {
    const ability = def?.abilities[key];
    if (ability && ability.targeting !== "passive") {
      actions.set(`cast_${key}`, {
        description: `cast ${ability.name} (${ability.desc}) — yes when game.abilities.${key}.usable is true, otherwise no`,
        keys: [`Key${key}`],
      });
    }
  }
  return Object.fromEntries(actions);
};

export const createManifest = (heroId: string): PlaytestManifest<MobaDiagnostics> => {
  // The H (recall) order is read on the keydown edge, so it has to be tapped,
  // and tapped again if a same-frame key release overwrote it with a HOLD.
  let tap = 0;
  return {
    actions: abilityActions(heroId),
    goal: [
      "You are one hero in a 3v3 MOBA against bots, fighting in a lane. game.score rises with every point of damage you deal to enemies, last hits on enemy creeps (+50), hero kills (+500) and assists (+200) — raise it and stay alive; dying costs ~10+ seconds (game.player.alive false, respawnInSec).",
      "All vectors are from your hero in pixels (+dx right, +dy down); your attack reaches a target when its inRange is true.",
      "push_lane is the default: it walks the safe route to the front of your creep wave and attacks whatever comes into range — creeps first, then game.enemyTower once attackable; it waits outside an enemy tower's range until your creeps are under it (enemyTower.alliedCreepsInItsRange > 0).",
      "attack_hero when game.enemyHero is not null, its dist is under 700, and you are not weaker (your player.hpPct >= its hpPct, or enemyHeroesNear <= 1 and player.hpPct > 0.5).",
      "hold_and_attack when game.towerDanger is false and an enemy is already inRange and you should not step further forward (enemyHeroesNear >= 2, or game.underEnemyTower).",
      "retreat EARLY — decisions land ~0.25 s late and a hero loses 10% hp in that time: retreat when player.hpPct < 0.4, or when game.towerDanger is true, or when enemyHeroesNear >= 2 and player.hpPct < 0.6. Keep retreating until player.hpPct > 0.8 if game.home.dist < 1200 (the fountain heals fast). Otherwise go back to push_lane.",
      "Abilities cost mana and have cooldowns; game.abilities.<key>.usable already folds in cooldown, mana and a target in reach.",
    ].join(" "),
    move: {
      attack_hero: {
        description:
          "Chase and attack the nearest enemy hero (game.enemyHero) — for a kill on a weaker or lone hero",
        reflex: (diag) => {
          if (!diag?.player?.alive) {
            return null;
          }
          const foe = diag.enemyHero;
          if (!foe) {
            return canHit(diag) ? fight(diag) : walk(diag.advance);
          }
          if (foe.targeted || diag.channeling) {
            return stand(diag);
          }
          return click(foe) ?? walk({ x: foe.dx / foe.dist, y: foe.dy / foe.dist });
        },
      },
      hold_and_attack: {
        description:
          "Stand your ground and attack what is already in range, last-hitting creeps — do not step forward",
        reflex: (diag) => (diag?.player?.alive ? fight(diag) : null),
      },
      push_lane: {
        description:
          "Advance down the lane with your creep wave and attack whatever comes into range — the default, and how the score rises",
        reflex: (diag) => {
          if (!diag?.player?.alive) {
            return null;
          }
          if (diag.channeling) {
            return stand(diag);
          }
          if (diag.towerDanger) {
            return walk(diag.home);
          }
          return canHit(diag) || towerAhead(diag) ? fight(diag) : walk(diag.advance);
        },
      },
      retreat: {
        description:
          "Walk back to your fountain to heal — when hp is low, a tower is shooting you, or you are outnumbered",
        reflex: (diag) => {
          if (!diag?.player?.alive || diag.order === "fountain") {
            return { keys: [], pointer: null };
          }
          tap += 1;
          return { keys: tap % 4 < 2 ? ["KeyH"] : [], pointer: null };
        },
      },
    },
  };
};
