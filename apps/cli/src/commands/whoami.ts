import { defineCommand } from "citty";
import consola from "consola";

import { getBaseUrl, getToken } from "../lib/config.js";

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

    const baseUrl = getBaseUrl();

    const res = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: {
        Cookie: `better-auth.session_token=${token}`,
      },
    });

    if (!res.ok) {
      consola.error("Failed to fetch session. Try `vg login` again.");
      process.exit(1);
    }

    const data = (await res.json()) as {
      user?: { name: string; email: string };
    };

    if (!data.user) {
      consola.warn("Session expired. Run `vg login` to re-authenticate.");
      process.exit(1);
    }

    consola.log(`${data.user.name} (${data.user.email})`);
  },
});
