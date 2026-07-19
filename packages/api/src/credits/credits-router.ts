import { createTRPCRouter, protectedProcedure } from "../trpc";
import { getBalanceMicro, listEntries } from "./credit-ledger";

/**
 * User-facing credit state. Balances are integer micro-USD; clients format.
 * Admin operations (grants, per-user balances) live under `admin.credits`.
 */
export const creditsRouter = createTRPCRouter({
  me: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const balanceMicro = await getBalanceMicro(ctx.db, userId);
    const entries = await listEntries(ctx.db, userId, 100);
    return { balanceMicro, entries };
  }),
});
