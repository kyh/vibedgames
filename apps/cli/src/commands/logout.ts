import { defineCommand } from "citty";
import { consola } from "consola";

import { clearConfig } from "../lib/config.js";

export const logoutCommand = defineCommand({
  meta: {
    description: "Log out of vibedgames",
    name: "logout",
  },
  run: () => {
    clearConfig();
    consola.success("Logged out");
  },
});
