/**
 * Static auth instance for `@better-auth/cli generate` introspection.
 *
 * The CLI needs a module-level betterAuth() to analyze the plugin set and
 * derive the schema. This file is only referenced by the generate-auth-schema
 * script — it is NOT imported at runtime by the Worker, avoiding side effects
 * on cold start.
 */
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { admin, oAuthProxy } from "better-auth/plugins";

export const auth = betterAuth({
  database: { provider: "sqlite", type: "sqlite" } as never,
  plugins: [oAuthProxy(), expo(), admin()],
  emailAndPassword: { enabled: true },
});
