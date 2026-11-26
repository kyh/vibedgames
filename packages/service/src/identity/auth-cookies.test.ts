import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { startD1 } from "../d1.test-utils";

import { createAuth } from "./auth";

const d1 = await startD1();

after(d1.close);

const auth = createAuth({ baseURL: "https://vibedgames.com", db: d1.db, secret: "test-secret" });

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
