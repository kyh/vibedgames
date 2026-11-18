#!/usr/bin/env node
import { defineCommand, runMain } from "citty";

import { PACKAGE_VERSION } from "./lib/package-root.js";

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }

    throw error;
  });
}

const lazy =
  <M, K extends keyof M>(load: () => Promise<M>, key: K) =>
  async () => {
    const module = await load();

    return module[key];
  };

const main = defineCommand({
  meta: {
    description:
      "vibedgames CLI — agent-native game deploy & asset tooling (use --json for machine-readable output)",
    name: "vg",
    version: PACKAGE_VERSION,
  },
  subCommands: {
    completions: lazy(() => import("./commands/completions.js"), "completionsCommand"),
    config: lazy(() => import("./commands/config.js"), "configCommand"),
    credits: lazy(() => import("./commands/credits.js"), "creditsCommand"),
    deploy: lazy(() => import("./commands/deploy.js"), "deployCommand"),
    deployments: lazy(() => import("./commands/deployments.js"), "deploymentsCommand"),
    distribute: lazy(() => import("./commands/distribute.js"), "distributeCommand"),
    factory: lazy(() => import("./commands/factory.js"), "factoryCommand"),
    fork: lazy(() => import("./commands/fork.js"), "forkCommand"),
    generate: lazy(() => import("./commands/generate.js"), "generateCommand"),
    init: lazy(() => import("./commands/init.js"), "initCommand"),
    login: lazy(() => import("./commands/login.js"), "loginCommand"),
    logout: lazy(() => import("./commands/logout.js"), "logoutCommand"),
    new: lazy(() => import("./commands/new.js"), "newCommand"),
    playtest: async () => {
      const { playtestCommand } = await import("./commands/playtest.js");

      return defineCommand({
        meta: playtestCommand.meta,
        subCommands: {
          run: lazy(() => import("./commands/playtest-run.js"), "playtestRunCommand"),
        },
      });
    },
    skills: lazy(() => import("./commands/skills.js"), "skillsCommand"),
    update: lazy(() => import("./commands/update.js"), "updateCommand"),
    whoami: lazy(() => import("./commands/whoami.js"), "whoamiCommand"),
  },
});

const subcommand = process.argv.at(2);

if (subcommand && !["update", "init", "completions"].includes(subcommand)) {
  const { maybeScheduleAutoUpdate } = await import("./lib/update.js");
  maybeScheduleAutoUpdate();
}

if (subcommand === "factory") {
  const { runFactory } = await import("./commands/factory.js");
  runFactory(process.argv.slice(3));
}

if (subcommand === "playtest" && process.argv.at(3) !== "run") {
  const { runPlaytest } = await import("./commands/playtest.js");
  runPlaytest(process.argv.slice(3));
}

await runMain(main);
