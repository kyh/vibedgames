import { readFileSync } from "node:fs";

import { defineCommand } from "citty";
import consola from "consola";
import spawn from "cross-spawn";

const REPO = "kyh/vibedgames";
const PKG = "vibedgames";
const DEFAULT_AGENTS = "claude-code,cursor,codex";
const description =
  "Install vibedgames skills (and update the vg CLI + skills if outdated)";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

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

const fetchLatestVersion = async (): Promise<string | null> => {
  const result = await run("npm", ["view", PKG, "version"]);
  if (result.code !== 0) return null;
  const v = result.output.trim();
  return v.length > 0 ? v : null;
};

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

    consola.start(
      `Installing vibedgames skills (vg ${pkg.version}) and checking for updates...`,
    );

    const latest = await fetchLatestVersion();
    const cliNeedsUpdate = latest !== null && latest !== pkg.version;

    const addPromise = run("npx", skillsAddArgs(agents, args.global, args.yes));
    const cliPromise = cliNeedsUpdate
      ? run("npm", ["install", "-g", `${PKG}@latest`])
      : null;
    const [add, cli] = await Promise.all([addPromise, cliPromise]);

    if (add.code !== 0) {
      if (add.output.trim()) consola.error(add.output.trim());
      throw new Error(`skills add exited with code ${add.code}`);
    }
    consola.success(`Installed vibedgames skills for ${agents.join(", ")}`);

    const update = await run(
      "npx",
      skillsUpdateArgs(args.global, args.yes),
    );
    if (update.code !== 0) {
      if (update.output.trim()) consola.warn(update.output.trim());
      consola.warn(
        `'skills update' exited with code ${update.code}. Skills were just installed via 'add', so they should already be current.`,
      );
    } else {
      consola.success("Refreshed installed skills to latest");
    }

    if (!cliNeedsUpdate) {
      if (latest === null) {
        consola.warn(
          `Could not determine the latest vg CLI version on npm. You're on ${pkg.version}.`,
        );
      } else {
        consola.success(`vg CLI is already on the latest version (${pkg.version})`);
      }
      return;
    }

    if (!cli || cli.code !== 0) {
      if (cli?.output.trim()) consola.warn(cli.output.trim());
      consola.warn(
        `Couldn't update the vg CLI globally (npm exit ${cli?.code ?? "?"}). Update manually: npm install -g ${PKG}@latest`,
      );
      return;
    }
    consola.success(`Updated vg CLI from ${pkg.version} to ${latest}`);
  },
});

export const skillsInstallCommand = defineCommand({
  ...initCommand,
  meta: { name: "install", description },
});
