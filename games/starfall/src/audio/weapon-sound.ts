import type { WeaponSfx } from "../shared/constants";
import type { SfxName } from "./sfx";

/** Fire sound per weapon family: which synth plays, at what gain and pitch. */

export interface WeaponSoundSpec {
  name: SfxName;
  gain: number;
  rate?: number;
}

export const weaponSound: (kind: WeaponSfx) => WeaponSoundSpec = (kind) => {
  switch (kind) {
    case "pulse": {
      return { gain: 1, name: "fire_pulse" };
    }

    case "rapid": {
      return { gain: 0.6, name: "fire_pulse" };
    }

    case "heavy": {
      return { gain: 1, name: "fire_heavy" };
    }

    case "zap": {
      return { gain: 1, name: "fire_laser" };
    }

    case "boom": {
      return { gain: 0.7, name: "fire_heavy" };
    }

    case "scatter": {
      return { gain: 1, name: "fire_scatter" };
    }

    case "seek": {
      return { gain: 0.55, name: "fire_laser" };
    }

    case "arc": {
      return { gain: 1, name: "arc_zap" };
    }

    case "glaive": {
      return { gain: 0.8, name: "fire_heavy" };
    }

    case "rail": {
      return { gain: 1, name: "rail" };
    }

    case "mine": {
      return { gain: 0.5, name: "fire_pulse", rate: 0.7 };
    }

    case "nova": {
      return { gain: 0.8, name: "fire_heavy", rate: 0.85 };
    }

    case "drill": {
      return { gain: 1.1, name: "fire_heavy", rate: 0.55 };
    }

    case "plasma": {
      return { gain: 0.4, name: "fire_pulse", rate: 1.45 };
    }

    case "tesla": {
      return { gain: 0.7, name: "arc_zap", rate: 1.4 };
    }

    case "sentry": {
      return { gain: 0.7, name: "fire_pulse", rate: 1.1 };
    }

    case "singularity": {
      return { gain: 0.8, name: "fire_laser", rate: 0.6 };
    }

    default: {
      return kind satisfies never;
    }
  }
};
