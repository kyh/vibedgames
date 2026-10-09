#!/usr/bin/env node
import { defineCommand, runMain } from "citty";

import { PACKAGE_VERSION } from "./lib/package-root.js";

/** A command imported only when it runs: `key` names its export in the module. */
const lazy =
  <M, K extends keyof M>(load: () => Promise<M>, key: K) =>
  async (): Promise<M[K]> => {
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
  // Each command is imported when it runs, so a call loads that command's code
  // and dependencies alone. `vg --help` loads them all, for their descriptions.
  subCommands: {
    completions: lazy(() => import("./commands/completions.js"), "completionsCommand"),
    config: lazy(() => import("./commands/config.js"), "configCommand"),
    credits: lazy(() => import("./commands/credits.js"), "creditsCommand"),
    deploy: lazy(() => import("./commands/deploy.js"), "deployCommand"),
    factory: lazy(() => import("./commands/factory.js"), "factoryCommand"),
    fork: lazy(() => import("./commands/fork.js"), "forkCommand"),
    generate: lazy(() => import("./commands/generate.js"), "generateCommand"),
    init: lazy(() => import("./commands/init.js"), "initCommand"),
    login: lazy(() => import("./commands/login.js"), "loginCommand"),
    logout: lazy(() => import("./commands/logout.js"), "logoutCommand"),
    new: lazy(() => import("./commands/new.js"), "newCommand"),
    // `run` is the one `vg playtest` verb that is ours rather than
    // agent-browser's: the model-driven playtest. index.ts routes every other
    // `vg playtest …` straight to the binary below. Only the meta is reused:
    // citty runs a parent's `run` AFTER its subcommand, so carrying the
    // passthrough here would forward `run …` to agent-browser once the
    // playtest had finished and turn every passing run into an exit 1.
    playtest: async () => {
      const { playtestCommand } = await import("./commands/playtest.js");
      return defineCommand({
        meta: playtestCommand.meta,
        subCommands: {
          run: lazy(() => import("./commands/playtest-run.js"), "playtestRunCommand"),
        },
      });
    },
    update: lazy(() => import("./commands/update.js"), "updateCommand"),
    whoami: lazy(() => import("./commands/whoami.js"), "whoamiCommand"),
  },
});

// Skip for update/init (they already update) and completions (runs in shell
// startup — must stay side-effect free).
const subcommand = process.argv.at(2);
if (subcommand && !["update", "init", "completions"].includes(subcommand)) {
  const { maybeScheduleAutoUpdate } = await import("./lib/update.js");
  maybeScheduleAutoUpdate();
}

// `vg factory` and `vg playtest` are pure passthroughs to their binaries —
// route them before citty runs so flags like --help/--version reach the binary
// instead of being intercepted here. (The registered commands keep them in
// `vg --help`.)
if (subcommand === "factory") {
  const { runFactory } = await import("./commands/factory.js");
  runFactory(process.argv.slice(3));
}

if (subcommand === "playtest" && process.argv.at(3) !== "run") {
  const { runPlaytest } = await import("./commands/playtest.js");
  runPlaytest(process.argv.slice(3));
}

await runMain(main);
