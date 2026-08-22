/**
 * Static mirror of `createAuth()`'s options.
 *
 * The Worker builds its auth inside `createAuth()` because it needs runtime
 * bindings, so there is no module-level instance to introspect. This file is
 * that instance: it is read by `auth-tables.test.ts` (which asserts the Drizzle
 * schema still agrees with better-auth) and by `@better-auth/cli generate`. It
 * is NOT imported at runtime by the Worker, so cold start pays nothing for it.
 *
 * Mirror every option that changes the derived table set — the plugin list, the
 * additional fields, and `rateLimit.storage` — or the test guards the wrong
 * shape. Tuning that cannot move a column (window sizes, prefixes, cookies) is
 * deliberately left out.
 */
import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer, oAuthProxy } from "better-auth/plugins";

export const auth = betterAuth({
  // Codegen/test only: an in-memory adapter satisfies better-auth's init
  // without opening a connection. The real Worker uses drizzleAdapter(d1).
  database: memoryAdapter({}),
  plugins: [oAuthProxy(), bearer(), expo(), admin(), apiKey()],
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      invitedByCode: { type: "string", required: false, input: false },
    },
  },
  rateLimit: { enabled: true, storage: "database" },
});
