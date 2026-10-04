import { waitlist } from "@repo/db/drizzle-schema";

import { os } from "../orpc";

export const waitlistRouter = {
  join: os.waitlist.join.handler(async ({ context, input }) => {
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
