#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { defineCommand, runMain } from "citty";

import { completionsCommand } from "./commands/completions.js";
import { deployCommand } from "./commands/deploy.js";
import { forkCommand } from "./commands/fork.js";
import { generateCommand } from "./commands/generate.js";
import { initCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { newCommand } from "./commands/new.js";
import { updateCommand } from "./commands/update.js";
import { whoamiCommand } from "./commands/whoami.js";
import { maybeScheduleAutoUpdate } from "./lib/update.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const main = defineCommand({
  meta: {
    name: "vg",
    version: pkg.version,
    description:
      "vibedgames CLI — agent-native game deploy & asset tooling (use --json for machine-readable output)",
  },
  subCommands: {
    new: newCommand,
    init: initCommand,
    login: loginCommand,
    logout: logoutCommand,
    deploy: deployCommand,
    fork: forkCommand,
    generate: generateCommand,
    update: updateCommand,
    completions: completionsCommand,
    whoami: whoamiCommand,
  },
});

// Skip for update/init (they already update) and completions (runs in shell
// startup — must stay side-effect free).
const subcommand = process.argv[2];
if (subcommand && !["update", "init", "completions"].includes(subcommand)) {
  maybeScheduleAutoUpdate();
}

runMain(main);
