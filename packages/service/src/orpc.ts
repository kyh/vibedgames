/**
 * tl;dr - this is where all the oRPC server stuff is created and plugged in.
 */
import type { Auth } from "./auth/auth";
import type { Db } from "@repo/db/drizzle-client";
import { contract } from "@repo/contract";
import { implement, ORPCError, os as builder } from "@orpc/server";

import { API_KEY_SESSION_PREFIX, resolveApiKeySession } from "./auth/api-key";

/**
 * Minimal structural view of the R2 binding methods this package (and, through
 * `R2Config`, the web app's R2 proxy routes) uses. Declared here rather than
 * imported from `@cloudflare/workers-types` so the context names only what the
 * code calls: any object with these methods stands in for the binding, and
 * nothing that reads `ORPCContext` needs the Workers globals.
 */
export interface R2BucketLike {
  get: (key: string) => Promise<{
    size: number;
    httpMetadata?: { contentType?: string };
    arrayBuffer: () => Promise<ArrayBuffer>;
  } | null>;
  head: (key: string) => Promise<{
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
  list: (options: { prefix?: string; cursor?: string; limit?: number }) => Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete: (key: string) => Promise<void>;
  // The real binding resolves with the written object's metadata; this
  // package only ever awaits the write, so just the key is modeled.
  put: (
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ) => Promise<{ key: string } | null>;
}

/**
 * R2 credentials needed for minting S3 presigned URLs. The R2 *binding* can
 * read/write objects but cannot mint presigns; that requires an S3 API key.
 *
 * When `proxyUploadBaseUrl` is set (typically only in local dev), `presignPut`
 * returns an HMAC-signed URL that points back at the worker's own
 * `/api/r2-upload` endpoint instead of direct-to-R2. The worker then writes
 * via the `bucket` binding, so uploads land in whatever bucket the binding
 * resolves to (Miniflare-simulated locally, real R2 in prod). Keeps dev fully
 * isolated from prod R2.
 */
export interface R2Config {
  bucket: R2BucketLike;
  bucketName: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  proxyUploadBaseUrl?: string;
  proxyUploadSecret?: string;
}

/**
 * Server-held config for the fal proxy that backs `generate.forward`. fal
 * is the single gateway we route through; per-target base URLs let
 * deployments point each fal target at a Cloudflare AI Gateway prefix
 * for caching, rate limits, fallbacks, and observability.
 */
export interface MediaProviderConfig {
  fal?: string;
  falQueueBaseUrl?: string;
  falPlatformBaseUrl?: string;
  falDocsBaseUrl?: string;
  falStorageBaseUrl?: string;
}

/**
 * Server-held config for the decision-model proxy behind `playtest.decide`.
 * `typesafe` is the TypeSafe API key; the base URL override exists for a
 * gateway prefix or a local stand-in, never for a different provider.
 */
export interface DecisionProviderConfig {
  typesafe?: string;
  typesafeBaseUrl?: string;
  /** Signs the short-lived tokens the in-page playtester carries (see playtest/session-token.ts). */
  tokenSecret?: string;
}

/**
 * Server-held Stripe config behind `credits.checkout` and the
 * `/api/stripe/webhook` route (see credits/stripe.ts). Either key missing
 * turns its half off: checkout answers 412, the webhook 412.
 */
export interface BillingConfig {
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  /** Points checkout at a Stripe stand-in; production never sets it. */
  stripeApiBaseUrl?: string;
}

/**
 * Per-request context.
 *
 * On Cloudflare Workers both `db` and `auth` are constructed per request from
 * the Worker `env` bindings, so the caller (route handler) builds them and
 * passes them in.
 */
export interface CreateORPCContextOptions {
  headers: Headers;
  db: Db;
  auth: Auth;
  productionURL?: string;
  r2?: R2Config;
  media?: MediaProviderConfig;
  decision?: DecisionProviderConfig;
  billing?: BillingConfig;
}

export const createORPCContext = async (opts: CreateORPCContextOptions) => {
  // Try a normal better-auth session first (cookie or session bearer token).
  // Fall back to a long-lived API key (`vg_…`) so CLI/HTTP clients can
  // authenticate in CI; both resolve to the same `Session` shape.
  const session =
    (await opts.auth.api.getSession({ headers: opts.headers })) ??
    (await resolveApiKeySession(opts.auth, opts.db, opts.headers));

  return {
    auth: opts.auth,
    billing: opts.billing,
    db: opts.db,
    decision: opts.decision,
    headers: opts.headers,
    media: opts.media,
    productionURL: opts.productionURL,
    r2: opts.r2,
    session,
  };
};

export type ORPCContext = Awaited<ReturnType<typeof createORPCContext>>;

/**
 * Implements @repo/contract. `.use` on the implementer runs before input
 * validation, so anonymous callers get UNAUTHORIZED rather than BAD_REQUEST;
 * `.use` on a procedure runs after it. Feature routers are plain objects:
 * `.router()` would re-apply implementer middleware.
 */
export const os = implement(contract).$context<ORPCContext>();

const base = builder.$context<ORPCContext>();

/** Pairs with `protectedBase`. Apply as `os.<feature>.use(requireSession)`. */
export const requireSession = base.middleware(({ context, next }) => {
  if (!context.session?.user) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return next({
    context: {
      session: { ...context.session, user: context.session.user },
    },
  });
});

type SessionContext = ORPCContext & { session: NonNullable<ORPCContext["session"]> };

const sessionBase = builder.$context<SessionContext>();

/**
 * Pairs with `sessionOnlyBase`; apply after `requireSession`. Rejects callers
 * authenticated with an API key — for surfaces an automation/CI credential must
 * not reach (managing API keys, admin actions). Keeps API keys scoped to their
 * intended use (deploy/generate) so a leaked key can't escalate. API-key
 * sessions are synthesized with a namespaced `apikey:` token (see
 * `resolveApiKeySession`); real better-auth tokens never collide with it.
 */
export const rejectApiKey = sessionBase.middleware(({ context, next }) => {
  if (context.session.session.token.startsWith(API_KEY_SESSION_PREFIX)) {
    throw new ORPCError("FORBIDDEN", {
      message: "This action requires an interactive login, not an API key. Use the web app.",
    });
  }
  return next();
});

/**
 * Pairs with `adminBase`. Admin actions are interactive/web-only — apply after
 * `rejectApiKey` so an admin's API key (which would otherwise pass the role
 * check) can't reach them.
 */
export const requireAdmin = sessionBase.middleware(({ context, next }) => {
  if (context.session.user.role !== "admin") {
    throw new ORPCError("FORBIDDEN");
  }
  return next();
});
