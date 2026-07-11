import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 180_000,
  // WebGL games: parallel headless contexts share the software rasterizer and
  // drift game time from wall time — never raise this.
  workers: 1,
  use: { baseURL: "http://localhost:5198" },
  webServer: {
    command: "pnpm dev --port 5198 --strictPort",
    url: "http://localhost:5198",
    reuseExistingServer: !process.env.CI,
  },
});
