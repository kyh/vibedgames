import { expect, test as setup } from "@playwright/test";

import { fillStable, goto } from "./helpers";

/**
 * Signs in through the real form once per role and saves the resulting cookies
 * for the other specs. This doubles as coverage of the login flow itself — if
 * sign-in breaks, every project fails at setup with an obvious message rather
 * than each spec failing on a redirect.
 *
 * Credentials come from `packages/db/seed.sql`, applied by `pnpm db:local`
 * locally and by the preview workflow against the preview database.
 */

export const USER_STATE = "e2e/.auth/user.json";
export const ADMIN_STATE = "e2e/.auth/admin.json";

const signIn = async (
  page: import("@playwright/test").Page,
  email: string,
  storagePath: string,
) => {
  await goto(page, "/auth/login");

  // The two credential fields carry data-test hooks precisely because
  // positional selectors are unreliable on this react-hook-form form.
  await fillStable(page.locator('[data-test="email-input"]'), email);
  await fillStable(page.locator('[data-test="password-input"]'), "password123");

  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL("**/home", { timeout: 30_000 });

  await page.context().storageState({ path: storagePath });
};

setup("sign in as a regular user", async ({ page }) => {
  await signIn(page, "user@vibedgames.com", USER_STATE);
});

setup("sign in as an admin", async ({ page }) => {
  await signIn(page, "admin@vibedgames.com", ADMIN_STATE);

  // The admin project depends on the role gate letting this account through;
  // fail here with a clear message rather than midway through an admin spec.
  // Checked over HTTP without following redirects — a non-admin session gets a
  // redirect to /home, which a browser navigation would silently absorb.
  const response = await page.request.get("/admin", { maxRedirects: 0 });
  expect(
    response.status(),
    "seeded admin@vibedgames.com should reach /admin — is the role still set?",
  ).toBe(200);
});
