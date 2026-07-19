import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  grantCredits,
  listBalances,
  SIGNUP_GRANT_MICRO,
  usdToMicro,
} from "../credits/credit-ledger";
import { adminProcedure, createTRPCRouter } from "../trpc";

/**
 * Admin user management. Wraps better-auth's admin plugin endpoints so the
 * web app can list / create users without exposing the full admin API
 * surface to the client. The plugin endpoints re-verify the admin role from
 * the forwarded session headers, on top of our `adminProcedure` check.
 */
export const adminRouter = createTRPCRouter({
  users: createTRPCRouter({
    list: adminProcedure.query(async ({ ctx }) => {
      const result = await ctx.auth.api.listUsers({
        query: { limit: 100, sortBy: "createdAt", sortDirection: "desc" },
        headers: ctx.headers,
      });
      return result;
    }),

    create: adminProcedure
      .input(
        z.object({
          email: z.email(),
          password: z.string().min(8),
          name: z.string().min(1).max(100),
          role: z.enum(["user", "admin"]).default("user"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          const result = await ctx.auth.api.createUser({
            body: {
              email: input.email,
              password: input.password,
              name: input.name,
              role: input.role,
            },
            headers: ctx.headers,
          });
          return result;
        } catch (err) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: err instanceof Error ? err.message : "Failed to create user",
          });
        }
      }),
  }),

  credits: createTRPCRouter({
    /**
     * Balances keyed by userId for the admin roster. Users who have never
     * touched credits have no ledger rows yet; the UI shows those at
     * `signupGrantMicro` (the grant materializes on their first use).
     */
    balances: adminProcedure.query(async ({ ctx }) => {
      return {
        signupGrantMicro: SIGNUP_GRANT_MICRO,
        balances: await listBalances(ctx.db),
      };
    }),

    grant: adminProcedure
      .input(
        z.object({
          userId: z.string().min(1),
          // Signed dollars: positive tops up, negative claws back a
          // mistaken grant. Bounded to catch fat-fingered amounts.
          amountUsd: z
            .number()
            .refine((n) => n !== 0, "amount must be non-zero")
            .gte(-1000)
            .lte(1000),
          note: z.string().max(500).optional(),
          // Client-minted idempotency key: a retried/double-submitted
          // request grants once, not twice.
          key: z.uuid(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const balanceMicro = await grantCredits(ctx.db, {
          userId: input.userId,
          amountMicro: usdToMicro(input.amountUsd),
          note: input.note ?? null,
          createdBy: ctx.session.user.id,
          key: input.key,
        });
        return { balanceMicro };
      }),
  }),
});
