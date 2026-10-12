import { defineCommand } from "citty";
import { consola } from "consola";

import {
  detectPackageManager,
  globalInstallArgs,
  globalInstallCommand,
} from "../lib/package-manager.js";
import type { PackageManager } from "../lib/package-manager.js";
import { PACKAGE_VERSION } from "../lib/package-root.js";
import { isMissingCommand, run } from "../lib/run.js";
import type { RunResult } from "../lib/run.js";
import { FACTORY_PACKAGE, installedFactoryVersion, updateFactory } from "./factory.js";
import { findInstall, settleSync, syncSkills } from "../lib/skills-install.js";
import type { InstallReport } from "../lib/skills-install.js";
import { assertKnownFlags } from "../lib/strict-args.js";
import { fetchLatestVersion, isNewerVersion } from "../lib/update.js";
import { reportSkills } from "./init.js";

/**
 * Re-sync the skills where they are installed: the home directory with
 * `--global`, else this project, else the home directory. Null when neither
 * holds an install — `vg init` puts one there.
 */
const updateInstalledSkills = async (global: boolean): Promise<InstallReport | null> => {
  const found = findInstall(global ? ["global"] : ["project", "global"]);
  return found ? await syncSkills(found.target, found.agents) : null;
};

/**
 * Silent background mode: install only what the registry has newer, and leave
 * whatever fails for the next run.
 */
const autoUpdate = async (
  manager: PackageManager,
  global: boolean,
  factoryVersion: string | null,
): Promise<void> => {
  const [latest, latestFactory] = await Promise.all([
    fetchLatestVersion("vibedgames"),
    factoryVersion === null ? null : fetchLatestVersion(FACTORY_PACKAGE),
  ]);
  const cliNewer = latest !== null && isNewerVersion(latest, PACKAGE_VERSION);
  const factoryNewer =
    factoryVersion !== null &&
    latestFactory !== null &&
    isNewerVersion(latestFactory, factoryVersion);
  await Promise.all([
    cliNewer && run(manager, globalInstallArgs(manager)),
    cliNewer && settleSync(updateInstalledSkills(global)),
    factoryNewer && updateFactory(),
  ]);
};

const reportFactory = (result: RunResult): void => {
  if (result.code === 0) {
    consola.success(`${FACTORY_PACKAGE} updated to latest`);
    return;
  }
  consola.warn(
    `Couldn't update the factory (npm exit ${result.code}). Update manually: npm install -g ${FACTORY_PACKAGE}@latest`,
  );
};

const updateArgs = {
  auto: {
    default: false,
    description:
      "(internal) silent background mode: only update when the registry has a newer version",
    type: "boolean",
  },
  global: {
    alias: "g",
    default: false,
    description: "Update skills installed in the user directory instead of the project",
    type: "boolean",
  },
} as const;

export const updateCommand = defineCommand({
  args: updateArgs,
  meta: {
    description:
      "Update the vg CLI, vibedgames skills and, if installed, the factory to latest (runs automatically once a day; turn that off with `vg config set update.auto false`)",
    name: "update",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, updateArgs);

    // Upgrade with whatever installed this CLI: another manager would write a
    // second copy into a different global prefix, leaving the one on PATH stale.
    const manager = detectPackageManager(import.meta.filename);

    // The factory releases on its own schedule, so it is checked against its
    // own latest rather than riding along with a vg update.
    const factoryVersion = installedFactoryVersion();

    if (args.auto) {
      await autoUpdate(manager, args.global, factoryVersion);
      return;
    }

    consola.start("Updating the vg CLI and vibedgames skills...");

    const [cli, skills, factory] = await Promise.all([
      run(manager, globalInstallArgs(manager)),
      settleSync(updateInstalledSkills(args.global)),
      factoryVersion === null ? null : updateFactory(),
    ]);

    if (cli.code === 0) {
      consola.success(`vg CLI updated to latest with ${manager}`);
    } else {
      if (cli.output.trim() && !isMissingCommand(cli)) {
        consola.warn(cli.output.trim());
      }
      consola.warn(
        isMissingCommand(cli)
          ? `Couldn't find ${manager} to update the vg CLI. Update manually: ${globalInstallCommand(manager)}`
          : `Couldn't update the vg CLI (${manager} exit ${cli.code}). Update manually: ${globalInstallCommand(manager)}`,
      );
    }

    if (!skills.ok) {
      consola.warn(`Couldn't update the skills: ${skills.message}`);
    } else if (skills.value) {
      reportSkills(skills.value);
    } else {
      consola.info("No vibedgames skills installed here or in your home directory: run vg init");
    }

    if (factory) {
      reportFactory(factory);
    }

    if (cli.code !== 0 && !skills.ok) {
      throw new Error("update failed for both the CLI and skills");
    }
  },
});
