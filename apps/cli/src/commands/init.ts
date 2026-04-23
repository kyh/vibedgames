import { defineCommand } from "citty";

import { installSkills } from "../lib/install-skills.js";

const description = "Install vibedgames Claude Code skills into your project";

export const initCommand = defineCommand({
  meta: { name: "init", description },
  args: {
    dir: {
      type: "positional",
      description: "Project directory",
      required: false,
      default: ".",
    },
    force: {
      type: "boolean",
      description: "Overwrite existing skills without prompting",
      default: false,
    },
  },
  run: ({ args }) => installSkills(args.dir, args.force),
});

export const skillsInstallCommand = defineCommand({
  ...initCommand,
  meta: { name: "install", description },
});
