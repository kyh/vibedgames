import { defineCommand } from "citty";

import { installSkills } from "../lib/install-skills.js";

const description =
  "Install vibedgames skills into your project (delegates to `npx skills add kyh/vibedgames` from vercel-labs/skills)";

export const initCommand = defineCommand({
  meta: { name: "init", description },
  args: {
    agent: {
      type: "string",
      description:
        "Target agent (claude-code, cursor, codex, windsurf, ...). Omit to pick interactively.",
      alias: "a",
    },
    global: {
      type: "boolean",
      description: "Install to user directory instead of project",
      default: false,
      alias: "g",
    },
    yes: {
      type: "boolean",
      description: "Skip confirmation prompts",
      default: false,
      alias: "y",
    },
  },
  run: ({ args }) =>
    installSkills({
      agent: args.agent,
      global: args.global,
      yes: args.yes,
    }),
});

export const skillsInstallCommand = defineCommand({
  ...initCommand,
  meta: { name: "install", description },
});
