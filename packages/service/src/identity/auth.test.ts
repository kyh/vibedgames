import assert from "node:assert/strict";
import { test } from "node:test";

import { startD1 } from "../d1.test-utils";
import { createAuth } from "./auth";

test("without a mailer a password reset is refused", async () => {
  const d1 = await startD1();

  try {
    const auth = createAuth({
      baseURL: "https://vibedgames.com",
      db: d1.db,
      secret: "test-secret",
    });

    await assert.rejects(
      auth.api.requestPasswordReset({
        body: { email: "player@example.com", redirectTo: "/auth/password-update" },
      }),
      { body: { code: "RESET_PASSWORD_DISABLED", message: "Reset password isn't enabled" } },
    );
  } finally {
    await d1.close();
  }
});
