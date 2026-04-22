#!/usr/bin/env node
import { defineCommand, runMain } from "citty";

import { deployCommand } from "./commands/deploy.js";
import { initCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { skillsCommand } from "./commands/skills.js";
import { whoamiCommand } from "./commands/whoami.js";

const main = defineCommand({
  meta: {
    name: "vg",
    version: "0.0.1",
    description: "vibedgames CLI",
  },
  subCommands: {
    init: initCommand,
    login: loginCommand,
    logout: logoutCommand,
    deploy: deployCommand,
    skills: skillsCommand,
    whoami: whoamiCommand,
  },
});

runMain(main);
