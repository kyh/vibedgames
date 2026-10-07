import { isAPIError } from "better-auth/api";
import { ORPCError } from "@orpc/server";

import { grantCredits, listBalances, usdToMicro } from "../credits/credit-ledger";
import { os, rejectApiKey, requireAdmin, requireSession } from "../orpc";

const admin = os.admin.use(requireSession).use(rejectApiKey).use(requireAdmin);

/**
 * Admin user management. Wraps better-auth's admin plugin endpoints so the
 * web app can list / create users without exposing the full admin API
 * surface to the client. The plugin endpoints re-verify the admin role from
 * the forwarded session headers, on top of our `requireAdmin` check.
 */
export const adminRouter = {
  credits: {
    /** Balances keyed by userId for the admin roster; a user with no ledger rows holds nothing. */
    balances: admin.credits.balances.handler(async ({ context }) => ({
      balances: await listBalances(context.db),
    })),

    grant: admin.credits.grant.handler(async ({ context, input }) => {
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
    create: admin.users.create.handler(async ({ context, input }) => {
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
        // better-auth refuses what the caller can fix (a taken email, a role
        // they may not grant) with a 4xx APIError. Anything else, its own 500
        // or the database failing, is a fault and surfaces as one.
        if (isAPIError(error) && error.statusCode < 500) {
          throw new ORPCError("BAD_REQUEST", { message: error.message });
        }
        throw error;
      }
    }),

    list: admin.users.list.handler(async ({ context }) => {
      const result = await context.auth.api.listUsers({
        headers: context.headers,
        query: { limit: 100, sortBy: "createdAt", sortDirection: "desc" },
      });
      return result;
    }),
  },
};
