import { expect, test } from "@playwright/test";

import { fillStable, goto, toast } from "./helpers";

/**
 * `/admin` → users section — create a user, then grant them credits.
 *
 * The grant is the interesting half: it writes to the append-only credit
 * ledger and the success toast reports the resulting balance, so this asserts
 * the money path end-to-end through the UI. A brand-new account has the $20
 * signup grant materialized on first credit access, so granting $5 must land
 * at exactly $25.00 — a number that only comes out right if the lazy signup
 * grant, the admin grant, and the balance sum all agree.
 */
test("create a user and grant them credits", async ({ page }) => {
  const stamp = Date.now();
  const email = `e2e-${stamp}@example.test`;

  await goto(page, "/admin");

  await fillStable(page.getByLabel("Name"), `e2e ${stamp}`);
  await fillStable(page.getByLabel("Email"), email);
  await fillStable(page.getByLabel("Password"), "password123");
  await page.getByRole("button", { name: "Create user" }).click();

  await expect(toast(page, "User created")).toBeVisible();

  const row = page.locator("li").filter({ hasText: email });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Grant credits" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await fillStable(dialog.getByLabel("Amount (USD)"), "5");
  await fillStable(dialog.getByLabel("Note (optional)"), "e2e grant");
  await dialog.getByRole("button", { name: "Grant" }).click();

  await expect(toast(page, "Credits updated — new balance $25.00")).toBeVisible();
});
