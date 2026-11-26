import type { Auth, Session } from "./auth";
import type { Db } from "@repo/db/drizzle-client";
import { eq } from "@repo/db";
import { user as userTable } from "@repo/db/drizzle-schema-auth";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { z } from "zod";

import { oauthIssuer } from "./oauth-resources";

export const OAUTH_SESSION_PREFIX = "oauth:";

const JWS = /^[\w-]+\.[\w-]+\.[\w-]+$/u;

const accessTokenClaims = z.object({
  cnf: z.never().optional(),
  exp: z.number(),
  jti: z.string().optional(),
  scope: z.string().default(""),
  sub: z.string().min(1),
});

const bearerToken = (headers: Headers) => {
  const header = headers.get("authorization");

  const token =
    header !== null && header !== ""
      ? /^Bearer\s+(?<token>.+)$/iu.exec(header)?.groups?.token?.trim()
      : undefined;

  return token !== undefined && token !== "" && JWS.test(token) ? token : null;
};

const jwksCacheKeys = new WeakMap<object, object>();

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
) => {
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
export const resolveOAuthSession: (
  auth: Auth,
  db: Db,
  headers: Headers,
  resource: string,
) => Promise<OAuthGrant | null> = async (auth, db, headers, resource) => {
  const token = bearerToken(headers);

  if (token === null || token === "") {
    return null;
  }

  let getJwks = keySources.get(auth);

  if (!getJwks) {
    getJwks = async () => await auth.api.getJwks();
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

  if (
    !user ||
    (user.banned === true && (!user.banExpires || user.banExpires.getTime() > Date.now()))
  ) {
    return null;
  }

  const now = new Date();
  const id = `${OAUTH_SESSION_PREFIX}${claims.jti ?? claims.sub}`;
  const expiresAt = new Date(claims.exp * 1000);

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
