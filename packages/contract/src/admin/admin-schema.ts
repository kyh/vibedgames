import { z } from "zod";

const MICRO_PER_USD = 1_000_000;

export const grantCreditsInput = z.object({
  amountUsd: z
    .number()
    .refine(
      (n) => Math.round(n * MICRO_PER_USD) !== 0,
      "amount must be at least one micro-USD ($0.000001) either way",
    )
    .gte(-1000)
    .lte(1000),
  key: z.uuid(),
  note: z.string().max(500).optional(),
  userId: z.string().min(1),
});

export const createUserInput = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(100),
  role: z.enum(["user", "admin"]).default("user"),
});
