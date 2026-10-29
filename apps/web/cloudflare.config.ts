import { bindings, defineConfig, triggers } from "cf/config";

// Locally the secrets come from the repo-root `.env` (process.env, loaded by `with-env`): declaring
// them here is what folds process.env into the Worker binding, filtered to these names.
const secrets = {
  BETTER_AUTH_SECRET: bindings.secret(),
  FAL_API_KEY: bindings.secret(),
  TYPESAFE_API_KEY: bindings.secret(),
};

// Credit purchases (packages/service/src/credits/stripe.ts) are optional: until both keys are set,
// purchases stay off and Settings offers codes only. A deploy requires every secret it declares,
// so a production build leaves these out; one set later with `cf workers secrets update` binds anyway,
// and deploys keep it. `vite dev` declares them to fold `.env` in.
const stripeSecrets = {
  STRIPE_SECRET_KEY: bindings.secret(),
  STRIPE_WEBHOOK_SECRET: bindings.secret(),
};

// Social sign-in (packages/service/src/auth/auth.ts) is optional the same way: a provider's button
// appears once both its client id and secret are set. Callback URL for each provider's app:
// https://vibedgames.com/api/auth/callback/{github,google}. A Preview signs in through it via
// oAuthProxy, which hands the Preview the profile encrypted with OAUTH_PROXY_SECRET: set the same
// value on production and in the preview base config, so a Preview never holds production's
// BETTER_AUTH_SECRET.
const socialSecrets = {
  GITHUB_CLIENT_ID: bindings.secret(),
  GITHUB_CLIENT_SECRET: bindings.secret(),
  GOOGLE_CLIENT_ID: bindings.secret(),
  GOOGLE_CLIENT_SECRET: bindings.secret(),
  OAUTH_PROXY_SECRET: bindings.secret(),
};

const optionalSecrets = { ...stripeSecrets, ...socialSecrets };

// A Preview binds preview-only resources, so a PR can never write the prod D1 or bucket
// (.github/workflows/preview.yml creates them). Its secrets are preview values, set once.
const previewEnv = {
  ...secrets,
  DB: bindings.d1({ name: "vibedgames-preview" }),
  GAMES_BUCKET: bindings.r2({ name: "vibedgames-games-preview" }),
  // the provider callbacks are registered on production, so social sign-in proxies through it
  OAUTH_PROXY_URL: bindings.text("https://vibedgames.com"),
  // empty so auth takes its base URL from the Preview's own host
  PRODUCTION_URL: bindings.text(""),
};

const productionEnv = {
  ...secrets,
  DB: bindings.d1({ id: "8aba7674-bee1-4532-b5f0-36243172cf81", name: "vibedgames" }),
  GAMES_BUCKET: bindings.r2({ name: "vibedgames-games" }),
  OAUTH_PROXY_URL: bindings.text("https://vibedgames.com"),
  PRODUCTION_URL: bindings.text("https://vibedgames.com"),
};

export default defineConfig(({ isPreview, mode }) => {
  const base = isPreview ? previewEnv : productionEnv;
  // One shape in every mode keeps the generated Env stable. It types the optional keys as strings
  // though a production Worker may lack them; only optional config fields read them.
  const env: typeof base & Partial<typeof optionalSecrets> =
    mode === "production" ? base : { ...base, ...optionalSecrets };
  return {
    worker: {
      compatibilityDate: "2026-04-12",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "@tanstack/react-start/server-entry",
      env,
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
  };
});
