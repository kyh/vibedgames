/**
 * tl;dr - this is where all the tRPC server stuff is created and plugged in.
 */
import type { Auth } from "./auth/auth";
import type { Db } from "@repo/db/drizzle-client";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

/**
 * Per-request context.
 *
 * On Cloudflare Workers both `db` and `auth` are constructed per request from
 * the Worker `env` bindings, so the caller (route handler) builds them and
 * passes them in.
 */
export type CreateTRPCContextOptions = {
  headers: Headers;
  db: Db;
  auth: Auth;
  productionURL?: string;
};

export const createTRPCContext = async (opts: CreateTRPCContextOptions) => {
  const session = await opts.auth.api.getSession({ headers: opts.headers });

  return {
    session,
    db: opts.db,
    auth: opts.auth,
    headers: opts.headers,
    productionURL: opts.productionURL,
  };
};

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
    },
  }),
});

export const createCallerFactory = t.createCallerFactory;
export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});
