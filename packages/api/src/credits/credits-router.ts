import { z } from "zod";

import { documented } from "../openapi";
import { protectedProcedure } from "../orpc";
import { getBalanceMicro, listEntries } from "./credit-ledger";

const creditEntry = z.object({
  createdAt: z.date(),
  deltaMicro: z.number().int().describe("Signed micro-USD: positive is a grant or refund."),
  endpointId: z.string().nullable(),
  id: z.string(),
  kind: z.enum([
    "signup_grant",
    "admin_grant",
    "generation_hold",
    "generation_settle",
    "generation_release",
  ]),
  note: z.string().nullable(),
  requestId: z.string().nullable(),
});

/**
 * User-facing credit state. Balances are integer micro-USD; clients format.
 * Admin operations (grants, per-user balances) live under `admin.credits`.
 */
export const creditsRouter = {
  me: protectedProcedure
    .meta(
      documented({
        description:
          "Returns the caller's generation credit balance in micro-USD (1,000,000 = $1) and their 100 most recent ledger entries.",
        summary: "Get your credit balance",
      }),
    )
    .output(z.object({ balanceMicro: z.number().int(), entries: z.array(creditEntry) }))
    .handler(async ({ context }) => {
      const userId = context.session.user.id;
      const balanceMicro = await getBalanceMicro(context.db, userId);
      const entries = await listEntries(context.db, userId, 100);
      return { balanceMicro, entries };
    }),
};
