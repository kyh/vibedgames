import { z } from "zod";

import { MAX_PURCHASE_USD, MIN_PURCHASE_USD } from "./credits-limits";

// Matched trimmed and upper-cased, so any spelling a person might paste is
// accepted here and judged by the lookup.
export const redeemInput = z.object({ code: z.string().trim().toUpperCase().min(1).max(64) });

export const checkoutInput = z.object({
  amountUsd: z
    .number()
    .int("amount must be whole dollars")
    .min(MIN_PURCHASE_USD)
    .max(MAX_PURCHASE_USD)
    .describe(
      `Whole dollars of credit to buy, ${MIN_PURCHASE_USD}–${MAX_PURCHASE_USD}. One dollar paid is one dollar of credit.`,
    ),
});
