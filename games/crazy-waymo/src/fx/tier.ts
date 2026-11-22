export const TIER_COLORS = ["#4fc3ff", "#ff9d2e", "#c05cff"] as const;

/** Grind sparks below tier 1 — the uncharged scrape, never a "reward" hue. */
export const GRIND_COLOR = "#ffd75e";

export const tierColor = (tier: 0 | 1 | 2) => {
  if (tier === 0) {
    return GRIND_COLOR;
  }

  return tier === 1 ? TIER_COLORS[0] : TIER_COLORS[1];
};
