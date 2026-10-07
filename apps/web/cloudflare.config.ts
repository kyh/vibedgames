import { bindings, defineConfig, triggers } from "cf/config";

// Locally the secrets come from the repo-root `.env` (process.env, loaded by `with-env`): declaring
// them here is what folds process.env into the Worker binding, filtered to these names.
const secrets = {
  BETTER_AUTH_SECRET: bindings.secret(),
  FAL_API_KEY: bindings.secret(),
  R2_ACCESS_KEY_ID: bindings.secret(),
  R2_ACCOUNT_ID: bindings.secret(),
  R2_SECRET_ACCESS_KEY: bindings.secret(),
  // Credit purchases (packages/service/src/credits/stripe.ts). A Preview takes Stripe's test-mode keys.
  STRIPE_SECRET_KEY: bindings.secret(),
  STRIPE_WEBHOOK_SECRET: bindings.secret(),
  TYPESAFE_API_KEY: bindings.secret(),
};

// A Preview binds preview-only resources, so a PR can never write the prod D1 or bucket
// (.github/workflows/preview.yml creates them). Its secrets are preview values, set once.
const previewEnv = {
  ...secrets,
  DB: bindings.d1({ name: "vibedgames-preview" }),
  GAMES_BUCKET: bindings.r2({ name: "vibedgames-games-preview" }),
  // empty so auth takes its base URL from the Preview's own host
  PRODUCTION_URL: bindings.text(""),
  R2_BUCKET_NAME: bindings.text("vibedgames-games-preview"),
};

const productionEnv = {
  ...secrets,
  DB: bindings.d1({ id: "8aba7674-bee1-4532-b5f0-36243172cf81", name: "vibedgames" }),
  GAMES_BUCKET: bindings.r2({ name: "vibedgames-games" }),
  PRODUCTION_URL: bindings.text("https://vibedgames.com"),
  R2_BUCKET_NAME: bindings.text("vibedgames-games"),
};

export default defineConfig(({ isPreview }) => ({
  worker: {
    compatibilityDate: "2026-04-12",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "@tanstack/react-start/server-entry",
    env: isPreview ? previewEnv : productionEnv,
    name: "vibedgames-web",
    observability: { enabled: true },
    // a Preview must not claim the production hostnames
    triggers: isPreview
      ? []
      : [
          triggers.fetch({ pattern: "vibedgames.com/*", zone: "vibedgames.com" }),
          triggers.fetch({ pattern: "www.vibedgames.com/*", zone: "vibedgames.com" }),
        ],
    workersDev: true,
  },
}));
