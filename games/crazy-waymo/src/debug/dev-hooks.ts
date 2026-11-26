import * as THREE from "three";

import type { PerfGovernor } from "../render/perf-governor";
import type { GameScene } from "../scenes/game-scene";
import { isMesh } from "../shared/three-guards";

export interface TaxiDebugApi {
  readonly game: GameScene;
  readonly camera: THREE.PerspectiveCamera;
  setFreecam: (on: boolean) => void;
  lookFrom: (x: number, y: number, z: number, tx: number, ty: number, tz: number) => void;
  teleport: (u: number, v: number, yaw?: number) => void;
  probe: () => {
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
  setTime: (seconds: number) => void;
  tier: () => number;
  setPhase: (p: number) => void;
  nearestCone: () => { u: number; v: number } | null;
  smashCone: () => boolean;
  pick: (
    nx: number,
    ny: number,
  ) => {
    name: string;
    chain: string;
    point: number[];
    color: string | null;
    verts: number;
    bbox: number[] | null;
  } | null;
}

declare global {
  interface Window {
    __taxi?: TaxiDebugApi;
  }
}

export const installDevHooks = (game: GameScene, governor: PerfGovernor) => {
  window.__taxi = {
    camera: game.camera,
    game,
    lookFrom(x: number, y: number, z: number, tx: number, ty: number, tz: number) {
      game.freecam = true;
      game.camera.position.set(x, y, z);
      game.camera.lookAt(tx, ty, tz);
    },
    nearestCone() {
      return game.debugNearestCone();
    },
    pick(nx: number, ny: number) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(nx, ny), game.camera);
      const [hit] = ray.intersectObjects(game.scene.children, true);

      if (!hit) {
        return null;
      }

      const chain: string[] = [];
      let o: THREE.Object3D | null = hit.object;

      while (o) {
        chain.push(`${o.name || o.type}@${o.scale.x.toFixed(2)}`);
        o = o.parent;
      }

      const mesh = isMesh(hit.object) ? hit.object : null;

      const mat =
        mesh && mesh.material instanceof THREE.MeshStandardMaterial ? mesh.material : null;

      const geo = mesh ? mesh.geometry : null;

      if (geo && !geo.boundingBox) {
        geo.computeBoundingBox();
      }

      const bb = geo?.boundingBox ?? null;

      return {
        bbox: bb
          ? [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].map(
              (v) => Math.round(v * 10) / 10,
            )
          : null,
        chain: chain.join(" < "),
        color: mat ? `#${mat.color.getHexString()}` : null,
        name: hit.object.name || hit.object.type,
        point: [hit.point.x, hit.point.y, hit.point.z].map((v) => Math.round(v * 10) / 10),
        verts: geo ? geo.getAttribute("position").count : 0,
      };
    },
    probe() {
      return game.debugProbe();
    },
    setFreecam(on: boolean) {
      game.freecam = on;
    },
    setPhase(p: number) {
      game.debugSetDayPhase(p);
    },
    setTime(seconds: number) {
      game.debugSetTime(seconds);
    },
    smashCone() {
      return game.debugSmashNearestCone();
    },
    teleport(u: number, v: number, yaw = 0) {
      game.debugTeleport(u, v, yaw);
    },
    tier() {
      return governor.currentTier;
    },
  };
};
