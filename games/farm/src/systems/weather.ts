import { seasonOfDay } from "../data/calendar";

export type Weather = "sunny" | "rain" | "storm" | "snow";

export const WEATHER_NAME: Record<Weather, string> = {
  sunny: "Clear",
  rain: "Rainy",
  storm: "Stormy",
  snow: "Snowy",
};

export const WEATHER_ICON: Record<Weather, string> = {
  sunny: "☀",
  rain: "🌧",
  storm: "⛈",
  snow: "❄",
};

function hash(seed: number, day: number): number {
  let t = (seed ^ (day * 0x9e3779b1)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Deterministic weather for a given farm seed + day. Day 1 is always clear.
export function weatherForDay(seed: number, day: number): Weather {
  if (day <= 1) return "sunny";
  const season = seasonOfDay(day);
  const r = hash(seed, day);
  switch (season) {
    case "winter":
      return r < 0.5 ? "snow" : "sunny";
    case "spring":
      return r < 0.3 ? "rain" : r < 0.37 ? "storm" : "sunny";
    case "summer":
      return r < 0.12 ? "rain" : r < 0.2 ? "storm" : "sunny";
    case "fall":
      return r < 0.32 ? "rain" : r < 0.42 ? "storm" : "sunny";
  }
}

export function isWet(w: Weather): boolean {
  return w === "rain" || w === "storm";
}
