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
 * that package; consumers (e.g. the CLI) would otherwise need it too.
 */
export type R2BucketLike = {
  get(key: string): Promise<{
    size: number;
    httpMetadata?: { contentType?: string };
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  head(key: string): Promise<{
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
  list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<void>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
};

/**
 * R2 credentials needed for minting S3 presigned URLs. The R2 *binding* can
 * read/write objects but cannot mint presigns; that requires an S3 API key.
 */
export type R2Config = {
  bucket: R2BucketLike;
  bucketName: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/**
 * Server-held API keys for the image generation providers the CLI proxies
 * through `image.run`. None are required at boot; a missing key just means
 * the corresponding provider returns an error when a CLI user picks it.
 *
 * `*BaseUrl` overrides exist so deployments can route provider traffic
 * through a Cloudflare AI Gateway endpoint, e.g.
 *   `https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/openai`
 * for caching, rate limits, fallbacks, and observability.
 */
export type ImageProviderKeys = {
  openai?: string;
  openaiBaseUrl?: string;
  fal?: string;
  falBaseUrl?: string;
  retroDiffusion?: string;
  retroDiffusionBaseUrl?: string;
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
  imageProviders?: ImageProviderKeys;
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
    imageProviders: opts.imageProviders,
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

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.session.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next();
});
