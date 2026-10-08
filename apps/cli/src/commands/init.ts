import path from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";

import {
  detectPackageManager,
  globalInstallArgs,
  globalInstallCommand,
  PKG_NAME,
} from "../lib/package-manager.js";
import { isMissingCommand, run } from "../lib/run.js";
import {
  DEFAULT_AGENTS,
  parseAgents,
  settleSync,
  syncSkills,
  targetFor,
} from "../lib/skills-install.js";
import type { InstallReport } from "../lib/skills-install.js";
import { assertKnownFlags } from "../lib/strict-args.js";

const description = "Install/update vibedgames skills and the vg CLI";

const initArgs = {
  agent: {
    alias: "a",
    default: DEFAULT_AGENTS.join(","),
    description:
      "Comma-separated target agents (default: Claude Code, Cursor and Codex). Skills live once in .agents/skills/, which Codex, Cursor and most agents read directly; Claude Code and agents with a skills dir of their own get a symlink per skill. Pass '*' for every supported agent.",
    type: "string",
  },
  global: {
    alias: "g",
    default: false,
    description: "Install to your home directory instead of the project",
    type: "boolean",
  },
} as const;

/** One summary for `vg init` and `vg update`. */
export const reportSkills = (report: InstallReport): void => {
  const where = path.relative(process.cwd(), report.dir) || report.dir;
  consola.success(
    `Installed ${report.installed.length} vibedgames skills into ${where} for ${report.agents.join(", ")}`,
  );
  if (report.removed.length > 0) {
    consola.info(`Removed skills dropped upstream: ${report.removed.join(", ")}`);
  }
  for (const agent of report.copiedFor) {
    consola.warn(
      `Symlinks aren't available here, so ${agent} got copies of the skills: re-run \`vg init\` after an update to refresh them.`,
    );
  }
};

export const initCommand = defineCommand({
  args: initArgs,
  meta: { description, name: "init" },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, initArgs);

    const agents = parseAgents(args.agent);

    // Whatever installed this CLI is what should upgrade it. Installing with a
    // different manager writes a second copy into a prefix the shell may not
    // even be looking at, so `vg --version` would not move.
    const manager = detectPackageManager(import.meta.filename);

    consola.start("Installing/updating vibedgames skills and the vg CLI...");

    const [skills, cli] = await Promise.all([
      settleSync(syncSkills(targetFor(args.global ? "global" : "project"), agents)),
      run(manager, globalInstallArgs(manager)),
    ]);

    if (skills.ok) {
      reportSkills(skills.value);
    }

    if (cli.code === 0) {
      consola.success(`Installed/updated ${PKG_NAME} globally with ${manager}`);
    } else {
      if (cli.output.trim() && !isMissingCommand(cli)) {
        consola.warn(cli.output.trim());
      }
      consola.warn(
        isMissingCommand(cli)
          ? `Couldn't find ${manager} to update the vg CLI. Update manually: ${globalInstallCommand(manager)}`
          : `Couldn't install the vg CLI globally (${manager} exit ${cli.code}). Install manually: ${globalInstallCommand(manager)}`,
      );
    }

    if (!skills.ok) {
      throw new Error(`Couldn't install the skills: ${skills.message}`);
    }
  },
});
