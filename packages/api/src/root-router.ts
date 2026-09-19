import { adminRouter } from "./admin/admin-router";
import { apiKeyRouter } from "./auth/api-key-router";
import { authRouter } from "./auth/auth-router";
import { creditsRouter } from "./credits/credits-router";
import { deployRouter } from "./deploy/deploy-router";
import { generateRouter } from "./generate/generate-router";
import { playtestRouter } from "./playtest/playtest-router";
import { waitlistRouter } from "./waitlist/waitlist-router";

export const appRouter = {
  admin: adminRouter,
  apiKeys: apiKeyRouter,
  auth: authRouter,
  credits: creditsRouter,
  deploy: deployRouter,
  generate: generateRouter,
  playtest: playtestRouter,
  waitlist: waitlistRouter,
};

// export type definition of API
export type AppRouter = typeof appRouter;
