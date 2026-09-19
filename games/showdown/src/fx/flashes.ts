// Short-lived point lights (muzzle flashes, explosions). Each flash asks the
// lighting pool for a light every frame while it lasts, fading quadratically,
// so the pool decides which of them actually get a real light this frame.
import type * as THREE from "three";
import type { Lighting } from "../render/lighting";
import { clamp } from "../utils";

interface Flash {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  intensity: number;
  distance: number;
  t: number;
  T: number;
}

export class FlashList {
  private flashes: Flash[] = [];

  add(
    x: number,
    y: number,
    z: number,
    color: THREE.Color,
    intensity: number,
    distance: number,
    duration: number,
  ): void {
    this.flashes.push({ T: duration, color, distance, intensity, t: 0, x, y, z });
  }

  update(dt: number, lighting: Lighting): void {
    for (const flash of this.flashes) {
      flash.t += dt;
      const fade = 1 - clamp(flash.t / flash.T, 0, 1);
      lighting.addLight(
        flash.x,
        flash.y,
        flash.z,
        flash.color,
        flash.intensity * fade * fade,
        flash.distance,
      );
    }
    this.flashes = this.flashes.filter((flash) => flash.t < flash.T);
  }
}
