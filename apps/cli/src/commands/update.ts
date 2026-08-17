import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineCommand } from "citty";
import consola from "consola";

import {
  detectPackageManager,
  globalInstallArgs,
  globalInstallCommand,
} from "../lib/package-manager.js";
import { isMissingCommand, run } from "../lib/run.js";
import { assertKnownFlags } from "../lib/strict-args.js";
import { fetchLatestVersion, isNewerVersion } from "../lib/update.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const skillsUpdateArgs = (global: boolean) => {
  const args = ["-y", "skills", "update", "-y"];
  if (global) args.push("-g");
  return args;
};

const updateArgs = {
  global: {
    type: "boolean",
    description: "Update skills installed in the user directory instead of the project",
    default: false,
    alias: "g",
  },
  auto: {
    type: "boolean",
    description:
      "(internal) silent background mode: only update when the registry has a newer version",
    default: false,
  },
} as const;

export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description:
      "Update the vg CLI and vibedgames skills to latest (runs automatically once a day; disable with VG_NO_AUTO_UPDATE=1)",
  },
  args: updateArgs,
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, updateArgs);

    // Upgrade with whatever installed this CLI: another manager would write a
    // second copy into a different global prefix, leaving the one on PATH stale.
    const manager = detectPackageManager(fileURLToPath(import.meta.url));

    if (args.auto) {
      const latest = await fetchLatestVersion();
      if (!latest || !isNewerVersion(latest, pkg.version)) return;
      await Promise.all([
        run(manager, globalInstallArgs(manager)),
        run("npx", skillsUpdateArgs(args.global)),
      ]);
      return;
    }

    consola.start("Updating the vg CLI and vibedgames skills...");

    const [cli, skills] = await Promise.all([
      run(manager, globalInstallArgs(manager)),
      run("npx", skillsUpdateArgs(args.global)),
    ]);

    if (cli.code === 0) {
      consola.success(`vg CLI updated to latest with ${manager}`);
    } else {
      if (cli.output.trim() && !isMissingCommand(cli)) consola.warn(cli.output.trim());
      consola.warn(
        isMissingCommand(cli)
          ? `Couldn't find ${manager} to update the vg CLI. Update manually: ${globalInstallCommand(manager)}`
          : `Couldn't update the vg CLI (${manager} exit ${cli.code}). Update manually: ${globalInstallCommand(manager)}`,
      );
    }

    if (skills.code === 0) {
      consola.success("Skills updated to latest");
    } else {
      if (skills.output.trim()) consola.warn(skills.output.trim());
      consola.warn(
        `'skills update' exited with code ${skills.code}. If skills aren't installed here yet, run: vg init`,
      );
    }

    if (cli.code !== 0 && skills.code !== 0) {
      throw new Error("update failed for both the CLI and skills");
    }
  },
});
