import { z } from "zod";

export const grantCreditsInput = z.object({
  // Signed dollars: positive tops up, negative claws back a
  // mistaken grant. Bounded to catch fat-fingered amounts.
  amountUsd: z
    .number()
    .refine((n) => n !== 0, "amount must be non-zero")
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
  name: z.string().min(1).max(100),
  password: z.string().min(8),
  role: z.enum(["user", "admin"]).default("user"),
});
