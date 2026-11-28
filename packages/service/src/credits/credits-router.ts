import { ORPCError } from "@orpc/server";

import type { ORPCContext } from "../orpc";
import { os, requireSession } from "../orpc";
import { getBalanceMicro, listEntries, redeemCreditCode } from "./credit-ledger";
import { createCheckoutSession, purchasesEnabled, StripeError } from "./stripe";

const authed = os.credits.use(requireSession);

const mustVerifyEmail = ({ sendsEmail, session }: ORPCContext) =>
  sendsEmail && session?.user.emailVerified === false;

/**
 * User-facing credit state. Balances are integer micro-USD; clients format.
 * Admin operations (grants, per-user balances) live under `admin.credits`.
 */
export const creditsRouter = {
  checkout: authed.checkout.handler(async ({ context, input }) => {
    const { billing } = context;

    if (!purchasesEnabled(billing)) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message:
          "Card purchases aren't open yet. Add credit with a code instead: `vg credits redeem <code>`, or Settings → Credits.",
      });
    }

    const settings = new URL("/settings", context.productionURL ?? "https://www.vibedgames.com");
    settings.hash = "credits";
    const success = new URL(settings);
    success.searchParams.set("purchase", "success");

    try {
      const url = await createCheckoutSession(billing, {
        amountUsd: input.amountUsd,
        cancelUrl: settings.href,
        email: context.session.user.email,
        successUrl: success.href,
        userId: context.session.user.id,
      });

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

    return {
      balanceMicro,
      entries,
      mustVerifyEmail: mustVerifyEmail(context),
      purchasesEnabled: purchasesEnabled(context.billing),
    };
  }),

  redeem: authed.redeem.handler(async ({ context, input }) => {
    if (mustVerifyEmail(context)) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: `Confirm ${context.session.user.email} before redeeming a code: send yourself a code from Settings → Credits and enter it there.`,
      });
    }

    const result = await redeemCreditCode(context.db, context.session.user.id, input.code);

    if (result.status === "already_redeemed") {
      throw new ORPCError("CONFLICT", { message: "You already redeemed this code." });
    }

    if (result.status === "invalid") {
      throw new ORPCError("FORBIDDEN", { message: "Invalid or expired code." });
    }

    return { balanceMicro: result.balanceMicro, creditedMicro: result.creditedMicro };
  }),
};
