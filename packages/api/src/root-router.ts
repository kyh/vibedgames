import { localGameRouter } from "./game/local/local-game-router";
import { organizationRouter } from "./organization/organization-router";
import { sandboxRouter } from "./sandbox/sandbox-router";
import { createTRPCRouter } from "./trpc";
import { waitlistRouter } from "./waitlist/waitlist-router";

export const appRouter = createTRPCRouter({
  waitlist: waitlistRouter,
  organization: organizationRouter,
  localGame: localGameRouter,
  sandbox: sandboxRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
