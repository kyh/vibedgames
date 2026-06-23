/**
 * API-key generation, hashing, and request resolution.
 *
 * Keys are long-lived credentials for programmatic access (CLI in CI). They
 * travel over the same `Authorization: Bearer <key>` header the CLI uses for
 * session tokens — the `vg_` prefix is what lets the tRPC context tell a key
 * apart from a better-auth session token. The `x-api-key` header is also
 * accepted for non-CLI HTTP clients.
 *
 * We only ever persist a SHA-256 hash of the key (see `apiKey.keyHash`); the
 * raw value is shown to the user exactly once at creation time.
 */
import type { Session } from "./auth";
import type { Db } from "@repo/db/drizzle-client";
import { eq } from "@repo/db";
import { apiKey } from "@repo/db/drizzle-schema";
import { user as userTable } from "@repo/db/drizzle-schema-auth";

export const API_KEY_PREFIX = "vg_";

// `vg_` + 8 hex chars — enough to disambiguate keys in a list without
// revealing anything sensitive (the hash, not the prefix, is the secret).
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Mint a fresh API key: `vg_` followed by 32 bytes of hex randomness. */
export const generateApiKeyToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return API_KEY_PREFIX + toHex(bytes);
};

/** SHA-256 hex digest of a raw key — what we store and look up by. */
export const hashApiKey = async (token: string): Promise<string> => {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
};

/** Short, non-secret slice of a key for display (`vg_a1b2c3d4`). */
export const apiKeyDisplayPrefix = (token: string): string => token.slice(0, DISPLAY_PREFIX_LENGTH);

/** Pull a raw API key off a request, if present. Prefers `x-api-key`. */
const extractApiKey = (headers: Headers): string | null => {
  const direct = headers.get("x-api-key");
  if (direct?.startsWith(API_KEY_PREFIX)) return direct;

  const auth = headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token.startsWith(API_KEY_PREFIX)) return token;
  }
  return null;
};

/**
 * Resolve a request's API key (if any) to a better-auth-shaped session so the
 * existing `protectedProcedure`/`adminProcedure` checks work unchanged. Returns
 * `null` when there's no key, or the key is unknown/revoked/expired.
 *
 * Best-effort touches `lastUsedAt` so users can spot stale keys. This is the
 * only write on the hot auth path; it's a single indexed UPDATE.
 */
export const resolveApiKeySession = async (db: Db, headers: Headers): Promise<Session | null> => {
  const raw = extractApiKey(headers);
  if (!raw) return null;

  const keyHash = await hashApiKey(raw);
  const now = new Date();

  const rows = await db
    .select({
      keyId: apiKey.id,
      expiresAt: apiKey.expiresAt,
      revokedAt: apiKey.revokedAt,
      user: userTable,
    })
    .from(apiKey)
    .innerJoin(userTable, eq(apiKey.userId, userTable.id))
    .where(eq(apiKey.keyHash, keyHash))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < now.getTime()) return null;

  await db.update(apiKey).set({ lastUsedAt: now }).where(eq(apiKey.id, row.keyId));

  // Synthesize the better-auth `Session` shape. Only `user` (and rarely
  // `session.token`) is read downstream; the token is namespaced so it can
  // never collide with a real session token.
  return {
    user: row.user,
    session: {
      id: `apikey:${row.keyId}`,
      token: `apikey:${row.keyId}`,
      userId: row.user.id,
      expiresAt: row.expiresAt ?? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
  } as unknown as Session;
};
