import { adminRouter } from "./admin/admin-router";
import { cliAuthRouter } from "./cli-auth/cli-auth-router";
import { deployRouter } from "./deploy/deploy-router";
import { v0Router } from "./game/v0/v0-router";
import { inviteRouter } from "./invite/invite-router";
import { createTRPCRouter } from "./trpc";
import { waitlistRouter } from "./waitlist/waitlist-router";

export const appRouter = createTRPCRouter({
  cliAuth: cliAuthRouter,
  waitlist: waitlistRouter,
  deploy: deployRouter,
  v0: v0Router,
  invite: inviteRouter,
  admin: adminRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
