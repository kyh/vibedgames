import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";

import { run } from "../lib/run.js";
import type { RunResult } from "../lib/run.js";
import { isJsonObject, isJsonString } from "../lib/types.js";
import type { JsonValue } from "../lib/types.js";

/**
 * `vg factory` — the autonomous game factory, shipped as an optional plugin.
 * The vg CLI carries none of it: the factory is its own npm package (plain
 * JavaScript, one for every platform) that gets installed globally on first
 * use, then every invocation runs its bin with this Node, args passed
 * through. index.ts routes `vg factory …` here BEFORE citty parses anything,
 * so even `--help`/`--version` reach the factory untouched; the citty command
 * below exists only so `vg --help` lists the subcommand.
 */

export const FACTORY_PACKAGE = "@vibedgames/factory";

const npmGlobalRoot = () => {
  try {
    const res = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 30_000 });

    if (res.status !== 0 || res.error !== undefined) {
      return null;
    }

    const root = res.stdout.trim();

    return root || null;
  } catch {
    return null;
  }
};

const findEntry = () => {
  const override = process.env.VG_FACTORY_BIN;

  if (override !== undefined && override !== "") {
    return existsSync(override) ? override : null;
  }

  const root = npmGlobalRoot();

  if (root === null || root === "") {
    return null;
  }

  const entry = path.join(root, FACTORY_PACKAGE, "bin", "vg-factory.js");

  return existsSync(entry) ? entry : null;
};

/** The globally installed factory's version, or null when it isn't installed. */
export const installedFactoryVersion = () => {
  const root = npmGlobalRoot();

  if (root === null || root === "") {
    return null;
  }

  try {
    const manifest: JsonValue = JSON.parse(
      readFileSync(path.join(root, FACTORY_PACKAGE, "package.json"), "utf-8"),
    );

    return isJsonObject(manifest) && isJsonString(manifest.version) ? manifest.version : null;
  } catch {
    return null;
  }
};

export const updateFactory: () => Promise<RunResult> = async () =>
  await run("npm", ["install", "-g", `${FACTORY_PACKAGE}@latest`]);

/** Resolve (installing on first use) and exec the factory. Never returns. */
export const runFactory = (args: string[]): never => {
  let entry = findEntry();

  if (entry === null || entry === "") {
    consola.start(`Installing the factory (${FACTORY_PACKAGE})…`);
    const install = spawnSync("npm", ["install", "-g", FACTORY_PACKAGE], { stdio: "inherit" });

    if (install.status !== 0 || install.error !== undefined) {
      consola.error(
        `Couldn't install the factory. Try manually: npm install -g ${FACTORY_PACKAGE}`,
      );
      process.exit(1);
    }

    entry = findEntry();

    if (entry === null || entry === "") {
      consola.error(
        `Installed ${FACTORY_PACKAGE} but couldn't find its entry under npm's global root. Check \`npm root -g\`.`,
      );
      process.exit(1);
    }

    consola.success("Factory installed.");
  }

  const result = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
};

export const factoryCommand = defineCommand({
  meta: {
    description:
      "Run the vibedgames factory — an autonomous agent that builds a browser game and evolves it like a studio (optional plugin; installs on first use). All arguments are passed through: `vg factory` opens the dashboard, `vg factory start <slug>` resumes a game.",
    name: "factory",
  },
  run: ({ rawArgs }) => {
    runFactory(rawArgs);
  },
});
