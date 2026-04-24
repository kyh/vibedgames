import { defineCommand } from "citty";
import consola from "consola";
import spawn from "cross-spawn";

const REPO = "kyh/vibedgames";
const PKG = "vibedgames";
const DEFAULT_AGENTS = "claude-code,cursor,codex";
const description = "Install vibedgames skills into your project";

type RunResult = { code: number; output: string };

const run = (cmd: string, args: string[]): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.stderr?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("exit", (code) =>
      resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") }),
    );
  });

const skillsArgs = (agents: string[], global: boolean, yes: boolean) => {
  const args = ["-y", "skills", "add", REPO];
  for (const agent of agents) args.push("-a", agent);
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

    consola.start("Installing skills and the vg CLI globally...");

    const [skills, cli] = await Promise.all([
      run("npx", skillsArgs(agents, args.global, args.yes)),
      run("npm", ["install", "-g", PKG]),
    ]);

    if (skills.code !== 0) {
      if (skills.output.trim()) consola.error(skills.output.trim());
      throw new Error(`skills exited with code ${skills.code}`);
    }
    consola.success(`Installed vibedgames skills for ${agents.join(", ")}`);

    if (cli.code !== 0) {
      if (cli.output.trim()) consola.warn(cli.output.trim());
      consola.warn(
        `Couldn't install the vg CLI globally (npm exit ${cli.code}). Install manually: npm install -g ${PKG}`,
      );
      return;
    }
    consola.success("Installed vg CLI globally");
  },
});

export const skillsInstallCommand = defineCommand({
  ...initCommand,
  meta: { name: "install", description },
});
