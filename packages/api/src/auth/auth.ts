import type { Db } from "@repo/db/drizzle-client";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, oAuthProxy } from "better-auth/plugins";

export type AuthOptions = {
  db: Db;
  baseURL: string;
  secret: string;
  productionURL?: string;
  trustedOrigins?: string[];
};

export const createAuth = (opts: AuthOptions) => {
  const { db, baseURL, secret, productionURL = baseURL } = opts;

  const auth = betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
    }),
    baseURL,
    secret,
    plugins: [
      oAuthProxy({
        currentURL: baseURL,
        productionURL,
      }),
      expo(),
      admin(),
    ],
    emailAndPassword: {
      enabled: true,
    },
    trustedOrigins: opts.trustedOrigins ?? ["expo://"],
  });

  return auth;
};

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];

/**
 * Static auth instance for `@better-auth/cli generate` introspection.
 *
 * The CLI needs a module-level betterAuth() to analyze the plugin set and
 * derive the schema. This uses a no-op adapter — it's never used at runtime.
 */
export const auth = betterAuth({
  database: { provider: "sqlite", type: "sqlite" } as never,
  plugins: [oAuthProxy(), expo(), admin()],
  emailAndPassword: { enabled: true },
});
