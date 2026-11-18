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
  private readonly flashes: Flash[] = [];

  add(
    x: number,
    y: number,
    z: number,
    color: THREE.Color,
    intensity: number,
    distance: number,
    duration: number,
  ) {
    this.flashes.push({ T: duration, color, distance, intensity, t: 0, x, y, z });
  }

  update(dt: number, lighting: Lighting) {
    const { flashes } = this;
    let kept = 0;

    for (const flash of flashes) {
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

      if (flash.t < flash.T) {
        flashes[kept] = flash;
        kept += 1;
      }
    }

    flashes.length = kept;
  }
}
