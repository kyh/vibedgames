import { localGameRouter } from "./game/local/local-game-router";
import { v0Router } from "./game/v0/v0-router";
import { organizationRouter } from "./organization/organization-router";
import { sandboxRouter } from "./sandbox/sandbox-router";
import { createTRPCRouter } from "./trpc";
import { waitlistRouter } from "./waitlist/waitlist-router";

export const appRouter = createTRPCRouter({
  waitlist: waitlistRouter,
  organization: organizationRouter,
  localGame: localGameRouter,
  v0: v0Router,
  sandbox: sandboxRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
