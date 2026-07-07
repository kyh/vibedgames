// Calendar: days roll up into 28-day seasons that cycle Spring→Summer→Fall→Winter.

export type Season = "spring" | "summer" | "fall" | "winter";

export const SEASONS: readonly Season[] = ["spring", "summer", "fall", "winter"] as const;
export const DAYS_PER_SEASON = 28;

// day is 1-indexed (Day 1 = spring, day 1).
export function seasonOfDay(day: number): Season {
  const idx = Math.floor((day - 1) / DAYS_PER_SEASON) % SEASONS.length;
  return SEASONS[idx] ?? "spring";
}

export function seasonName(s: Season): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function seasonIcon(s: Season): string {
  return { spring: "🌷", summer: "☀", fall: "🍂", winter: "❄" }[s];
}
