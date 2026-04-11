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
    // Keep the session cookie host-only so user-uploaded games served from
    // `{slug}.vibedgames.com` never see it. We explicitly DO NOT enable
    // crossSubDomainCookies — the platform domain hosts untrusted code.
    advanced: {
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: true,
      },
    },
  });

  return auth;
};

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
