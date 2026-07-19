#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { defineCommand, runMain } from "citty";

import { completionsCommand } from "./commands/completions.js";
import { creditsCommand } from "./commands/credits.js";
import { deployCommand } from "./commands/deploy.js";
import { factoryCommand, runFactory } from "./commands/factory.js";
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
    factory: factoryCommand,
    fork: forkCommand,
    generate: generateCommand,
    credits: creditsCommand,
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

// `vg factory` is a pure passthrough to the factory plugin binary — route it
// before citty runs so flags like --help/--version reach the binary instead
// of being intercepted here. (The registered command keeps it in `vg --help`.)
if (subcommand === "factory") {
  runFactory(process.argv.slice(3));
}

runMain(main);
