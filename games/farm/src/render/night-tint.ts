import { Math as PhaserMath } from "phaser";

import { DAY_START_MIN } from "../config";
import { isWet } from "../systems/weather";
import type { Weather } from "../systems/weather";

export interface NightTint {
  color: number;
  alpha: number;
}

const WEATHER_DARKEN: Record<Weather, number> = { rain: 0.12, snow: 0.08, storm: 0.22, sunny: 0 };

const lerp = (a: number, b: number, t: number): number => a + (b - a) * PhaserMath.Clamp(t, 0, 1);

const baseTint = (timeMin: number): NightTint => {
  if (timeMin < 9 * 60) {
    return { alpha: lerp(0.16, 0, (timeMin - DAY_START_MIN) / (3 * 60)), color: 0xff_e2_a8 };
  }
  if (timeMin < 17 * 60) {
    return { alpha: 0, color: 0xff_ff_ff };
  }
  if (timeMin < 20 * 60) {
    return { alpha: lerp(0, 0.26, (timeMin - 17 * 60) / (3 * 60)), color: 0xff_8a_3a };
  }
  if (timeMin < 24 * 60) {
    return { alpha: lerp(0.28, 0.52, (timeMin - 20 * 60) / (4 * 60)), color: 0x14_22_4a };
  }
  return { alpha: lerp(0.52, 0.64, (timeMin - 24 * 60) / (2 * 60)), color: 0x0a_12_30 };
};

/** Full-screen overlay for the time of day; weather darkens the day a touch. */
export const tintFor = (timeMin: number, weather: Weather): NightTint => {
  const wx = WEATHER_DARKEN[weather];
  const wcol = isWet(weather) ? 0x2a_35_50 : 0x9f_b6_d8;
  const base = baseTint(timeMin);
  if (wx > 0 && base.alpha < wx) {
    return { alpha: wx, color: base.alpha > 0.1 ? base.color : wcol };
  }
  return base;
};
