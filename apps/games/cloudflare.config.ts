import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    compatibilityDate: "2025-04-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "./src/index.ts",
    env: {
      DB: bindings.d1({ id: "8aba7674-bee1-4532-b5f0-36243172cf81", name: "vibedgames" }),
      GAMES_BUCKET: bindings.r2({ name: "vibedgames-games" }),
    },
    name: "vibedgames-games",
    observability: { enabled: true },
    triggers: [triggers.fetch({ pattern: "*.vibedgames.com/*", zone: "vibedgames.com" })],
    workersDev: true,
  },
});
