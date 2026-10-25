import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDb } from "@repo/db/drizzle-client";
import { getCookies } from "better-auth/cookies";

import { createAuth } from "./auth";

/**
 * Two cookie attributes carry load no other gate can see, because typecheck,
 * lint and build accept any valid value for either:
 *
 *   sameSite — the cross-SITE half of the defense for `/api/orpc`. No CSRF
 *     token is issued and the route serves no CORS headers, so a forged
 *     cross-site POST is harmless only while the browser refuses to attach
 *     this cookie to it. The same-site cross-origin POST that `SameSite` does
 *     let through is the origin check's job (apps/web/src/lib/orpc-handler.ts).
 *   domain — unset keeps the cookie host-only. User games run untrusted code on
 *     `{slug}.vibedgames.com`; a cookie scoped to the parent domain would be
 *     handed to every one of them.
 *
 * Read the *resolved* attributes rather than the config literal:
 * `crossSubDomainCookies` or a better-auth default decides these too, and
 * asserting the literal against itself would prove nothing. `getCookies` is
 * the resolver the auth context itself runs; resolving the whole context
 * would also run the OAuth plugin's resource seed against the database.
 */

const unavailable = (): never => {
  throw new Error("the database is not reachable in this test");
};

const auth = createAuth({
  baseURL: "https://vibedgames.com",
  db: createDb({
    batch: unavailable,
    dump: unavailable,
    exec: unavailable,
    prepare: unavailable,
    withSession: unavailable,
  }),
  secret: "test-secret",
});
// The OAuth plugin seeds its resource rows at init, which this database refuses.
auth.$context.catch(() => null);

describe("session cookie", () => {
  test("is SameSite Lax or Strict, never None", () => {
    const authCookies = getCookies(auth.options);
    const sameSite = String(authCookies.sessionToken.attributes.sameSite).toLowerCase();

    assert.ok(
      sameSite === "lax" || sameSite === "strict",
      `session cookie sameSite must be lax or strict, got ${sameSite}`,
    );
  });

  test("is host-only, so untrusted game subdomains never receive it", () => {
    const authCookies = getCookies(auth.options);

    assert.strictEqual(authCookies.sessionToken.attributes.domain, undefined);
  });
});
