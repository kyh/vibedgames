import { gameRouter } from "./game/game-router";
import { organizationRouter } from "./organization/organization-router";
import { createTRPCRouter } from "./trpc";
import { v0Router } from "./v0/v0-router";
import { waitlistRouter } from "./waitlist/waitlist-router";

export const appRouter = createTRPCRouter({
  waitlist: waitlistRouter,
  organization: organizationRouter,
  game: gameRouter,
  v0: v0Router,
});

// export type definition of API
export type AppRouter = typeof appRouter;
