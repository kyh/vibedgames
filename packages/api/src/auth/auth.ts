import type { Db } from "@repo/db/drizzle-client";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, bearer, oAuthProxy } from "better-auth/plugins";

import { claimInviteCode } from "./invite-claim";

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
      bearer(),
      expo(),
      admin(),
    ],
    emailAndPassword: {
      enabled: true,
    },
    user: {
      // Stamps the redeemed invite code on the new user row. `input: false`
      // prevents the field from being populated by client request bodies —
      // it's only writable from the user-create hook below.
      additionalFields: {
        invitedByCode: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Gate signup behind an invite code while the platform is in
          // early preview. Only enforced on the public email sign-up path —
          // admin-initiated user creation (`/admin/create-user`) is exempt
          // so admins can mint accounts without burning a code.
          before: async (user, ctx) => {
            if (ctx?.path !== "/sign-up/email") {
              return { data: user };
            }
            const code = await claimInviteCode(db, ctx.body?.inviteCode);
            return { data: { ...user, invitedByCode: code } };
          },
        },
      },
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
