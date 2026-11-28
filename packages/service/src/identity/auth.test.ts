import assert from "node:assert/strict";
import { test } from "node:test";

import type { Email } from "../email/mailer";
import { startD1 } from "../d1.test-utils";
import type { ReviewerSignIn } from "./reviewer-sign-in";
import { createAuth } from "./auth";
import { reviewerSignInOf } from "./reviewer-sign-in";

const EMAIL = "player@example.com";

const withAuth = async (
  run: (auth: ReturnType<typeof createAuth>, sent: Email[]) => Promise<void>,
  { mails = true, reviewer }: { mails?: boolean; reviewer?: ReviewerSignIn } = {},
) => {
  const d1 = await startD1();
  const sent: Email[] = [];

  try {
    const auth = createAuth({
      baseURL: "https://vibedgames.com",
      db: d1.db,
      mailer: mails
        ? async (email) => {
            sent.push(email);
            await Promise.resolve();
          }
        : undefined,
      reviewer,
      secret: "test-secret-test-secret-test-secret",
    });

    await run(auth, sent);
  } finally {
    await d1.close();
  }
};

const codeIn = (email: Email | undefined) =>
  /\b(?<code>\d{6})\b/u.exec(email?.text ?? "")?.groups?.code;

test("without a mailer, sending a sign-in code is refused", async () => {
  await withAuth(
    async (auth) => {
      await assert.rejects(
        auth.api.sendVerificationOTP({ body: { email: EMAIL, type: "sign-in" } }),
        {
          body: {
            code: "EMAIL_DISABLED",
            message: "Sign-in by email is unavailable: this site sends no email.",
          },
        },
      );
    },
    { mails: false },
  );
});

test("an emailed sign-in code signs a new address up, confirmed", async () => {
  await withAuth(async (auth, sent) => {
    await auth.api.sendVerificationOTP({ body: { email: EMAIL, type: "sign-in" } });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, EMAIL);
    const otp = codeIn(sent[0]);
    assert.ok(otp !== undefined);

    const { user } = await auth.api.signInEmailOTP({ body: { email: EMAIL, name: "player", otp } });

    assert.equal(user.email, EMAIL);
    assert.equal(user.emailVerified, true);
  });
});

test("a code's sign-in from another site is refused, and from this one goes through", async () => {
  await withAuth(async (auth, sent) => {
    await auth.api.sendVerificationOTP({ body: { email: EMAIL, type: "sign-in" } });
    const otp = codeIn(sent[0]);
    assert.ok(otp !== undefined);

    const signInFrom = async (origin: string) =>
      await auth.handler(
        new Request("https://vibedgames.com/api/auth/sign-in/email-otp", {
          body: JSON.stringify({ email: EMAIL, otp }),
          headers: { "content-type": "application/json", origin },
          method: "POST",
        }),
      );

    const foreign = await signInFrom("https://attacker.example");
    assert.equal(foreign.status, 403);

    const own = await signInFrom("https://vibedgames.com");
    assert.equal(own.status, 200);
  });
});

test("password-reset codes are never sent", async () => {
  await withAuth(async (auth, sent) => {
    await auth.api.sendVerificationOTP({ body: { email: EMAIL, type: "forget-password" } });

    assert.equal(sent.length, 0);
  });
});

test("password sign-up is off", async () => {
  await withAuth(async (auth) => {
    await assert.rejects(
      auth.api.signUpEmail({ body: { email: EMAIL, name: "player", password: "password123" } }),
    );
  });
});

const REVIEWER = { code: "246813", email: "review-k3j9@example.com" };

test("the reviewer signs in with the fixed code and is never emailed", async () => {
  await withAuth(
    async (auth, sent) => {
      await auth.api.sendVerificationOTP({
        body: { email: "Review-K3J9@example.com", type: "sign-in" },
      });

      assert.equal(sent.length, 0);

      const { user } = await auth.api.signInEmailOTP({
        body: { email: REVIEWER.email, name: "reviewer", otp: REVIEWER.code },
      });

      assert.equal(user.email, REVIEWER.email);
    },
    { reviewer: REVIEWER },
  );
});

test("everyone else still gets a random emailed code, never the reviewer's", async () => {
  await withAuth(
    async (auth, sent) => {
      await auth.api.sendVerificationOTP({ body: { email: EMAIL, type: "sign-in" } });

      assert.equal(sent.length, 1);
      assert.notEqual(codeIn(sent[0]), REVIEWER.code);

      await assert.rejects(
        auth.api.signInEmailOTP({ body: { email: EMAIL, name: "player", otp: REVIEWER.code } }),
      );
    },
    { reviewer: REVIEWER },
  );
});

test("a reviewer sign-in needs both halves, well-formed", () => {
  assert.deepEqual(reviewerSignInOf("Review@Example.com", "123456"), {
    code: "123456",
    email: "review@example.com",
  });
  assert.equal(reviewerSignInOf("review@example.com", undefined), undefined);
  assert.equal(reviewerSignInOf(undefined, "123456"), undefined);
  assert.equal(reviewerSignInOf("review@example.com", "12345a"), undefined);
  assert.equal(reviewerSignInOf("not-an-email", "123456"), undefined);
});
