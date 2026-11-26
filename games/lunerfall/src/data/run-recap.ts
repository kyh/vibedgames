import { HERO_NAMES } from "./animations";
import type { HeroName } from "./animations";

type Reached = Readonly<{ hero: HeroName; biome: number; depth: number; gold: number }>;

/** A guest snapshot does not contain score or banking results. Keep that
 * distinction in the value carried to the hub, rather than inventing zeroes. */
export type RunRecap =
  | (Reached &
      Readonly<{
        kind: "banked";
        score: number;
        shardsEarned: number;
        bestScore: number;
      }>)
  | (Reached & Readonly<{ kind: "coop-guest" }>);

const whole = (value: unknown, minimum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

export type RecapCandidate = Partial<{
  kind: unknown;
  hero: unknown;
  biome: unknown;
  depth: unknown;
  gold: unknown;
  score: unknown;
  shardsEarned: unknown;
  bestScore: unknown;
}>;

/** Scene data is untyped: an object that might hold a recap. */
export const isRecapCandidate = (value: unknown): value is RecapCandidate =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Scene data is untyped and may survive an earlier Scene.start. Validate the
 * explicit recap value and copy primitives; never retain the caller's object. */
export const readRunRecap: (value: RecapCandidate) => RunRecap | null = (value) => {
  const hero = HERO_NAMES.find((name) => name === value.hero);

  if (!hero || !whole(value.biome, 1) || !whole(value.depth, 1) || !whole(value.gold, 0)) {
    return null;
  }

  const reached = { biome: value.biome, depth: value.depth, gold: value.gold, hero };

  if (value.kind === "coop-guest") {
    return { kind: "coop-guest", ...reached };
  }

  if (
    value.kind !== "banked" ||
    !whole(value.score, 0) ||
    !whole(value.shardsEarned, 0) ||
    !whole(value.bestScore, value.score)
  ) {
    return null;
  }

  return {
    kind: "banked",
    ...reached,
    bestScore: value.bestScore,
    score: value.score,
    shardsEarned: value.shardsEarned,
  };
};
