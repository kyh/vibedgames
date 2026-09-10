import { waitlist } from "@repo/db/drizzle-schema";

import { publicProcedure } from "../orpc";
import { joinWaitlistInput } from "./waitlist-schema";

export const waitlistRouter = {
  join: publicProcedure.input(joinWaitlistInput).handler(async ({ context, input }) => {
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
