import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";
import { getToken } from "../lib/config.js";

export const whoamiCommand = defineCommand({
  meta: {
    name: "whoami",
    description: "Show the currently authenticated user",
  },
  run: async () => {
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
      consola.log(`${user.name} (${user.email})`);
    } catch {
      consola.warn("Not authenticated. Run `vg login`, or check your VG_TOKEN / API key.");
      process.exit(1);
    }
  },
});
