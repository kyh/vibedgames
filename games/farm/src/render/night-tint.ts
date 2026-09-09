import Phaser from "phaser";

import { DAY_START_MIN } from "../config";
import { isWet, type Weather } from "../systems/weather";

export type NightTint = { color: number; alpha: number };

/** Full-screen overlay for the time of day; weather darkens the day a touch. */
export function tintFor(timeMin: number, weather: Weather): NightTint {
  const lerp = (a: number, b: number, t: number) => a + (b - a) * Phaser.Math.Clamp(t, 0, 1);
  const wx = weather === "storm" ? 0.22 : weather === "rain" ? 0.12 : weather === "snow" ? 0.08 : 0;
  const wcol = isWet(weather) ? 0x2a3550 : 0x9fb6d8;
  let base: NightTint;
  if (timeMin < 9 * 60)
    base = { color: 0xffe2a8, alpha: lerp(0.16, 0, (timeMin - DAY_START_MIN) / (3 * 60)) };
  else if (timeMin < 17 * 60) base = { color: 0xffffff, alpha: 0 };
  else if (timeMin < 20 * 60)
    base = { color: 0xff8a3a, alpha: lerp(0, 0.26, (timeMin - 17 * 60) / (3 * 60)) };
  else if (timeMin < 24 * 60)
    base = { color: 0x14224a, alpha: lerp(0.28, 0.52, (timeMin - 20 * 60) / (4 * 60)) };
  else base = { color: 0x0a1230, alpha: lerp(0.52, 0.64, (timeMin - 24 * 60) / (2 * 60)) };
  if (wx > 0 && base.alpha < wx) return { color: base.alpha > 0.1 ? base.color : wcol, alpha: wx };
  return base;
}
