import assert from "node:assert/strict";
import { test } from "node:test";

import { EMAIL_FROM, resendMailer } from "./mailer";
import { passwordResetEmail } from "./templates";

const recorder = (response: Response) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ init, url: String(input) });

    return Promise.resolve(response);
  };

  return { calls, fetch };
};

test("resendMailer posts one message from the verified sender", async () => {
  const { calls, fetch } = recorder(Response.json({ id: "email-1" }));
  await resendMailer({ apiKey: "re_test", fetch })({
    html: "<p>hi</p>",
    subject: "Hi",
    text: "hi",
    to: "player@example.com",
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call?.url, "https://api.resend.com/emails");
  assert.equal(new Headers(call?.init?.headers).get("authorization"), "Bearer re_test");
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    from: EMAIL_FROM,
    html: "<p>hi</p>",
    subject: "Hi",
    text: "hi",
    to: ["player@example.com"],
  });
});

test("resendMailer throws Resend's refusal so the request fails loudly", async () => {
  const { fetch } = recorder(new Response('{"message":"bad from"}', { status: 403 }));
  await assert.rejects(
    resendMailer({ apiKey: "re_test", fetch })({ html: "", subject: "", text: "", to: "a@b.c" }),
    /Resend refused the email \(403\): .*bad from/u,
  );
});

test("the reset email carries the link, escaped in HTML", () => {
  const url = "https://vibedgames.com/api/auth/reset-password/tok?callbackURL=/a&b=<x>";
  const email = passwordResetEmail(url);
  assert.ok(email.text.includes(url));
  assert.ok(email.html.includes("callbackURL=/a&amp;b=&lt;x&gt;"));
  assert.ok(!email.html.includes("<x>"));
});
