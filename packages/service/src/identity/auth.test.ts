import assert from "node:assert/strict";
import { test } from "node:test";
import { createDb } from "@repo/db/drizzle-client";

import { createAuth } from "./auth";

const unavailable = (): never => {
  throw new Error("the database is not reachable in this test");
};

test("without a mailer a password reset is refused before any account is looked up", async () => {
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

  await assert.rejects(
    auth.api.requestPasswordReset({
      body: { email: "player@example.com", redirectTo: "/auth/password-update" },
    }),
    { body: { code: "RESET_PASSWORD_DISABLED", message: "Reset password isn't enabled" } },
  );
});
