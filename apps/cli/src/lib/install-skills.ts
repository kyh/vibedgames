import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import consola from "consola";

const REPO = "kyh/vibedgames";
const BRANCH = "main";

export const installSkills = async (projectDir: string, force: boolean) => {
  const targetDir = join(projectDir, ".claude", "skills");
  const tarballUrl = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`;
  const tmpDir = join(projectDir, ".vg-skills-tmp");

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !force) {
    const proceed = await consola.prompt(
      `${targetDir} already has content. Overwrite existing skills?`,
      { type: "confirm", initial: false },
    );
    if (!proceed) {
      consola.info("Aborted.");
      return;
    }
  }

  consola.start("Fetching skills from vibedgames...");

  try {
    mkdirSync(tmpDir, { recursive: true });

    execSync(
      `curl -sL "${tarballUrl}" | tar xz --strip-components=1 -C "${tmpDir}" "vibedgames-${BRANCH}/plugins"`,
      { stdio: "pipe" },
    );

    mkdirSync(targetDir, { recursive: true });

    const pluginsDir = join(tmpDir, "plugins");
    const installed: string[] = [];

    for (const plugin of readdirSync(pluginsDir)) {
      const skillsDir = join(pluginsDir, plugin, "skills");
      if (!existsSync(skillsDir)) continue;

      for (const skill of readdirSync(skillsDir)) {
        const dest = join(targetDir, skill);
        if (existsSync(dest)) rmSync(dest, { recursive: true });
        execSync(`cp -r "${join(skillsDir, skill)}" "${targetDir}/"`, {
          stdio: "pipe",
        });
        installed.push(skill);
      }
    }

    consola.success(`Installed ${installed.length} skills to ${targetDir}`);
    consola.log(`  ${installed.join(", ")}`);
  } catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  }
};
