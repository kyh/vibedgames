import { adminRouter } from "./admin/admin-router";
import { authRouter } from "./auth/auth-router";
import { deployRouter } from "./deploy/deploy-router";
import { imageRouter } from "./image/image-router";
import { createTRPCRouter } from "./trpc";
import { waitlistRouter } from "./waitlist/waitlist-router";

export const appRouter = createTRPCRouter({
  auth: authRouter,
  waitlist: waitlistRouter,
  deploy: deployRouter,
  image: imageRouter,
  admin: adminRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
