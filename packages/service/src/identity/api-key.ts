import type { Auth, Session } from "./auth";
import type { Db } from "@repo/db/drizzle-client";
import { eq } from "@repo/db";
import { user as userTable } from "@repo/db/drizzle-schema-auth";

const API_KEY_PREFIX = "vg_";

export const API_KEY_SESSION_PREFIX = "apikey:";

const extractApiKeys = (headers: Headers) => {
  const candidates: string[] = [];

  const direct = headers.get("x-api-key");

  if (direct?.startsWith(API_KEY_PREFIX) === true) {
    candidates.push(direct);
  }

  const auth = headers.get("authorization");

  const token =
    auth !== null && auth !== ""
      ? /^Bearer\s+(?<token>.+)$/iu.exec(auth)?.groups?.token?.trim()
      : undefined;

  if (token?.startsWith(API_KEY_PREFIX) === true) {
    candidates.push(token);
  }

  return [...new Set(candidates)];
};

/**
 * Resolve a request's API key (if any) to a better-auth-shaped session so the
 * existing `requireSession`/`requireAdmin` checks work unchanged.
 * Returns `null` when there's no key, or no candidate verifies (the plugin
 * handles unknown/disabled/expired). Tries each candidate header in turn.
 */
export const resolveApiKeySession = async (auth: Auth, db: Db, headers: Headers) => {
  const candidates = extractApiKeys(headers);

  if (candidates.length === 0) {
    return null;
  }

  for (const key of candidates) {
    const { valid, key: record } = await auth.api.verifyApiKey({ body: { key } });

    if (!valid || !record) {
      continue;
    }

    const rows = await db
      .select()
      .from(userTable)
      .where(eq(userTable.id, record.referenceId))
      .limit(1);

    const [user] = rows;

    if (!user) {
      continue;
    }

    if (user.banned === true && (!user.banExpires || user.banExpires.getTime() > Date.now())) {
      continue;
    }

    const now = new Date();

    return {
      session: {
        createdAt: now,
        expiresAt: record.expiresAt ?? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        id: `${API_KEY_SESSION_PREFIX}${record.id}`,
        ipAddress: null,
        token: `${API_KEY_SESSION_PREFIX}${record.id}`,
        updatedAt: now,
        userAgent: null,
        userId: user.id,
      },
      user,
    } as Session;
  }

  return null;
};
