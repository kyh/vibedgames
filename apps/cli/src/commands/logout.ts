import { defineCommand } from "citty";
import consola from "consola";

import { clearConfig } from "../lib/config.js";

export const logoutCommand = defineCommand({
  meta: {
    name: "logout",
    description: "Log out of vibedgames",
  },
  run: () => {
    clearConfig();
    consola.success("Logged out");
  },
});
