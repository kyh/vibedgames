import { fileURLToPath } from "node:url";

import { defineCommand } from "citty";
import consola from "consola";

import {
  detectPackageManager,
  globalInstallArgs,
  globalInstallCommand,
  PKG_NAME,
} from "../lib/package-manager.js";
import { isMissingCommand, run } from "../lib/run.js";

const REPO = "kyh/vibedgames";
const DEFAULT_AGENTS = "claude-code,cursor,codex";
const description = "Install/update vibedgames skills and the vg CLI";

const skillsAddArgs = (agents: string[], global: boolean, yes: boolean) => {
  const args = ["-y", "skills", "add", REPO];
  for (const agent of agents) args.push("-a", agent);
  if (global) args.push("-g");
  if (yes) args.push("-y");
  return args;
};

const skillsUpdateArgs = (global: boolean, yes: boolean) => {
  const args = ["-y", "skills", "update"];
  if (global) args.push("-g");
  if (yes) args.push("-y");
  return args;
};

export const initCommand = defineCommand({
  meta: { name: "init", description },
  args: {
    agent: {
      type: "string",
      description:
        "Comma-separated target agents. Default installs for Claude Code, Cursor, and Codex (symlinked from a shared .agents/skills/ dir). Pass '*' for every supported agent.",
      alias: "a",
      default: DEFAULT_AGENTS,
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
      default: true,
      alias: "y",
    },
  },
  run: async ({ args }) => {
    const agents = args.agent
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Whatever installed this CLI is what should upgrade it. Installing with a
    // different manager writes a second copy into a prefix the shell may not
    // even be looking at, so `vg --version` would not move.
    const manager = detectPackageManager(fileURLToPath(import.meta.url));

    consola.start("Installing/updating vibedgames skills and the vg CLI...");

    const [add, cli] = await Promise.all([
      run("npx", skillsAddArgs(agents, args.global, args.yes)),
      run(manager, globalInstallArgs(manager)),
    ]);

    if (add.code !== 0) {
      if (isMissingCommand(add)) {
        throw new Error(
          "`npx` was not found on PATH. It ships with Node, so this usually means " +
            "the vg CLI is running from a standalone build — install Node, or add " +
            `the skills yourself with: npx skills add ${REPO}`,
        );
      }
      if (add.output.trim()) consola.error(add.output.trim());
      throw new Error(`skills add exited with code ${add.code}`);
    }
    consola.success(`Installed vibedgames skills for ${agents.join(", ")}`);

    const update = await run("npx", skillsUpdateArgs(args.global, args.yes));
    if (update.code !== 0) {
      if (update.output.trim()) consola.warn(update.output.trim());
      consola.warn(
        `'skills update' exited with code ${update.code}. Skills were just installed via 'add', so they should already be current.`,
      );
    } else {
      consola.success("Refreshed installed skills to latest");
    }

    if (cli.code !== 0) {
      if (cli.output.trim() && !isMissingCommand(cli)) consola.warn(cli.output.trim());
      consola.warn(
        isMissingCommand(cli)
          ? `Couldn't find ${manager} to update the vg CLI. Update manually: ${globalInstallCommand(manager)}`
          : `Couldn't install the vg CLI globally (${manager} exit ${cli.code}). Install manually: ${globalInstallCommand(manager)}`,
      );
      return;
    }
    consola.success(`Installed/updated ${PKG_NAME} globally with ${manager}`);
  },
});
