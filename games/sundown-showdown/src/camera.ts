// Camera rig: a slow orbit over the arena on the menu, and in a match a
// fixed-pitch chase view that leans toward the cursor, pulls back during the
// countdown and shakes with nearby hits.

import type { Brawler } from "./entities/brawler";
import type { Game } from "./game";
import { clamp, damp, smoothstep } from "./utils";

export const CAMERA_FOV = 32;
/** Pitch of the match camera above the ground plane. */
export const CAMERA_PITCH = (56 * Math.PI) / 180;
/** Base distance from the focus point at zoom 1 on a wide screen. */
export const CAMERA_DISTANCE = 23;

/** Portrait and square screens need the camera further out to keep the same width in view. */
const aspectFit = (aspect: number): number => clamp(1.55 / aspect, 1, 1.75);

const orbitMenu = (game: Game, dt: number, fit: number): void => {
  game.menuAngle += dt * 0.05;
  const radius = 27 * fit;
  game.focus.set(0, 0, -1);
  game.camera.position.set(
    Math.sin(game.menuAngle) * radius * 0.55,
    30 * fit,
    9 + Math.cos(game.menuAngle) * radius * 0.62,
  );
  game.camera.lookAt(game.focus);
};

/** Who the camera follows: the player, then whoever took them out, then anyone alive. */
const cameraSubject = (game: Game): Brawler | undefined => {
  if (game.player?.alive) {
    return game.player;
  }
  if (game.spectate?.alive) {
    return game.spectate;
  }
  return game.brawlers.find((b) => b.alive);
};

const followSubject = (game: Game, subject: Brawler, dt: number): void => {
  let { x, z } = subject;
  if (subject === game.player && game.state === "playing") {
    game.leanX = damp(game.leanX, clamp(game.aimPoint.x - subject.x, -8, 8) * 0.09, 2.2, dt);
    game.leanZ = damp(game.leanZ, clamp(game.aimPoint.z - subject.z, -8, 8) * 0.09, 2.2, dt);
    x += game.leanX;
    z += game.leanZ;
  }
  x = clamp(x, -14, 14);
  z = clamp(z, -15, 17);
  game.focus.x = damp(game.focus.x, x, 5.5, dt);
  game.focus.z = damp(game.focus.z, z, 5.5, dt);
};

export const updateCamera = (game: Game, dt: number): void => {
  const { camera } = game;
  const fit = aspectFit(camera.aspect);
  if (game.state === "menu") {
    orbitMenu(game, dt, fit);
    return;
  }
  const subject = cameraSubject(game);
  if (subject) {
    followSubject(game, subject, dt);
  }
  const pullBack = game.state === "countdown" ? smoothstep(0.4, 3.2, game.countdownT) : 0;
  const distance = CAMERA_DISTANCE * fit * game.camZoom * (1 + pullBack * 0.75);
  game.shakeAmp = damp(game.shakeAmp, 0, 9, dt);
  const amp = game.shakeAmp;
  const t = game.elapsed;
  const shakeX = Math.sin(t * 43) * amp * 0.3;
  const shakeZ = Math.cos(t * 37 + 1.3) * amp * 0.22;
  camera.position.set(
    game.focus.x + shakeX,
    Math.sin(CAMERA_PITCH) * distance,
    game.focus.z + Math.cos(CAMERA_PITCH) * distance + shakeZ,
  );
  camera.lookAt(game.focus.x + shakeX, 0, game.focus.z + shakeZ);
};
