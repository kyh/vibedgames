import { expect, test } from "@playwright/test";

import { fillStable, goto } from "./helpers";

/**
 * `/settings` — create and revoke an API key.
 *
 * Covers the `apiKey.create` and `apiKey.revoke` mutations and, importantly,
 * that each one invalidates the key list it just changed. The repo has no
 * blanket query invalidation, so a missing `onSuccess` invalidation shows up
 * as a list that never refreshes — invisible to a unit test, obvious here.
 */
test("create then revoke an API key", async ({ page }) => {
  const name = `e2e-${Date.now()}`;

  await goto(page, "/settings");

  await fillStable(page.getByLabel("Key name"), name);
  await page.getByRole("button", { name: "Create key" }).click();

  // The secret is shown exactly once, on creation.
  await expect(page.getByText("Copy your key now")).toBeVisible();

  const row = page.locator("li").filter({ hasText: name });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toHaveCount(0);
});

test("the create button stays disabled without a name", async ({ page }) => {
  await goto(page, "/settings");
  await expect(page.getByRole("button", { name: "Create key" })).toBeDisabled();
});
