import { protectedProcedure } from "../orpc";
import { getBalanceMicro, listEntries } from "./credit-ledger";

/**
 * User-facing credit state. Balances are integer micro-USD; clients format.
 * Admin operations (grants, per-user balances) live under `admin.credits`.
 */
export const creditsRouter = {
  me: protectedProcedure.handler(async ({ context }) => {
    const userId = context.session.user.id;
    const balanceMicro = await getBalanceMicro(context.db, userId);
    const entries = await listEntries(context.db, userId, 100);
    return { balanceMicro, entries };
  }),
};
