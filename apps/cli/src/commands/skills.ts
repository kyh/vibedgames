import { defineCommand } from "citty";

import { skillsInstallCommand } from "./init.js";

export const skillsCommand = defineCommand({
  meta: {
    name: "skills",
    description: "Manage vibedgames Claude Code skills",
  },
  subCommands: {
    install: skillsInstallCommand,
  },
});
