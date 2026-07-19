import { adminRouter } from "./admin/admin-router";
import { apiKeyRouter } from "./auth/api-key-router";
import { authRouter } from "./auth/auth-router";
import { creditsRouter } from "./credits/credits-router";
import { deployRouter } from "./deploy/deploy-router";
import { generateRouter } from "./generate/generate-router";
import { createTRPCRouter } from "./trpc";
import { waitlistRouter } from "./waitlist/waitlist-router";

export const appRouter = createTRPCRouter({
  auth: authRouter,
  apiKeys: apiKeyRouter,
  waitlist: waitlistRouter,
  deploy: deployRouter,
  generate: generateRouter,
  credits: creditsRouter,
  admin: adminRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
