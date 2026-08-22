import { defineCommand } from "citty";
import consola from "consola";

import { authErrorCode, createClient } from "../lib/api.js";
import { getToken } from "../lib/config.js";
import { outputArgs, writeStructured } from "../lib/output.js";
import { assertKnownFlags } from "../lib/strict-args.js";

const whoamiArgs = { ...outputArgs } as const;

export const whoamiCommand = defineCommand({
  meta: {
    name: "whoami",
    description: "Show the currently authenticated user",
  },
  args: whoamiArgs,
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, whoamiArgs);

    const token = getToken();

    if (!token) {
      consola.warn("Not logged in. Run `vg login` to authenticate.");
      process.exit(1);
    }

    // Goes through tRPC (not the raw better-auth endpoint) so it resolves
    // both session tokens and `vg_…` API keys.
    const client = createClient();

    try {
      const user = await client.auth.me.query();
      if (writeStructured({ id: user.id, name: user.name, email: user.email }, args)) return;
      consola.log(`${user.name} (${user.email})`);
    } catch (err) {
      // Only an auth error means "log in"; surface network/server failures as
      // themselves so they aren't mistaken for a bad credential.
      const code = authErrorCode(err);
      if (code === "UNAUTHORIZED" || code === "FORBIDDEN") {
        consola.warn("Not authenticated. Run `vg login`, or check your VG_TOKEN / API key.");
      } else {
        consola.error(
          `Failed to fetch current user: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      process.exit(1);
    }
  },
});
