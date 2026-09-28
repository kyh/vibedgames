import { waitlist } from "@repo/db/drizzle-schema";
import { z } from "zod";

import { documented } from "../openapi";
import { publicProcedure } from "../orpc";
import { joinWaitlistInput } from "./waitlist-schema";

const waitlistEntry = z.object({
  email: z.string().nullable(),
  id: z.string(),
  source: z.string().nullable(),
  userId: z.string().nullable(),
});

export const waitlistRouter = {
  join: publicProcedure
    .meta(
      documented({
        description:
          "Adds an email address to the waitlist. Public; attaches the signed-in user when a session is present.",
        summary: "Join the waitlist",
      }),
    )
    .input(joinWaitlistInput)
    .output(z.object({ waitlist: waitlistEntry.optional() }))
    .handler(async ({ context, input }) => {
      const [created] = await context.db
        .insert(waitlist)
        .values({
          ...input,
          id: crypto.randomUUID(),
          source: context.productionURL ?? "",
          userId: context.session?.user.id,
        })
        .returning();

      return {
        waitlist: created,
      };
    }),
};
