/**
 * Request-time API-key resolution.
 *
 * The @better-auth/api-key plugin owns key storage, hashing, validation, and
 * management. We don't enable its session-mocking (the plugin flags that as
 * not production-safe), so this module bridges a `vg_…` key on an incoming
 * request to the better-auth `Session` shape the tRPC context expects — by
 * calling the plugin's `verifyApiKey` and loading the owning user.
 *
 * Keys ride the same `Authorization: Bearer` header the CLI uses for session
 * tokens (so `VG_TOKEN=vg_… vg deploy` works in CI unchanged); the `vg_`
 * prefix is what distinguishes them. `x-api-key` is also accepted.
 */
import type { Auth, Session } from "./auth";
import type { Db } from "@repo/db/drizzle-client";
import { eq } from "@repo/db";
import { user as userTable } from "@repo/db/drizzle-schema-auth";

export const API_KEY_PREFIX = "vg_";

/**
 * Collect candidate raw API keys off a request, in priority order
 * (`x-api-key` first, then `Authorization: Bearer`). Returning *all*
 * candidates — rather than the first header that carries a `vg_…` value —
 * means a junk or proxy-injected `x-api-key` can't shadow an otherwise valid
 * Bearer key: `resolveApiKeySession` falls through to the next candidate.
 */
const extractApiKeys = (headers: Headers): string[] => {
  const candidates: string[] = [];

  const direct = headers.get("x-api-key");
  if (direct?.startsWith(API_KEY_PREFIX)) candidates.push(direct);

  const auth = headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token.startsWith(API_KEY_PREFIX)) candidates.push(token);
  }

  // De-dup so the same key in both headers isn't verified twice.
  return [...new Set(candidates)];
};

/**
 * Resolve a request's API key (if any) to a better-auth-shaped session so the
 * existing `protectedProcedure`/`adminProcedure` checks work unchanged.
 * Returns `null` when there's no key, or no candidate verifies (the plugin
 * handles unknown/disabled/expired). Tries each candidate header in turn.
 */
export const resolveApiKeySession = async (
  auth: Auth,
  db: Db,
  headers: Headers,
): Promise<Session | null> => {
  const candidates = extractApiKeys(headers);
  if (candidates.length === 0) return null;

  for (const key of candidates) {
    const { valid, key: record } = await auth.api.verifyApiKey({ body: { key } });
    if (!valid || !record) continue;

    const rows = await db
      .select()
      .from(userTable)
      .where(eq(userTable.id, record.referenceId))
      .limit(1);
    const user = rows[0];
    if (!user) continue;

    // Synthesize the better-auth `Session` shape. Only `user` (and rarely
    // `session.token`) is read downstream; the token is namespaced so it can
    // never collide with a real session token.
    const now = new Date();
    return {
      user,
      session: {
        id: `apikey:${record.id}`,
        token: `apikey:${record.id}`,
        userId: user.id,
        expiresAt: record.expiresAt ?? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
        ipAddress: null,
        userAgent: null,
      },
    } as unknown as Session;
  }

  return null;
};
