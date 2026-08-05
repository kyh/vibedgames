import { expect, test } from "@playwright/test";

import { createCliCode, goto } from "./helpers";

/**
 * `/auth/cli?code=…` — confirm a CLI device code.
 *
 * This is the browser half of `vg login`: the CLI mints a code via
 * `auth.cliInit` and polls, the user confirms it here, and the confirmation
 * hands the CLI a session token. The mutation fires on mount, so there is no
 * button to press — landing on the page with a live code IS the action.
 *
 * The spec mints a real code through the public endpoint rather than asserting
 * on the error page, so it covers the success path the CLI actually depends on.
 */
test("confirming a live device code connects the CLI", async ({ page }) => {
  const code = await createCliCode(page);

  await goto(page, `/auth/cli?code=${code}`);

  await expect(page.getByRole("heading", { name: "Successfully connected" })).toBeVisible({
    timeout: 20_000,
  });
});

test("an unknown device code reports a failure rather than connecting", async ({ page }) => {
  await goto(page, "/auth/cli?code=ZZZZZZ");

  await expect(page.getByRole("heading", { name: "Couldn't connect the CLI" })).toBeVisible({
    timeout: 20_000,
  });
});

test("visiting without a code explains what to run", async ({ page }) => {
  await goto(page, "/auth/cli");

  await expect(page.getByRole("heading", { name: "Invalid request" })).toBeVisible();
  await expect(page.getByText("vg login")).toBeVisible();
});
