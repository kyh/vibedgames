import { spawn } from "node:child_process";

import { defineCommand } from "citty";
import consola from "consola";

const REPO = "kyh/vibedgames";
const PKG = "vibedgames";
const DEFAULT_AGENTS = "claude-code,cursor,codex";
const description = "Install vibedgames skills into your project";

const run = (cmd: string, args: string[]) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", reject);
  });

const installSkills = async (agents: string[], global: boolean, yes: boolean) => {
  const args = ["-y", "skills", "add", REPO];
  for (const agent of agents) args.push("-a", agent);
  if (global) args.push("-g");
  if (yes) args.push("-y");

  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const code = await run(npx, args);
  if (code !== 0) throw new Error(`skills exited with code ${code}`);
};

const installGlobalCli = async () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const code = await run(npm, ["install", "-g", PKG]);
  if (code !== 0) {
    consola.warn(
      `Couldn't install the vg CLI globally (npm exit ${code}). Install manually: npm install -g ${PKG}`,
    );
  }
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
    await installSkills(agents, args.global, args.yes);
    await installGlobalCli();
  },
});

export const skillsInstallCommand = defineCommand({
  ...initCommand,
  meta: { name: "install", description },
});
