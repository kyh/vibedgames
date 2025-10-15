import { agentRouter } from "./agent/agent-router";
import { organizationRouter } from "./organization/organization-router";
import { sandboxRouter } from "./sandbox/sandbox-router";
import { createTRPCRouter } from "./trpc";
import { v0Router } from "./v0/v0-router";
import { waitlistRouter } from "./waitlist/waitlist-router";

export const appRouter = createTRPCRouter({
  waitlist: waitlistRouter,
  organization: organizationRouter,
  v0: v0Router,
  agent: agentRouter,
  sandbox: sandboxRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
