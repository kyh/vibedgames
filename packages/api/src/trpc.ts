/**
 * tl;dr - this is where all the tRPC server stuff is created and plugged in.
 */
import type { Auth } from "./auth/auth";
import type { Db } from "@repo/db/drizzle-client";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

/**
 * Minimal structural view of the R2 binding methods this package uses.
 * Intentionally NOT imported from `@cloudflare/workers-types` so the
 * inferred `AppRouter` type does not carry a transitive reference to
 * that package — consumers (e.g. the CLI) would otherwise need it too.
 */
export type R2BucketLike = {
  list(options: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<void>;
};

/**
 * R2 credentials needed for minting S3 presigned URLs. The R2 *binding* can
 * read/write objects but cannot mint presigns — that requires an S3 API key.
 */
export type R2Config = {
  bucket: R2BucketLike;
  bucketName: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
};

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
  r2?: R2Config;
};

export const createTRPCContext = async (opts: CreateTRPCContextOptions) => {
  const session = await opts.auth.api.getSession({ headers: opts.headers });

  return {
    session,
    db: opts.db,
    auth: opts.auth,
    headers: opts.headers,
    productionURL: opts.productionURL,
    r2: opts.r2,
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
