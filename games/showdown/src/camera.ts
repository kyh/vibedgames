import type { Brawler } from "./entities/brawler";
import type { Game } from "./game";
import { clamp, damp, smoothstep } from "./utils";

export const CAMERA_FOV = 32;
const CAMERA_PITCH = (50 * Math.PI) / 180;
const CAMERA_DISTANCE = 22;

const aspectFit = (aspect: number) => clamp(1.55 / aspect, 1, 1.75);

const orbitMenu = (game: Game, dt: number, fit: number) => {
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

const cameraSubject = (game: Game) => {
  if (game.player?.alive === true) {
    return game.player;
  }

  if (game.spectate?.alive === true) {
    return game.spectate;
  }

  return game.brawlers.find((b) => b.alive);
};

const followSubject = (game: Game, subject: Brawler, dt: number) => {
  let { x, z } = subject;

  if (subject === game.player && game.state === "playing") {
    game.leanX = damp(game.leanX, clamp(game.aimPoint.x - subject.x, -8, 8) * 0.09, 2.2, dt);
    game.leanZ = damp(game.leanZ, clamp(game.aimPoint.z - subject.z, -8, 8) * 0.09, 2.2, dt);
    x += game.leanX;
    z += game.leanZ;
  }

  x = clamp(x, -18, 18);
  z = clamp(z, -18.5, 18.5);
  game.focus.x = damp(game.focus.x, x, 5.5, dt);
  game.focus.z = damp(game.focus.z, z, 5.5, dt);
  game.focus.y = damp(game.focus.y, game.world.heightAt(subject.x, subject.z), 5.5, dt);
};

const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const updateCamera = (game: Game, dt: number) => {
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
  const amp = REDUCED_MOTION ? 0 : game.shakeAmp;
  const t = game.elapsed;
  const shakeX = Math.sin(t * 43) * amp * 0.3;
  const shakeZ = Math.cos(t * 37 + 1.3) * amp * 0.22;
  camera.position.set(
    game.focus.x + shakeX,
    game.focus.y + Math.sin(CAMERA_PITCH) * distance,
    game.focus.z + Math.cos(CAMERA_PITCH) * distance + shakeZ,
  );
  camera.lookAt(game.focus.x + shakeX, game.focus.y, game.focus.z + shakeZ);
};
