import { defineCommand } from "citty";
import consola from "consola";
import spawn from "cross-spawn";

const REPO = "kyh/vibedgames";
const PKG = "vibedgames";
const DEFAULT_AGENTS = "claude-code,cursor,codex";
const description = "Install/update vibedgames skills and the vg CLI";

type RunResult = { code: number; output: string };

const run = (cmd: string, args: string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.stderr?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) =>
      resolve({ code: 1, output: `${err.message}\n` }),
    );
    child.on("close", (code) =>
      resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") }),
    );
  });

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

    consola.start("Installing/updating vibedgames skills and the vg CLI...");

    const [add, cli] = await Promise.all([
      run("npx", skillsAddArgs(agents, args.global, args.yes)),
      run("npm", ["install", "-g", PKG]),
    ]);

    if (add.code !== 0) {
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
      if (cli.output.trim()) consola.warn(cli.output.trim());
      consola.warn(
        `Couldn't install the vg CLI globally (npm exit ${cli.code}). Install manually: npm install -g ${PKG}`,
      );
      return;
    }
    consola.success("Installed/updated vg CLI globally");
  },
});

