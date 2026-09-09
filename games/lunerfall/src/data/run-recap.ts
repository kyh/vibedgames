import { HERO_NAMES } from "./animations";
import type { HeroName } from "./animations";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This module is the parser for untyped Phaser scene-entry data. */

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

function whole(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** Scene data is untyped and may survive an earlier Scene.start. Validate the
 * explicit recap value and copy primitives; never retain the caller's object. */
export function readRunRecap(value: unknown): RunRecap | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("kind" in value) ||
    !("hero" in value) ||
    !("biome" in value) ||
    !("depth" in value) ||
    !("gold" in value)
  ) {
    return null;
  }
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
    !("score" in value) ||
    !("shardsEarned" in value) ||
    !("bestScore" in value) ||
    !whole(value.score, 0) ||
    !whole(value.shardsEarned, 0) ||
    !whole(value.bestScore, value.score)
  ) {
    return null;
  }
  return {
    kind: "banked",
    ...reached,
    score: value.score,
    shardsEarned: value.shardsEarned,
    bestScore: value.bestScore,
  };
}
