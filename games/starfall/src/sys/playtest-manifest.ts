import { publishPlaytest } from "@vibedgames/playtest";
import type { ReflexInputs } from "@vibedgames/playtest";

import { SHIP_DEAD_ZONE, SHIP_THRUST_RAMP } from "../shared/constants";
import type { Diagnostics } from "../shared/diag";

/** What `vg playtest run` may do to starfall, in the words the decision model chooses between. The ship flies at the cursor and the camera is centred on the ship, so a pointer position IS a heading plus a throttle; every move is a per-frame reflex that turns one intent (attack, dodge, loot) into that cursor, because tracking a drifting rock through a ~200 ms stale snapshot misses. The model picks the intent. */

/** Cursor distance that saturates the throttle (shared/constants.ts ramp). */
const FULL_THRUST_REACH = SHIP_DEAD_ZONE + SHIP_THRUST_RAMP;
/** Inside the dead zone the ship brakes but the nose still tracks the cursor. */
const BRAKE_REACH = SHIP_DEAD_ZONE / 2;
/** Hold this much clear space to the target's hull while shooting it. */
const STANDOFF_GAP = 170;
/** Threats past this gap don't bend the escape heading. */
const EVADE_RANGE = 320;
const WALL_RANGE = 260;
const PICKUP_ARRIVE = 12;

const clamp = (v: number): number => Math.min(0.98, Math.max(0.02, v));

/** Hold the cursor `reach` px from the ship along (dx, dy), trigger down. */
const steer = (game: Diagnostics, dx: number, dy: number, reach: number): ReflexInputs => {
  const len = Math.hypot(dx, dy) || 1;
  const { w, h, zoom } = game.view;
  return {
    pointer: {
      down: true,
      x: clamp(0.5 + ((dx / len) * reach * zoom) / Math.max(1, w)),
      y: clamp(0.5 + ((dy / len) * reach * zoom) / Math.max(1, h)),
    },
  };
};

const towardCentre = (game: Diagnostics): ReflexInputs =>
  steer(
    game,
    game.walls.right - game.walls.left,
    game.walls.down - game.walls.up,
    FULL_THRUST_REACH,
  );

const attack = (game: Diagnostics | null): ReflexInputs | null => {
  if (!game) {
    return null;
  }
  const { target } = game;
  if (!target) {
    return towardCentre(game);
  }
  const closeEnough = target.dist - target.radius <= STANDOFF_GAP;
  return steer(game, target.aimDx, target.aimDy, closeEnough ? BRAKE_REACH : FULL_THRUST_REACH);
};

const evade = (game: Diagnostics | null): ReflexInputs | null => {
  if (!game) {
    return null;
  }
  let ex = 0;
  let ey = 0;
  for (const t of game.threats) {
    if (t.gap < EVADE_RANGE) {
      const push = 1 / Math.max(20, t.gap);
      ex -= (t.dx / Math.max(1, t.dist)) * push;
      ey -= (t.dy / Math.max(1, t.dist)) * push;
    }
  }
  const wall = (d: number): number => (d < WALL_RANGE ? 1 / Math.max(20, d) : 0);
  ex += wall(game.walls.left) - wall(game.walls.right);
  ey += wall(game.walls.up) - wall(game.walls.down);
  if (ex === 0 && ey === 0) {
    return attack(game);
  }
  return steer(game, ex, ey, FULL_THRUST_REACH);
};

const collect = (game: Diagnostics | null): ReflexInputs | null => {
  const pickup = game?.pickups[0];
  if (!game || !pickup) {
    return attack(game);
  }
  return steer(
    game,
    pickup.dx,
    pickup.dy,
    pickup.dist > PICKUP_ARRIVE ? FULL_THRUST_REACH : BRAKE_REACH,
  );
};

export const publishStarfallPlaytest = (): void => {
  publishPlaytest<Diagnostics>({
    goal: [
      "Top-down space shooter. Raise game.score (XP): every shot that hits an asteroid is +1, destroying it +6, enemies 5-28, an orb pickup +4. The run is endless; dying costs XP progress and ~2.5 s out of play.",
      "game.shield is your health (game.shieldMax full); it refills after ~2.5 s without damage, and at 0 the next hit kills. Asteroids, enemy hulls and enemy shots all drain it on contact. game.invulnerable = nothing can hurt you right now. While game.alive is false you are waiting to respawn and no move matters.",
      "game.target is what `attack` shoots (dx/dy from the ship, +dx right, +dy down; dist px; aimErrorDeg = how far the nose is off it, under ~6 means shots are landing). game.threats lists the nearest dangers, tightest first: gap = free px between hulls, closing = px/s towards you (negative = moving away). game.pickups are the nearest orbs/weapons/shield mods/boosters.",
      "Default to `attack`. Your view is ~200 ms old, so act early: pick `evade` once threats[0].gap is under ~110 with closing above 0, or under ~60 regardless, or when shield is below 35 and any threat gap is under ~200; go back to `attack` as soon as the gap opens past ~150. Pick `collect` when a pickup is within ~400 px and no threat gap is under ~110.",
    ].join(" "),
    move: {
      attack: {
        description:
          "Attack run: fly to firing range of game.target, stop, keep the nose on it and hold fire. The way to score — the default.",
        reflex: attack,
      },
      collect: {
        description:
          "Fly straight to the nearest pickup (game.pickups[0]), firing ahead. Only when nothing dangerous is close.",
        reflex: collect,
      },
      evade: {
        description:
          "Break away at full thrust from the nearest threats and walls, firing ahead to clear the path. Use when something is about to hit you or the shield is low.",
        reflex: evade,
      },
    },
  });
};
