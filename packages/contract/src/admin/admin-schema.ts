import { z } from "zod";

// The ledger records whole micro-USD, converting with the service's
// `usdToMicro`: `Math.round(usd * 1_000_000)`.
const MICRO_PER_USD = 1_000_000;

export const grantCreditsInput = z.object({
  // Signed dollars: positive tops up, negative claws back a
  // mistaken grant. Bounded to catch fat-fingered amounts. An amount that
  // rounds to no micro-USD would record a grant of nothing.
  amountUsd: z
    .number()
    .refine(
      (n) => Math.round(n * MICRO_PER_USD) !== 0,
      "amount must be at least one micro-USD ($0.000001) either way",
    )
    .gte(-1000)
    .lte(1000),
  // Client-minted idempotency key: a retried/double-submitted
  // request grants once, not twice.
  key: z.uuid(),
  note: z.string().max(500).optional(),
  userId: z.string().min(1),
});

export const createUserInput = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(8),
  role: z.enum(["user", "admin"]).default("user"),
});
