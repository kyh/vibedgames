import { agentRouter } from "./agent/agent-router";
import { gameRouter } from "./game/game-router";
import { organizationRouter } from "./organization/organization-router";
import { sandboxRouter } from "./sandbox/sandbox-router";
import { createTRPCRouter } from "./trpc";
import { waitlistRouter } from "./waitlist/waitlist-router";

export const appRouter = createTRPCRouter({
  waitlist: waitlistRouter,
  organization: organizationRouter,
  agent: agentRouter,
  sandbox: sandboxRouter,
  game: gameRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
