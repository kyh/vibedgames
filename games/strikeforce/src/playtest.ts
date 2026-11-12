// The playtest contract: live diagnostics every playtest reads, plus (behind
// dev or `?test=1`) test hooks and a control manifest for `vg playtest run`.
// Positions are world metres, so the manifest sets `minDisplacement`. A
// playtest plays alone (main.ts keeps it out of rooms), so deathmatch sits in
// warmup: the dock and its own body.
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

interface Nearby {
  nearestEnemy: Offset | null;
  nearestRelay: Offset | null;
}

/** Offsets to what the player is looking for: a relay, the nearest enemy (crew or player). */
const nearby = (game: StrikeforceGame, match: Match): Nearby => {
  const { pos } = game.player;
  const pve = game.game.run.mode !== "deathmatch";
  const crew = game.enemies.list.filter((e) => e.alive).map((e) => e.pos);
  const relays = game.game.run.relays.filter((r) => !r.cut).map((r) => r.o.pos);
  const at = (p: Point | null): Offset | null => (p ? offset(pos, p) : null);
  return {
    nearestEnemy: at(nearestOf(pos, pve ? crew : match.enemies())),
    nearestRelay: at(nearestOf(pos, relays)),
  };
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
    return {
      ...nearby(game, match),
      alive: player.alive,
      complete: m?.phase === "over",
      deaths: me?.deaths ?? 0,
      frame,
      health: Math.round(player.health),
      kills: me?.kills ?? 0,
      mode: game.game.run.mode,
      phase: m?.phase ?? "connecting",
      player: {
        x: Math.round(player.pos.x * 100) / 100,
        y: Math.round(player.pos.y * 100) / 100,
        yaw: Math.round(player.yaw * 100) / 100,
        z: Math.round(player.pos.z * 100) / 100,
      },
      players: match.size,
      score: me?.kills ?? 0,
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
      use: { description: "Hold to cut a relay (solo Mission)", keys: ["KeyE"] },
    },
    goal: 'First-person shooter on a rainy container dock. In deathmatch (mode "deathmatch"; alone it stays in warmup) explore the dock: walk from the West Lot to the quay. In solo PvE (?mode=mission) cut the relays (nearestRelay; hold use on one) while soldiers hunt you (nearestEnemy): turn to face them and fire; aim for the head.',
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
