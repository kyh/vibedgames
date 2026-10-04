/**
 * Short-lived, single-purpose tokens for the in-page playtester.
 *
 * `vg playtest run` injects a loop into the game's page that calls
 * `/api/playtest/decide` directly, so the page needs a credential — and a
 * game is untrusted user code, so it must never see the user's session or
 * API key. This token is the one thing it gets: HMAC-signed by the server,
 * bound to the user who started the run, valid for minutes, and honoured by
 * exactly one endpoint. Stateless (nothing stored), so a leaked token can at
 * most spend decision-model tokens in the user's name until it expires.
 *
 * Format: `pt.<payload>.<signature>`, both base64url; payload is JSON
 * `{ u: userId, e: expiresAtMs, n: nonce }`.
 */

export const PLAYTEST_TOKEN_TTL_MS = 15 * 60_000;

const PREFIX = "pt";

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const fromBase64url = (text: string): Uint8Array | null => {
  const padded = text
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (c) => c.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
};

const hmac = async (secret: string, message: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
};

/** Compare without short-circuiting on the first differing byte. */
const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    // oxlint-disable-next-line no-bitwise -- accumulating XOR diffs is the point of a constant-time compare
    mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return mismatch === 0;
};

export interface MintedToken {
  token: string;
  expiresAt: number;
}

export const mintPlaytestToken = async (
  secret: string,
  userId: string,
  now = Date.now(),
): Promise<MintedToken> => {
  const expiresAt = now + PLAYTEST_TOKEN_TTL_MS;
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = base64url(
    new TextEncoder().encode(JSON.stringify({ e: expiresAt, n: nonce, u: userId })),
  );
  const signature = base64url(await hmac(secret, `${PREFIX}.${payload}`));
  return { expiresAt, token: `${PREFIX}.${payload}.${signature}` };
};

export interface VerifiedToken {
  userId: string;
  expiresAt: number;
}

/** The token's claims if it is genuine and unexpired, else null. */
export const verifyPlaytestToken = async (
  secret: string,
  token: string,
  now = Date.now(),
): Promise<VerifiedToken | null> => {
  const [prefix, payload, signature, extra] = token.split(".");
  if (prefix !== PREFIX || !payload || !signature || extra !== undefined) {
    return null;
  }
  const given = fromBase64url(signature);
  if (!given || !constantTimeEqual(given, await hmac(secret, `${PREFIX}.${payload}`))) {
    return null;
  }
  const bytes = fromBase64url(payload);
  if (!bytes) {
    return null;
  }
  let claims: { u?: string; e?: number };
  try {
    claims = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const { u, e } = claims;
  if (String(u) !== u || u.length === 0 || !Number.isFinite(e) || Number(e) <= now) {
    return null;
  }
  return { expiresAt: Number(e), userId: u };
};
