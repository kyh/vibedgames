import { defineCommand } from "citty";
import { consola } from "consola";

import { clearConfig, getConfig } from "../lib/config.js";
import { revokeLogin } from "../lib/oauth.js";

export const logoutCommand = defineCommand({
  meta: {
    description: "Log out of vibedgames",
    name: "logout",
  },
  run: async () => {
    const config = getConfig();
    if (config) {
      await revokeLogin(config);
    }
    clearConfig();
    consola.success("Logged out");
  },
});
