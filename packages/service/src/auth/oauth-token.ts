/**
 * Request-time OAuth access-token resolution, the third credential beside a
 * session and a `vg_…` API key. The token is a JWT the `mcp()` provider
 * signed for one protected resource (`oauth-resources.ts`); it is verified
 * here against the JWT plugin's own key set, read in-process rather than over
 * HTTP so the Worker never fetches itself, and checked for this resource as
 * its audience. The holder then acts as the user who consented, through the
 * same `Session` shape every procedure reads.
 */
import type { Auth, Session } from "./auth";
import type { Db } from "@repo/db/drizzle-client";
import { eq } from "@repo/db";
import { user as userTable } from "@repo/db/drizzle-schema-auth";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { z } from "zod";

import { oauthIssuer } from "./oauth-resources";

// Namespaces the synthetic session token minted for OAuth auth, as
// `apikey:` does for keys, so `rejectApiKey` can keep both off session-only
// surfaces.
export const OAUTH_SESSION_PREFIX = "oauth:";

const JWS = /^[\w-]+\.[\w-]+\.[\w-]+$/u;

/** The claims a usable token carries: whose it is, until when, and no DPoP binding. */
const accessTokenClaims = z.object({
  cnf: z.never().optional(),
  exp: z.number(),
  jti: z.string().optional(),
  // Space-separated, as RFC 9068 carries it.
  scope: z.string().default(""),
  sub: z.string().min(1),
});

const bearerToken = (headers: Headers): string | null => {
  const header = headers.get("authorization");
  const token = header
    ? /^Bearer\s+(?<token>.+)$/iu.exec(header)?.groups?.token?.trim()
    : undefined;
  return token && JWS.test(token) ? token : null;
};

// One cache key per key source: the key set is re-read when a token names a
// key id it has not seen, and otherwise held for the library's TTL.
const jwksCacheKeys = new WeakMap<object, object>();

type AccessTokenClaims = z.infer<typeof accessTokenClaims>;

export interface AccessTokenCheck {
  /** The provider's signing keys, as `/api/auth/jwks` serves them. */
  getJwks: () => ReturnType<Auth["api"]["getJwks"]>;
  issuer: string;
  resource: string;
}

/**
 * The claims of `token` when the provider signed it, it is unexpired, its
 * audience names `resource`, and it carries no DPoP binding (`cnf`), which
 * needs a proof this API does not check; otherwise null.
 */
export const verifyAccessToken = async (
  token: string,
  { getJwks, issuer, resource }: AccessTokenCheck,
): Promise<AccessTokenClaims | null> => {
  let cacheKey = jwksCacheKeys.get(getJwks);
  if (!cacheKey) {
    cacheKey = {};
    jwksCacheKeys.set(getJwks, cacheKey);
  }
  let verified;
  try {
    verified = await verifyJwsAccessToken(token, {
      jwksCacheKey: cacheKey,
      jwksFetch: getJwks,
      verifyOptions: { audience: resource, issuer },
    });
  } catch {
    return null;
  }
  const parsed = accessTokenClaims.safeParse(verified);
  return parsed.success ? parsed.data : null;
};

// The bound `getJwks` per auth instance, so its key-set cache outlives a request.
const keySources = new WeakMap<Auth, AccessTokenCheck["getJwks"]>();

/** Who an access token acts for, and the scopes the person granted it. */
export interface OAuthGrant {
  scopes: readonly string[];
  session: Session;
}

/**
 * The grant a valid OAuth access token for `resource` stands for, or null
 * when the request carries none, or one `verifyAccessToken` refuses, or one
 * for a user who is gone or banned.
 */
export const resolveOAuthSession = async (
  auth: Auth,
  db: Db,
  headers: Headers,
  resource: string,
): Promise<OAuthGrant | null> => {
  const token = bearerToken(headers);
  if (!token) {
    return null;
  }
  let getJwks = keySources.get(auth);
  if (!getJwks) {
    getJwks = () => auth.api.getJwks();
    keySources.set(auth, getJwks);
  }
  const claims = await verifyAccessToken(token, {
    getJwks,
    issuer: oauthIssuer(auth.options.baseURL ?? resource),
    resource,
  });
  if (!claims) {
    return null;
  }

  const [user] = await db.select().from(userTable).where(eq(userTable.id, claims.sub)).limit(1);
  // Honour admin bans, as API keys do: a token outliving a ban must not act.
  if (!user || (user.banned && (!user.banExpires || user.banExpires.getTime() > Date.now()))) {
    return null;
  }

  const now = new Date();
  const id = `${OAUTH_SESSION_PREFIX}${claims.jti ?? claims.sub}`;
  const expiresAt = new Date(claims.exp * 1000);
  // SAFETY: synthesized better-auth Session shape at the OAuth boundary; only `user` and the namespaced token are read downstream
  const session = {
    session: {
      createdAt: now,
      expiresAt,
      id,
      ipAddress: null,
      token: id,
      updatedAt: now,
      userAgent: null,
      userId: user.id,
    },
    user,
  } as Session;
  return { scopes: claims.scope.split(" ").filter(Boolean), session };
};
