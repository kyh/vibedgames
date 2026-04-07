import type { User } from "better-auth";
import type { Db } from "@repo/db/drizzle-client";
import { eq } from "@repo/db";
import { user as userSchema } from "@repo/db/drizzle-schema-auth";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, oAuthProxy, organization } from "better-auth/plugins";

import { slugify } from "./utils";

export type AuthOptions = {
  db: Db;
  baseURL: string;
  secret: string;
  productionURL?: string;
  trustedOrigins?: string[];
};

/**
 * Create a better-auth instance bound to a specific D1-backed Drizzle client.
 *
 * Cloudflare Workers do not have a long-lived module scope safe for DB
 * handles, so auth (like the db client) is constructed per-request inside
 * the request handler / tRPC context.
 */
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
      organization(),
      admin(),
    ],
    emailAndPassword: {
      enabled: true,
    },
    trustedOrigins: opts.trustedOrigins ?? ["expo://"],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await createDefaultOrganization(auth, db, user);
          },
        },
      },
      session: {
        create: {
          before: async (session) => setActiveOrganization(db, session),
        },
      },
    },
  });

  return auth;
};

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];

const createDefaultOrganization = async (auth: Auth, db: Db, user: User) => {
  const generateAvailableSlug = async (slug: string, attempt = 0): Promise<string> => {
    const org = await db.query.organization.findFirst({
      where: (organization, { eq }) => eq(organization.slug, slug),
    });
    if (org) {
      return generateAvailableSlug(slug + `-${attempt + 1}`, attempt + 1);
    }
    return slug;
  };

  const slug = await generateAvailableSlug(slugify(user.name));

  try {
    await auth.api.createOrganization({
      body: {
        userId: user.id,
        name: "Personal Organization",
        slug,
        metadata: { personal: true },
      },
    });
  } catch (err) {
    await db.delete(userSchema).where(eq(userSchema.id, user.id));
    throw err;
  }
};

const setActiveOrganization = async (db: Db, session: { userId: string }) => {
  const firstOrg = await db.query.member.findFirst({
    where: (member, { eq }) => eq(member.userId, session.userId),
  });

  return {
    data: {
      ...session,
      activeOrganizationId: firstOrg?.organizationId,
    },
  };
};
