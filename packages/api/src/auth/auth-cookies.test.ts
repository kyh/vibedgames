import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDb } from "@repo/db/drizzle-client";

import { createAuth } from "./auth";

/**
 * Two cookie attributes carry load no other gate can see, because typecheck,
 * lint and build accept any valid value for either:
 *
 *   sameSite — the whole cross-site defense for `/api/orpc`. No CSRF token is
 *     issued and the route serves no CORS headers, so a forged cross-site POST
 *     is harmless only while the browser refuses to attach this cookie to it.
 *   domain — unset keeps the cookie host-only. User games run untrusted code on
 *     `{slug}.vibedgames.com`; a cookie scoped to the parent domain would be
 *     handed to every one of them.
 *
 * Read the *resolved* attributes rather than the config literal: a plugin,
 * `crossSubDomainCookies`, or a better-auth default decides these too, and
 * asserting the literal against itself would prove nothing.
 */

const unavailable = (): never => {
  throw new Error("the database is not reachable in this test");
};

const auth = createAuth({
  db: createDb({
    prepare: unavailable,
    batch: unavailable,
    exec: unavailable,
    withSession: unavailable,
    dump: unavailable,
  }),
  baseURL: "https://vibedgames.com",
  secret: "test-secret",
});

describe("session cookie", () => {
  test("is SameSite Lax or Strict, never None", async () => {
    const { authCookies } = await auth.$context;
    const sameSite = String(authCookies.sessionToken.attributes.sameSite).toLowerCase();

    assert.ok(
      sameSite === "lax" || sameSite === "strict",
      `session cookie sameSite must be lax or strict, got ${sameSite}`,
    );
  });

  test("is host-only, so untrusted game subdomains never receive it", async () => {
    const { authCookies } = await auth.$context;

    assert.strictEqual(authCookies.sessionToken.attributes.domain, undefined);
  });
});
