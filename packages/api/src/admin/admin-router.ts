import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  grantCredits,
  listBalances,
  SIGNUP_GRANT_MICRO,
  usdToMicro,
} from "../credits/credit-ledger";
import { adminProcedure } from "../orpc";

/**
 * Admin user management. Wraps better-auth's admin plugin endpoints so the
 * web app can list / create users without exposing the full admin API
 * surface to the client. The plugin endpoints re-verify the admin role from
 * the forwarded session headers, on top of our `adminProcedure` check.
 */
export const adminRouter = {
  credits: {
    /**
     * Balances keyed by userId for the admin roster. Users who have never
     * touched credits have no ledger rows yet; the UI shows those at
     * `signupGrantMicro` (the grant materializes on their first use).
     */
    balances: adminProcedure.handler(async ({ context }) => ({
      balances: await listBalances(context.db),
      signupGrantMicro: SIGNUP_GRANT_MICRO,
    })),

    grant: adminProcedure
      .input(
        z.object({
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
        }),
      )
      .handler(async ({ context, input }) => {
        const balanceMicro = await grantCredits(context.db, {
          amountMicro: usdToMicro(input.amountUsd),
          createdBy: context.session.user.id,
          key: input.key,
          note: input.note ?? null,
          userId: input.userId,
        });
        return { balanceMicro };
      }),
  },

  users: {
    create: adminProcedure
      .input(
        z.object({
          email: z.email(),
          name: z.string().min(1).max(100),
          password: z.string().min(8),
          role: z.enum(["user", "admin"]).default("user"),
        }),
      )
      .handler(async ({ context, input }) => {
        try {
          const result = await context.auth.api.createUser({
            body: {
              email: input.email,
              name: input.name,
              password: input.password,
              role: input.role,
            },
            headers: context.headers,
          });
          return result;
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Failed to create user",
          });
        }
      }),

    list: adminProcedure.handler(async ({ context }) => {
      const result = await context.auth.api.listUsers({
        headers: context.headers,
        query: { limit: 100, sortBy: "createdAt", sortDirection: "desc" },
      });
      return result;
    }),
  },
};
