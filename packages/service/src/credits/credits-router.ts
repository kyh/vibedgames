import { ORPCError } from "@orpc/server";

import { os, requireSession } from "../orpc";
import { getBalanceMicro, listEntries, redeemCreditCode } from "./credit-ledger";
import { createCheckoutSession, StripeError } from "./stripe";

const authed = os.credits.use(requireSession);

/**
 * User-facing credit state. Balances are integer micro-USD; clients format.
 * Admin operations (grants, per-user balances) live under `admin.credits`.
 */
export const creditsRouter = {
  // Any credential, API keys included: an agent can hand its human a payment
  // link, and paying it still takes a person at a browser.
  checkout: authed.checkout.handler(async ({ context, input }) => {
    const { billing } = context;
    if (!billing?.stripeSecretKey) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "Credit purchases are not configured on the server.",
      });
    }
    // Back to the page that shows the balance; it watches for the credit to land.
    const settings = new URL("/settings", context.productionURL ?? "https://vibedgames.com");
    settings.hash = "credits";
    const success = new URL(settings);
    success.searchParams.set("purchase", "success");
    try {
      const url = await createCheckoutSession(
        { ...billing, stripeSecretKey: billing.stripeSecretKey },
        {
          amountUsd: input.amountUsd,
          cancelUrl: settings.href,
          email: context.session.user.email,
          successUrl: success.href,
          userId: context.session.user.id,
        },
      );
      return { url };
    } catch (error) {
      if (error instanceof StripeError) {
        throw new ORPCError("BAD_GATEWAY", { message: `Checkout failed: ${error.message}` });
      }
      throw error;
    }
  }),

  me: authed.me.handler(async ({ context }) => {
    const userId = context.session.user.id;
    const balanceMicro = await getBalanceMicro(context.db, userId);
    const entries = await listEntries(context.db, userId, 100);
    return { balanceMicro, entries };
  }),

  redeem: authed.redeem.handler(async ({ context, input }) => {
    const result = await redeemCreditCode(context.db, context.session.user.id, input.code);
    if (result.status === "already_redeemed") {
      throw new ORPCError("CONFLICT", { message: "You already redeemed this code." });
    }
    if (result.status === "invalid") {
      // One message for unknown, expired, revoked and used up, so the answer
      // doesn't tell a guesser which codes exist.
      throw new ORPCError("FORBIDDEN", { message: "Invalid or expired code." });
    }
    return { balanceMicro: result.balanceMicro, creditedMicro: result.creditedMicro };
  }),
};
