import { z } from "zod";

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

const tokenClaims = z.object({ e: z.number(), u: z.string().min(1) });

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");

const fromBase64url = (text: string) => {
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

const hmacKey = async (secret: string) =>
  await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );

const hmac = async (secret: string, message: string) =>
  new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(message)),
  );

const hmacMatches = async (secret: string, message: string, signature: Uint8Array<ArrayBuffer>) =>
  await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    new TextEncoder().encode(message),
  );

export interface MintedToken {
  token: string;
  expiresAt: number;
}

export const mintPlaytestToken = async (secret: string, userId: string, now = Date.now()) => {
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
export const verifyPlaytestToken = async (secret: string, token: string, now = Date.now()) => {
  const [prefix, payload, signature, extra] = token.split(".");

  if (
    prefix !== PREFIX ||
    payload === undefined ||
    payload === "" ||
    signature === undefined ||
    signature === "" ||
    extra !== undefined
  ) {
    return null;
  }

  const given = fromBase64url(signature);

  if (!given || !(await hmacMatches(secret, `${PREFIX}.${payload}`, given))) {
    return null;
  }

  const bytes = fromBase64url(payload);

  if (!bytes) {
    return null;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }

  const claims = tokenClaims.safeParse(raw);

  if (!claims.success || claims.data.e <= now) {
    return null;
  }

  return { expiresAt: claims.data.e, userId: claims.data.u };
};
