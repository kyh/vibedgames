import { z } from "zod";

import { protectedBase } from "../base";
import { documented } from "../openapi";
import { checkoutInput, redeemInput } from "./credits-schema";

const creditEntry = z.object({
  createdAt: z.date(),
  deltaMicro: z.number().int().describe("Signed micro-USD: positive is a grant or refund."),
  endpointId: z.string().nullable(),
  id: z.string(),
  kind: z.enum([
    "signup_grant",
    "admin_grant",
    "code_redeem",
    "purchase",
    "generation_hold",
    "generation_settle",
    "generation_release",
  ]),
  note: z.string().nullable(),
  requestId: z.string().nullable(),
});

export const creditsContract = {
  checkout: protectedBase
    .meta(
      documented({
        description:
          "Starts a card payment for `amountUsd` of generation credit and returns a hosted checkout URL for a person to open. The credit lands once the payment clears, usually within seconds of paying. 412 when payments are not configured on the server.",
        errors: [412, 502],
        summary: "Buy credits",
      }),
    )
    .input(checkoutInput)
    .output(z.object({ url: z.url() })),

  me: protectedBase
    .meta(
      documented({
        description:
          "Returns the caller's generation credit balance in micro-USD (1,000,000 = $1) and their 100 most recent ledger entries.",
        summary: "Get your credit balance",
      }),
    )
    .output(z.object({ balanceMicro: z.number().int(), entries: z.array(creditEntry) })),

  redeem: protectedBase
    .meta(
      documented({
        description:
          "Redeems a credit code for the caller, adding its value to their balance. Each account can redeem a given code once. 403 when the code is unknown, expired, revoked or used up; 409 when this account already redeemed it.",
        errors: [403, 409],
        summary: "Redeem a credit code",
      }),
    )
    .input(redeemInput)
    .output(z.object({ balanceMicro: z.number().int(), creditedMicro: z.number().int() })),
};
