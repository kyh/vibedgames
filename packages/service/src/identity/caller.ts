import type { Auth, Session } from "./auth";
import type { Db } from "@repo/db/drizzle-client";

import { API_KEY_SESSION_PREFIX, resolveApiKeySession } from "./api-key";
import { OAUTH_SESSION_PREFIX, resolveOAuthSession } from "./oauth-token";

/**
 * Who a request acts as: its session, and the scopes an OAuth access token
 * granted (null for every other credential, which acts in full).
 */
export interface Caller {
  session: Session | null;
  oauthScopes: readonly string[] | null;
}

/**
 * Resolves a request's credential, tried in order: a better-auth session
 * (cookie or session bearer), a `vg_` API key, then an OAuth access token,
 * which is accepted only when `oauthResource` is set and it was issued for it.
 */
export const resolveCaller: (opts: {
  auth: Auth;
  db: Db;
  headers: Headers;
  oauthResource?: string;
}) => Promise<Caller> = async ({ auth, db, headers, oauthResource }) => {
  const direct =
    (await auth.api.getSession({ headers })) ?? (await resolveApiKeySession(auth, db, headers));

  if (direct) {
    return { oauthScopes: null, session: direct };
  }

  const grant =
    oauthResource !== undefined && oauthResource !== ""
      ? await resolveOAuthSession(auth, db, headers, oauthResource)
      : null;

  return { oauthScopes: grant?.scopes ?? null, session: grant?.session ?? null };
};

/**
 * True for a session that an API key or an OAuth access token stands for,
 * rather than a person's interactive login. Their sessions carry a namespaced
 * `apikey:` / `oauth:` token, which real better-auth tokens never collide with.
 */
export const isDelegated: (session: Session) => boolean = (session) =>
  session.session.token.startsWith(API_KEY_SESSION_PREFIX) ||
  session.session.token.startsWith(OAUTH_SESSION_PREFIX);
