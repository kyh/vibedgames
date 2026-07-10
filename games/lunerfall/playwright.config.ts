import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  // WebGL games: parallel headless contexts share the software rasterizer and
  // drift game time from wall time — never raise this (see the playwright
  // skill's bot-playtest reference).
  workers: 1,
  use: { baseURL: "http://localhost:5199" },
  webServer: {
    command: "pnpm dev --port 5199 --strictPort",
    url: "http://localhost:5199",
    reuseExistingServer: true,
  },
});
