import type { Auth } from "./identity/auth";
import type { Db } from "@repo/db/drizzle-client";
import { contract } from "@repo/contract";
import { implement, ORPCError, os as builder } from "@orpc/server";
import { getRequiredScope } from "@repo/contract/base";

import type { R2Config, UrlSigning } from "./storage/signed-urls";
import { isDelegated, resolveCaller } from "./identity/caller";

export type { R2BucketLike, R2Config, UrlSigning } from "./storage/signed-urls";

/**
 * Server-held config for the fal proxy that backs the generate procedures. fal
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

/** What the asset recipe procedures need of the media Worker: its fetch. */
export interface MediaJobs {
  fetch: (request: Request) => Promise<Response>;
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
  signing?: UrlSigning;
  media?: MediaProviderConfig;
  decision?: DecisionProviderConfig;
  billing?: BillingConfig;
  /** The media Worker's service binding that runs hosted recipe jobs; unset where there is none (Previews). */
  mediaJobs?: MediaJobs;
  /** Whether this deployment delivers email, so an unconfirmed address can be asked to confirm with a code. */
  sendsEmail?: boolean;
  /**
   * The protected resource this request is for (`oauth-resources.ts`): an
   * OAuth access token is accepted only when it was issued for it. Unset, no
   * OAuth token is accepted at all.
   */
  oauthResource?: string;
}

export const createORPCContext = async (opts: CreateORPCContextOptions) => {
  const { oauthScopes, session } = await resolveCaller(opts);

  return {
    auth: opts.auth,
    billing: opts.billing,
    db: opts.db,
    decision: opts.decision,
    headers: opts.headers,
    media: opts.media,
    mediaJobs: opts.mediaJobs,
    oauthScopes,
    productionURL: opts.productionURL,
    r2: opts.r2,
    sendsEmail: opts.sendsEmail ?? false,
    session,
    signing: opts.signing,
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

/**
 * Pairs with `protectedBase`. Apply as `os.<feature>.use(requireSession)`.
 * An OAuth access token must also carry the scope the procedure declares
 * (`requiresScope`); one without it gets FORBIDDEN with `insufficient_scope`,
 * and the scope it lacks in `data`, so the app can ask the person for it.
 */
export const requireSession = base.middleware(({ context, next, procedure }) => {
  if (!context.session?.user) {
    throw new ORPCError("UNAUTHORIZED");
  }

  const required = getRequiredScope(procedure);

  if (context.oauthScopes && required && !context.oauthScopes.includes(required)) {
    throw new ORPCError("FORBIDDEN", {
      data: { error: "insufficient_scope", scope: required },
      message: `insufficient_scope: this app was not granted "${required}". Reconnect it to grant it.`,
    });
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
 * authenticated with an API key or an OAuth access token — for surfaces a
 * delegated credential must not reach (managing API keys, admin actions).
 * Keeps both scoped to their intended use (deploy/generate) so a leaked key
 * or a connected app can't escalate (see `isDelegated`).
 */
export const rejectApiKey = sessionBase.middleware(({ context, next }) => {
  if (isDelegated(context.session)) {
    throw new ORPCError("FORBIDDEN", {
      message:
        "This action requires an interactive login, not an API key or a connected app. Use the web app.",
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
