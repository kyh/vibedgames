import { bindings, defineConfig, triggers } from "cf/config";

const secrets = {
  BETTER_AUTH_SECRET: bindings.secret(),
  FAL_API_KEY: bindings.secret(),
  TYPESAFE_API_KEY: bindings.secret(),
};

const stripeSecrets = {
  STRIPE_SECRET_KEY: bindings.secret(),
  STRIPE_WEBHOOK_SECRET: bindings.secret(),
};

const socialSecrets = {
  GITHUB_CLIENT_ID: bindings.secret(),
  GITHUB_CLIENT_SECRET: bindings.secret(),
  GOOGLE_CLIENT_ID: bindings.secret(),
  GOOGLE_CLIENT_SECRET: bindings.secret(),
  OAUTH_PROXY_SECRET: bindings.secret(),
};

const openaiSecrets = {
  OPENAI_APPS_CHALLENGE: bindings.secret(),
};

const emailSecrets = {
  RESEND_API_KEY: bindings.secret(),
};

const optionalSecrets = { ...stripeSecrets, ...socialSecrets, ...openaiSecrets, ...emailSecrets };

// WARNING: a Preview binds only preview D1/R2; never let it reach the prod database or bucket.
const previewEnv = {
  ...secrets,
  DB: bindings.d1({ name: "vibedgames-preview" }),
  GAMES_BUCKET: bindings.r2({ name: "vibedgames-games-preview" }),
  OAUTH_PROXY_URL: bindings.text("https://www.vibedgames.com"),
  PRODUCTION_URL: bindings.text(""),
};

const productionEnv = {
  ...secrets,
  DB: bindings.d1({ id: "8aba7674-bee1-4532-b5f0-36243172cf81", name: "vibedgames" }),
  GAMES_BUCKET: bindings.r2({ name: "vibedgames-games" }),
  OAUTH_PROXY_URL: bindings.text("https://www.vibedgames.com"),
  PRODUCTION_URL: bindings.text("https://www.vibedgames.com"),
};

export default defineConfig(({ isPreview, mode }) => {
  const base = isPreview ? previewEnv : productionEnv;

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
      // WARNING: a Preview must not claim the production hostnames.
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
