// The playtest contract: live diagnostics every playtest reads, plus (behind
// dev or `?test=1`) test hooks and a control manifest for `vg playtest run`.
// Positions are world metres, so the manifest sets `minDisplacement`. A
// playtest plays alone (main.ts keeps it out of rooms), so it sees warmup:
// the dock, the two sites and its own body.
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
import type { Vector3 } from "three";

import type { StrikeforceGame } from "./core/types";
import type { Match } from "./net/match";
import type { Point } from "./net/rules";

/** Horizontal offset from the player to something, in metres. */
interface Offset {
  dx: number;
  dz: number;
  dist: number;
}

const offset = (from: Vector3, to: Point): Offset => {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return {
    dist: Math.round(Math.hypot(dx, dz) * 10) / 10,
    dx: Math.round(dx * 10) / 10,
    dz: Math.round(dz * 10) / 10,
  };
};

const nearestOf = (from: Vector3, points: readonly Point[]): Point | null => {
  let best: Point | null = null;
  let bestD = Infinity;
  for (const point of points) {
    const d = Math.hypot(point.x - from.x, point.z - from.z);
    if (d < bestD) {
      bestD = d;
      best = point;
    }
  }
  return best;
};

const sideOf = (team: number | undefined, attack: number | undefined): string | null => {
  if (team === undefined || attack === undefined) {
    return null;
  }
  return team === attack ? "attack" : "defend";
};

export const installPlaytest = (game: StrikeforceGame, match: Match): void => {
  let frame = 0;
  const tick = (): void => {
    frame += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  publishDiagnostics(() => {
    const { player } = game;
    const m = match.state;
    const me = m?.roster.get(match.me);
    const site = nearestOf(player.pos, match.sites());
    const enemy = nearestOf(player.pos, match.enemies());
    return {
      alive: player.alive,
      carrying: m?.charge.state === "carried" && m.charge.carrier === match.me,
      complete: m?.phase === "over",
      frame,
      health: Math.round(player.health),
      nearestEnemy: enemy ? offset(player.pos, enemy) : null,
      nearestSite: site ? offset(player.pos, site) : null,
      phase: m?.phase ?? "connecting",
      player: {
        x: Math.round(player.pos.x * 100) / 100,
        y: Math.round(player.pos.y * 100) / 100,
        yaw: Math.round(player.yaw * 100) / 100,
        z: Math.round(player.pos.z * 100) / 100,
      },
      players: match.size,
      round: m?.round ?? 0,
      scoreGold: m?.score[0] ?? 0,
      scoreSteel: m?.score[1] ?? 0,
      side: sideOf(me?.team, m?.attack),
      state: game.game.state,
    };
  });

  if (!import.meta.env.DEV && !isPlaytestRequested()) {
    return;
  }
  publishTestHooks({
    setState: (name) => {
      if (name === "active-play" && game.game.state === "title") {
        game.game.start({ skipIntro: true });
      }
      return { state: game.game.state };
    },
  });
  publishPlaytest({
    actions: {
      fire: { description: "Fire the rifle where the camera faces", keys: ["Enter"] },
      reload: { description: "Reload the rifle", keys: ["KeyR"] },
      use: {
        description: "Hold to plant (carrying, on a site) or defuse (on the charge)",
        keys: ["KeyE"],
      },
    },
    goal: "Round-based first-person shooter on a rainy container dock. Walk the map: visit both bomb sites (nearestSite is the offset to the closer one, in metres) and check the player moves, turns and fires cleanly. Alone, the match stays in warmup.",
    minDisplacement: 0.05,
    move: {
      back: { description: "Walk backward", keys: ["KeyS"] },
      forward: { description: "Walk forward, the way the camera faces", keys: ["KeyW"] },
      forward_turn_left: {
        description: "Walk forward while turning left",
        keys: ["KeyW", "ArrowLeft"],
      },
      forward_turn_right: {
        description: "Walk forward while turning right",
        keys: ["KeyW", "ArrowRight"],
      },
      sprint: { description: "Sprint forward", keys: ["ShiftLeft", "KeyW"] },
      strafe_left: { description: "Step left", keys: ["KeyA"] },
      strafe_right: { description: "Step right", keys: ["KeyD"] },
      turn_left: { description: "Turn left on the spot", keys: ["ArrowLeft"] },
      turn_right: { description: "Turn right on the spot", keys: ["ArrowRight"] },
    },
  });
};
