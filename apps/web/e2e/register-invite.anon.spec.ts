import { expect, test } from "@playwright/test";

import { goto } from "./helpers";

/**
 * `/auth/register` — validate an invite code.
 *
 * Registration is invite-gated: the OTP field calls `auth.validateInvite` on
 * the sixth character and only reveals the account form once the code checks
 * out. `DEV123` is the seeded unlimited-use code.
 */
test("a valid invite code unlocks the account form", async ({ page }) => {
  await goto(page, "/auth/register");

  const otp = page.locator('[data-test="invite-code-input"]');
  await expect(otp).toBeVisible();

  // The OTP component is a set of single-character cells driven by keystrokes,
  // so type the code rather than filling a single value.
  await otp.click();
  await page.keyboard.type("DEV123", { delay: 50 });

  // Validation success swaps the invite step for the credential fields.
  await expect(page.locator('[data-test="email-input"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-test="password-input"]')).toBeVisible();
});

test("a bogus invite code does not unlock the form", async ({ page }) => {
  await goto(page, "/auth/register");

  const otp = page.locator('[data-test="invite-code-input"]');
  await expect(otp).toBeVisible();

  await otp.click();
  await page.keyboard.type("ZZZZZZ", { delay: 50 });

  // Give the mutation time to come back before asserting the absence.
  await page.waitForTimeout(3_000);
  await expect(page.locator('[data-test="email-input"]')).toHaveCount(0);
});
