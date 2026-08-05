import { expect, test } from "@playwright/test";

import { fillStable, goto } from "./helpers";

/**
 * `/admin` → invites section — create and revoke an invite code.
 *
 * Exercises `admin.createInvites` and `admin.updateInvite`. A custom code keeps
 * the assertion exact: generated codes are random, so a spec that created one
 * would have to guess which row it just made.
 */

/** Six uppercase alphanumerics, unique per run — the code column is unique. */
const uniqueCode = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    { length: 6 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join("");
};

test("create then revoke an invite code", async ({ page }) => {
  const code = uniqueCode();

  await goto(page, "/admin");

  await fillStable(page.getByLabel("Custom code (optional)"), code);
  await fillStable(page.getByLabel("Note"), "e2e");
  await page.getByRole("button", { name: "Generate" }).click();

  const row = page.locator("li").filter({ hasText: code });
  await expect(row).toBeVisible();
  await expect(row.getByText("available")).toBeVisible();

  await row.getByRole("button", { name: "Revoke" }).click();

  // Revoking flips status in place rather than removing the row, and swaps the
  // action to Unrevoke — so this asserts the list actually refetched.
  await expect(row.getByText("revoked")).toBeVisible();
  await expect(row.getByRole("button", { name: "Unrevoke" })).toBeVisible();
});
