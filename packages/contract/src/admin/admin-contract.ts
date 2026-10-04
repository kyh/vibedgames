import { z } from "zod";

import { adminBase } from "../base";
import { documented } from "../openapi";
import { createUserInput, grantCreditsInput } from "./admin-schema";

const adminUser = z.object({
  banExpires: z.date().nullish(),
  banReason: z.string().nullish(),
  banned: z.boolean().nullish(),
  createdAt: z.date(),
  email: z.string(),
  emailVerified: z.boolean(),
  id: z.string(),
  image: z.string().nullish(),
  name: z.string(),
  role: z.string().nullish(),
  updatedAt: z.date(),
});

export const adminContract = {
  credits: {
    balances: adminBase
      .meta(
        documented({
          description:
            "Returns every user's credit balance in micro-USD, plus the signup grant a user without ledger rows implicitly holds. Admin only.",
          summary: "List credit balances",
        }),
      )
      .output(
        z.object({
          balances: z.array(z.object({ balanceMicro: z.number(), userId: z.string() })),
          signupGrantMicro: z.number().int(),
        }),
      ),

    grant: adminBase
      .meta(
        documented({
          description:
            "Grants (positive) or claws back (negative) credits in dollars. The client-minted `key` makes retries idempotent. Admin only.",
          summary: "Grant credits",
        }),
      )
      .input(grantCreditsInput)
      .output(z.object({ balanceMicro: z.number().int() })),
  },

  users: {
    create: adminBase
      .meta(
        documented({
          description: "Creates a user with an email and password. Admin only.",
          summary: "Create a user",
        }),
      )
      .input(createUserInput)
      .output(z.object({ user: adminUser })),

    list: adminBase
      .meta(
        documented({
          description: "Lists the 100 most recently created users. Admin only.",
          summary: "List users",
        }),
      )
      .output(
        z.object({
          limit: z.number().optional(),
          offset: z.number().optional(),
          total: z.number(),
          users: z.array(adminUser),
        }),
      ),
  },
};
