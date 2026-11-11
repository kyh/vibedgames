// The playtest contract: live diagnostics every playtest reads, plus (behind
// dev or `?test=1`) test hooks and a control manifest for `vg playtest run`.
// Positions are world metres, so the manifest sets `minDisplacement`.
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
import type { Vector3 } from "three";

import type { SaltlineGame } from "./core/types";

/** Horizontal offset from the player to something, in metres. */
interface Offset {
  dx: number;
  dz: number;
  dist: number;
}

/** Horizontal offset from the player to `to`, rounded to the decimetre. */
const offset = (from: Vector3, to: Vector3): Offset => {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return {
    dist: Math.round(Math.hypot(dx, dz) * 10) / 10,
    dx: Math.round(dx * 10) / 10,
    dz: Math.round(dz * 10) / 10,
  };
};

const nearestOf = (from: Vector3, points: readonly Vector3[]): Vector3 | null => {
  let best: Vector3 | null = null;
  let bestD = Infinity;
  for (const point of points) {
    const d = point.distanceTo(from);
    if (d < bestD) {
      bestD = d;
      best = point;
    }
  }
  return best;
};

export const installPlaytest = (game: SaltlineGame, squadSize: () => number): void => {
  let frame = 0;
  const tick = (): void => {
    frame += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  publishDiagnostics(() => {
    const { player, game: flow, enemies, level } = game;
    const { run } = flow;
    const liveRelays = run.relays.filter((r) => !r.cut).map((r) => r.o.pos);
    const relay = nearestOf(player.pos, liveRelays);
    const enemy = nearestOf(
      player.pos,
      enemies.list.filter((e) => e.alive).map((e) => e.pos),
    );
    const boat = run.allCut ? (level.extraction?.pos ?? null) : null;
    return {
      complete: flow.state === "complete",
      enemiesAlive: enemies.list.filter((e) => e.alive).length,
      frame,
      health: Math.round(player.health),
      mode: run.mode,
      nearestEnemy: enemy ? offset(player.pos, enemy) : null,
      nearestRelay: relay ? offset(player.pos, relay) : null,
      player: {
        x: Math.round(player.pos.x * 100) / 100,
        y: Math.round(player.pos.y * 100) / 100,
        yaw: Math.round(player.yaw * 100) / 100,
        z: Math.round(player.pos.z * 100) / 100,
      },
      relaysLeft: liveRelays.length,
      score: Math.round(run.score),
      squad: squadSize(),
      state: flow.state,
      toBoat: boat ? offset(player.pos, boat) : null,
      wave: run.wave,
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
      cut: {
        description: "Hold to cut the relay you stand at (nearestRelay.dist under 2)",
        keys: ["KeyE"],
      },
      fire: { description: "Fire the rifle where the camera faces", keys: ["Enter"] },
      reload: { description: "Reload the rifle", keys: ["KeyR"] },
    },
    goal: "First-person shooter on a rainy container dock. Cut the three uplink relays (nearestRelay is the offset to the closest one, in metres), then reach the boat (toBoat). Drones and robot hounds hunt you (nearestEnemy); turn to face them and fire. Health regenerates out of fire.",
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
