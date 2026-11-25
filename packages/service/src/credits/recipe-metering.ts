import type { Db } from "@repo/db/drizzle-client";
import type { RecipeName } from "@repo/contract/asset/recipe-schema";
import {
  RECIPE_FLOOR_MICRO,
  RECIPE_IMAGES,
  RECIPES,
  recipeHoldMicro,
} from "@repo/contract/asset/recipe-schema";
import { generation } from "@repo/db/drizzle-schema";
import { and, eq, gt, like, lt, sql } from "drizzle-orm";

import { holdGeneration, MICRO_PER_USD, settleGeneration } from "./credit-ledger";

export { releaseGeneration as releaseRecipe } from "./credit-ledger";

const ENDPOINT_PREFIX = "vibedgames/recipe/";

const rateOf = (name: RecipeName) => RECIPE_IMAGES[RECIPES[name].image].microUsdPerSecond;

/** Debits a recipe job's hold: its time cap at the image's rate, clamped to $0.01–$1. */
export const holdRecipe = (db: Db, input: { userId: string; jobId: string; recipe: RecipeName }) =>
  holdGeneration(db, {
    endpointId: `${ENDPOINT_PREFIX}${input.recipe}`,
    holdMicro: recipeHoldMicro(input.recipe),
    requestId: input.jobId,
    unit: "seconds",
    unitPriceMicro: rateOf(input.recipe),
    userId: input.userId,
  });

/** Settles a finished job to the seconds it ran, at least the $0.01 floor; returns the charge in USD. */
export const settleRecipe = async (db: Db, jobId: string, recipe: RecipeName, seconds: number) => {
  const rate = rateOf(recipe);
  const units = Math.max(seconds, RECIPE_FLOOR_MICRO / rate);
  await settleGeneration(db, jobId, units);

  return Math.ceil(units * rate) / MICRO_PER_USD;
};

/** How many of an account's recipe jobs still hold credit from the last ten minutes. */
export const runningRecipeJobs = async (db: Db, userId: string) => {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(generation)
    .where(
      and(
        eq(generation.userId, userId),
        eq(generation.status, "held"),
        like(generation.endpointId, `${ENDPOINT_PREFIX}%`),
        gt(generation.createdAt, new Date(Date.now() - 10 * 60 * 1000)),
      ),
    );

  return rows[0]?.count ?? 0;
};

/** An account's recipe jobs still holding credit after ten minutes: done or failed jobs nobody followed. */
export const staleRecipeJobs = async (db: Db, userId: string) => {
  const rows = await db
    .select({ jobId: generation.requestId })
    .from(generation)
    .where(
      and(
        eq(generation.userId, userId),
        eq(generation.status, "held"),
        like(generation.endpointId, `${ENDPOINT_PREFIX}%`),
        lt(generation.createdAt, new Date(Date.now() - 10 * 60 * 1000)),
      ),
    )
    .limit(4);

  return rows.map((row) => row.jobId);
};
