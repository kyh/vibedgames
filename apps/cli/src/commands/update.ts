import { readFileSync } from "node:fs";

import { defineCommand } from "citty";
import { consola } from "consola";

import {
  detectPackageManager,
  globalInstallArgs,
  globalInstallCommand,
} from "../lib/package-manager.js";
import { isMissingCommand, run } from "../lib/run.js";
import { findInstall, settleSync, syncSkills } from "../lib/skills-install.js";
import type { InstallReport } from "../lib/skills-install.js";
import { assertKnownFlags } from "../lib/strict-args.js";
import { fetchLatestVersion, isNewerVersion } from "../lib/update.js";
import { reportSkills } from "./init.js";

// SAFETY: this is the CLI's own package.json, shipped alongside dist — npm
// refuses to publish a package without a string `version`.
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
  version: string;
};

/**
 * Re-sync the skills where they are installed: the home directory with
 * `--global`, else this project, else the home directory. Null when neither
 * holds an install — `vg init` puts one there.
 */
const updateInstalledSkills = async (global: boolean): Promise<InstallReport | null> => {
  const found = findInstall(global ? ["global"] : ["project", "global"]);
  return found ? await syncSkills(found.target, found.agents) : null;
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
      "Update the vg CLI and vibedgames skills to latest (runs automatically once a day; disable with VG_NO_AUTO_UPDATE=1)",
    name: "update",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, updateArgs);

    // Upgrade with whatever installed this CLI: another manager would write a
    // second copy into a different global prefix, leaving the one on PATH stale.
    const manager = detectPackageManager(import.meta.filename);

    if (args.auto) {
      const latest = await fetchLatestVersion();
      if (!latest || !isNewerVersion(latest, pkg.version)) {
        return;
      }
      await Promise.all([
        run(manager, globalInstallArgs(manager)),
        // Silent background mode: a failed skills sync waits for the next run.
        settleSync(updateInstalledSkills(args.global)),
      ]);
      return;
    }

    consola.start("Updating the vg CLI and vibedgames skills...");

    const [cli, skills] = await Promise.all([
      run(manager, globalInstallArgs(manager)),
      settleSync(updateInstalledSkills(args.global)),
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

    if (cli.code !== 0 && !skills.ok) {
      throw new Error("update failed for both the CLI and skills");
    }
  },
});
