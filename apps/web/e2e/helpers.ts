import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Shared interaction helpers for the hydration boundary.
 *
 * Every page here is server-rendered by TanStack Start and becomes visible —
 * and typeable — before React mounts. Text typed into that window is discarded
 * when React attaches its controlled inputs, which shows up downstream as a
 * submit button that never enables or a form that submits empty. These helpers
 * absorb that race so the specs can read as plain user journeys.
 */

/** Navigate and wait for the page's own JS to settle before interacting. */
export const goto = async (page: Page, path: string): Promise<void> => {
  await page.goto(path, { waitUntil: "networkidle" });
};

/**
 * Fill a field and confirm the value survived hydration, refilling if it did
 * not. Use this instead of `locator.fill` for anything that drives React state.
 */
export const fillStable = async (locator: Locator, value: string): Promise<void> => {
  await expect(async () => {
    await locator.fill(value);
    await expect(locator).toHaveValue(value, { timeout: 1_000 });
  }).toPass({ timeout: 30_000, intervals: [200, 500, 1_000] });
};

/** A toast by its text — the app's confirmation channel for every mutation. */
export const toast = (page: Page, text: string | RegExp): Locator =>
  page.locator("[data-sonner-toast]").filter({ hasText: text });

/**
 * Mint a real CLI device code through the public tRPC endpoint, so the
 * `/auth/cli` spec confirms an actual pending login instead of an error page.
 */
export const createCliCode = async (page: Page): Promise<string> => {
  const response = await page.request.post("/api/trpc/auth.cliInit", {
    headers: { "content-type": "application/json" },
    data: {},
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result: { data: { json: { code: string } } } };
  return body.result.data.json.code;
};
