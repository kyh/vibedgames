/** Versioned local challenge. Existing course functions consume this seed unchanged. */
export const CHALLENGE_SEED = 146039;
export const CHALLENGE_NAME = "Canopy Trail · v1";
export const CHALLENGE_GOAL = 10;
export const CHALLENGE_BEST_KEY = "flappy-route:canopy-v1:best";

export type RouteProgress = { readonly gates: number; readonly lastIndex: number };
export type FlightMode =
  | { readonly kind: "normal" }
  | { readonly kind: "challenge"; readonly progress: RouteProgress };

export function freshRouteProgress(): RouteProgress {
  return { gates: 0, lastIndex: -1 };
}

/** Receives an actual passed gate, never a coin or a guessed scroll distance. */
export function passRouteGate(progress: RouteProgress, index: number): RouteProgress {
  if (!Number.isSafeInteger(index) || index < 0 || index <= progress.lastIndex) return progress;
  return { gates: progress.gates + 1, lastIndex: index };
}

export function routeBestFromStorage(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 0;
  const score = Number(raw);
  return Number.isSafeInteger(score) && score >= 0 ? score : 0;
}

export function routeLocation(gates: number): string {
  if (gates < 3) return "Twin Grove";
  if (gates < 7) return "Old Canopy";
  return "Sunlit Boughs";
}
