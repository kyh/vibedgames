import { aiRouter } from "./ai/ai-router";
import { organizationRouter } from "./organization/organization-router";
import { createTRPCRouter } from "./trpc";
import { waitlistRouter } from "./waitlist/waitlist-router";

export const appRouter = createTRPCRouter({
  ai: aiRouter,
  waitlist: waitlistRouter,
  organization: organizationRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
