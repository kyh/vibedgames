export type Season = "spring" | "summer" | "fall" | "winter";

export const SEASONS: readonly Season[] = ["spring", "summer", "fall", "winter"] as const;
export const DAYS_PER_SEASON = 28;

export const seasonOfDay = (day: number) => {
  const idx = Math.floor((day - 1) / DAYS_PER_SEASON) % SEASONS.length;

  return SEASONS[idx] ?? "spring";
};

export const seasonName = (s: Season) => s.charAt(0).toUpperCase() + s.slice(1);

export const seasonIcon = (s: Season) =>
  ({ fall: "🍂", spring: "🌷", summer: "☀", winter: "❄" })[s];
