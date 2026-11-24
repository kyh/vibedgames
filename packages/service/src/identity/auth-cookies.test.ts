import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDb } from "@repo/db/drizzle-client";

import { createAuth } from "./auth";

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
