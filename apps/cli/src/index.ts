#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { defineCommand, runMain } from "citty";

import { deployCommand } from "./commands/deploy.js";
import { initCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { skillsCommand } from "./commands/skills.js";
import { whoamiCommand } from "./commands/whoami.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const main = defineCommand({
  meta: {
    name: "vg",
    version: pkg.version,
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
