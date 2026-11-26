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
    asset: lazy(async () => await import("./commands/asset.js"), "assetCommand"),
    completions: lazy(async () => await import("./commands/completions.js"), "completionsCommand"),
    config: lazy(async () => await import("./commands/config.js"), "configCommand"),
    credits: lazy(async () => await import("./commands/credits.js"), "creditsCommand"),
    deploy: lazy(async () => await import("./commands/deploy.js"), "deployCommand"),
    deployments: lazy(async () => await import("./commands/deployments.js"), "deploymentsCommand"),
    distribute: lazy(async () => await import("./commands/distribute.js"), "distributeCommand"),
    factory: lazy(async () => await import("./commands/factory.js"), "factoryCommand"),
    fork: lazy(async () => await import("./commands/fork.js"), "forkCommand"),
    generate: lazy(async () => await import("./commands/generate.js"), "generateCommand"),
    init: lazy(async () => await import("./commands/init.js"), "initCommand"),
    login: lazy(async () => await import("./commands/login.js"), "loginCommand"),
    logout: lazy(async () => await import("./commands/logout.js"), "logoutCommand"),
    new: lazy(async () => await import("./commands/new.js"), "newCommand"),
    playtest: async () => {
      const { playtestCommand } = await import("./commands/playtest.js");

      return defineCommand({
        meta: playtestCommand.meta,
        subCommands: {
          run: lazy(async () => await import("./commands/playtest-run.js"), "playtestRunCommand"),
        },
      });
    },
    skills: lazy(async () => await import("./commands/skills.js"), "skillsCommand"),
    update: lazy(async () => await import("./commands/update.js"), "updateCommand"),
    whoami: lazy(async () => await import("./commands/whoami.js"), "whoamiCommand"),
  },
});

const subcommand = process.argv.at(2);

if (
  subcommand !== undefined &&
  subcommand !== "" &&
  !["update", "init", "completions"].includes(subcommand)
) {
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
