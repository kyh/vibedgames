import { seasonOfDay } from "../data/calendar";
import type { Season } from "../data/calendar";

export type Weather = "sunny" | "rain" | "storm" | "snow";

export const WEATHER_NAME = {
  rain: "Rainy",
  snow: "Snowy",
  storm: "Stormy",
  sunny: "Clear",
} satisfies Record<Weather, string>;

export const WEATHER_ICON = {
  rain: "🌧",
  snow: "❄",
  storm: "⛈",
  sunny: "☀",
} satisfies Record<Weather, string>;

/* oxlint-disable no-bitwise -- mulberry32-style mixing: the uint32 wraps and xor-shifts ARE the algorithm */
const hash = (seed: number, day: number): number => {
  let t = (seed ^ (day * 0x9e_37_79_b1)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
/* oxlint-enable no-bitwise */

// Cumulative odds per season: the first band the roll falls under wins, else clear.
const SEASON_BANDS: Record<Season, readonly (readonly [number, Weather])[]> = {
  fall: [
    [0.32, "rain"],
    [0.42, "storm"],
  ],
  spring: [
    [0.3, "rain"],
    [0.37, "storm"],
  ],
  summer: [
    [0.12, "rain"],
    [0.2, "storm"],
  ],
  winter: [[0.5, "snow"]],
};

// Deterministic weather for a given farm seed + day. Day 1 is always clear.
export const weatherForDay = (seed: number, day: number): Weather => {
  if (day <= 1) {
    return "sunny";
  }
  const r = hash(seed, day);
  for (const [chance, weather] of SEASON_BANDS[seasonOfDay(day)]) {
    if (r < chance) {
      return weather;
    }
  }
  return "sunny";
};

export const isWet = (w: Weather): boolean => w === "rain" || w === "storm";
