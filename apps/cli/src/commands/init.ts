import { spawn } from "node:child_process";

import { defineCommand } from "citty";

const REPO = "kyh/vibedgames";
const DEFAULT_AGENTS = "claude-code,cursor,codex";
const description = "Install vibedgames skills into your project";

const runSkillsAdd = async (agents: string[], global: boolean, yes: boolean) => {
  const args = ["-y", "skills", "add", REPO];
  for (const agent of agents) args.push("-a", agent);
  if (global) args.push("-g");
  if (yes) args.push("-y");

  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(npx, args, { stdio: "inherit" });
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", reject);
  });
  if (code !== 0) throw new Error(`skills exited with code ${code}`);
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
  run: ({ args }) => {
    const agents = args.agent
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return runSkillsAdd(agents, args.global, args.yes);
  },
});

export const skillsInstallCommand = defineCommand({
  ...initCommand,
  meta: { name: "install", description },
});
