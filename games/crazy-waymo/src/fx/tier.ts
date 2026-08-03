// Drift-tier visual ladder, shared by spark FX, skid scorch and the HUD so
// the three surfaces can never disagree about what a tier looks like. The
// ladder is the Mario-Kart-family escalation (blue → orange → violet):
// `Car.driftTier` 1 → blue, 2 → orange; violet is reserved for the
// boost-release / promotion moment, not a holdable state.
export const TIER_COLORS = ["#4fc3ff", "#ff9d2e", "#c05cff"] as const;

/** Grind sparks below tier 1 — the uncharged scrape, never a "reward" hue. */
export const GRIND_COLOR = "#ffd75e";

export function tierColor(tier: 0 | 1 | 2): string {
  return tier === 0 ? GRIND_COLOR : tier === 1 ? TIER_COLORS[0] : TIER_COLORS[1];
}
