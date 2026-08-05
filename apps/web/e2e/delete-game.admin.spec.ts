import { expect, test } from "@playwright/test";

import { goto, toast } from "./helpers";

/**
 * `/home` — delete a game.
 *
 * The destructive flow: a confirm dialog gates `deploy.delete`, which takes the
 * game offline and clears its R2 prefix. Runs against the seeded games on the
 * admin account (`packages/db/seed.sql`), which the preview workflow re-seeds
 * on every deploy — so a deleted row comes back on the next run.
 */
test("delete a game behind its confirmation dialog", async ({ page }) => {
  await goto(page, "/home");

  const deleteButtons = page.getByRole("button", { name: /^Delete / });
  const count = await deleteButtons.count();
  test.skip(count === 0, "no games on this account to delete — re-run pnpm db:seed-local");

  // The button's accessible name carries the game name, which is also the row
  // label — capture it so we can assert that exact row disappears.
  const target = deleteButtons.first();
  const label = await target.getAttribute("aria-label");
  expect(label).toBeTruthy();
  const gameName = (label ?? "").replace(/^Delete /, "");

  await target.click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("There is no undo.");

  await dialog.getByRole("button", { name: "Delete" }).click();

  await expect(toast(page, "Game deleted")).toBeVisible();
  await expect(page.getByRole("button", { name: `Delete ${gameName}` })).toHaveCount(0);
});

test("cancelling the dialog leaves the game alone", async ({ page }) => {
  await goto(page, "/home");

  const deleteButtons = page.getByRole("button", { name: /^Delete / });
  const before = await deleteButtons.count();
  test.skip(before === 0, "no games on this account to delete — re-run pnpm db:seed-local");

  await deleteButtons.first().click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  await expect(dialog).toBeHidden();
  await expect(deleteButtons).toHaveCount(before);
});
