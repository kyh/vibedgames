// DEV-only hooks for headless inspection (freecam + teleport), driven from
// Playwright via `window.__taxi`. main.ts only imports this module when
// import.meta.env.DEV is true, so none of it reaches production builds.
import type * as THREE from "three";

import type { GameScene } from "../scenes/game-scene";

export type TaxiDebugApi = {
  readonly game: GameScene;
  readonly camera: THREE.PerspectiveCamera;
  setFreecam(on: boolean): void;
  // Park the camera at (x,y,z) looking at (tx,ty,tz); implies freecam.
  lookFrom(x: number, y: number, z: number, tx: number, ty: number, tz: number): void;
  // Drop the taxi at normalized map coords (u,v in 0..1) facing `yaw`.
  teleport(u: number, v: number, yaw?: number): void;
  // Live car probe for headless verification.
  probe(): {
    x: number;
    z: number;
    y: number;
    speed: number;
    heading: number;
    airborne: boolean;
    drifting: boolean;
    boosting: boolean;
    carrying: boolean;
    objective: { u: number; v: number } | null;
    wreckedCount: number;
    nearestTraffic: { dist: number; wrecked: boolean; y: number } | null;
  } | null;
  // Force the run clock (endgame testing).
  setTime(seconds: number): void;
  // Nearest resting cone (verification).
  nearestCone(): { u: number; v: number } | null;
  // Launch the nearest resting cone through the physics path (verification).
  smashCone(): boolean;
};

declare global {
  interface Window {
    __taxi?: TaxiDebugApi;
  }
}

export function installDevHooks(game: GameScene): void {
  window.__taxi = {
    game,
    camera: game.camera,
    setFreecam(on: boolean): void {
      game.freecam = on;
    },
    lookFrom(x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
      game.freecam = true;
      game.camera.position.set(x, y, z);
      game.camera.lookAt(tx, ty, tz);
    },
    teleport(u: number, v: number, yaw = 0): void {
      game.debugTeleport(u, v, yaw);
    },
    probe() {
      return game.debugProbe();
    },
    setTime(seconds: number): void {
      game.debugSetTime(seconds);
    },
    nearestCone() {
      return game.debugNearestCone();
    },
    smashCone(): boolean {
      return game.debugSmashNearestCone();
    },
  };
}
