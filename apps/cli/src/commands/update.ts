import { readFileSync } from "node:fs";

import { defineCommand } from "citty";
import consola from "consola";

import { run } from "../lib/run.js";
import { fetchLatestVersion, isNewerVersion } from "../lib/update.js";

const PKG = "vibedgames";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const skillsUpdateArgs = (global: boolean) => {
  const args = ["-y", "skills", "update", "-y"];
  if (global) args.push("-g");
  return args;
};

export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description:
      "Update the vg CLI and vibedgames skills to latest (runs automatically once a day; disable with VG_NO_AUTO_UPDATE=1)",
  },
  args: {
    global: {
      type: "boolean",
      description: "Update skills installed in the user directory instead of the project",
      default: false,
      alias: "g",
    },
    auto: {
      type: "boolean",
      description: "(internal) silent background mode: only update when npm has a newer version",
      default: false,
    },
  },
  run: async ({ args }) => {
    if (args.auto) {
      const latest = await fetchLatestVersion();
      if (!latest || !isNewerVersion(latest, pkg.version)) return;
      await Promise.all([
        run("npm", ["install", "-g", PKG]),
        run("npx", skillsUpdateArgs(args.global)),
      ]);
      return;
    }

    consola.start("Updating the vg CLI and vibedgames skills...");

    const [cli, skills] = await Promise.all([
      run("npm", ["install", "-g", PKG]),
      run("npx", skillsUpdateArgs(args.global)),
    ]);

    if (cli.code === 0) {
      consola.success("vg CLI updated to latest");
    } else {
      if (cli.output.trim()) consola.warn(cli.output.trim());
      consola.warn(
        `Couldn't update the vg CLI (npm exit ${cli.code}). Update manually: npm install -g ${PKG}`,
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
