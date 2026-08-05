import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end coverage for the web app's mutation flows.
 *
 * Two ways to run, same specs:
 *
 *   pnpm test:e2e                        against a local `pnpm dev:web`
 *   E2E_BASE_URL=https://pr-12-… \       against a deployed preview
 *     E2E_CDP_URL=… pnpm test:e2e        driven by Cloudflare Browser Run
 *
 * `E2E_CDP_URL` routes the browser to Browser Run over CDP instead of
 * launching one locally, so CI needs no browser download. Unset, Playwright
 * launches its own Chromium — which is what makes these runnable on a laptop.
 */

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const cdpUrl = process.env.E2E_CDP_URL;

// Escape hatch for environments that already ship a Chromium whose revision
// does not match this Playwright version (sandboxes, prebuilt CI images).
// CI installs its own browser and leaves this unset.
const chromiumPath = process.env.E2E_CHROMIUM_PATH;

// Only manage a dev server when pointed at the default local target. Against a
// deployed preview there is nothing to start.
const isLocal = !process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  // These flows mutate shared server state (invite codes, users, games), so
  // they run serially rather than racing each other through one database.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(cdpUrl ? { connectOptions: { wsEndpoint: cdpUrl } } : {}),
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },

  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "user",
      testMatch: /.*\.user\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/user.json" },
    },
    {
      name: "admin",
      testMatch: /.*\.admin\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/admin.json" },
    },
    {
      name: "anon",
      testMatch: /.*\.anon\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  ...(isLocal
    ? {
        webServer: {
          command: "pnpm --filter @repo/web dev",
          url: "http://localhost:5173/auth/login",
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          cwd: "../..",
        },
      }
    : {}),
});
