#!/usr/bin/env node
import { defineCommand, runMain } from "citty";

import { deployCommand } from "./commands/deploy.js";
import { listCommand } from "./commands/list.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { rmCommand } from "./commands/rm.js";
import { whoamiCommand } from "./commands/whoami.js";

const main = defineCommand({
  meta: {
    name: "vg",
    version: "0.0.1",
    description: "vibedgames CLI",
  },
  subCommands: {
    login: loginCommand,
    logout: logoutCommand,
    deploy: deployCommand,
    list: listCommand,
    rm: rmCommand,
    whoami: whoamiCommand,
  },
});

runMain(main);
