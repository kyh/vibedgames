import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import consola from "consola";
import { x as extract } from "tar";

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

    const res = await fetch(tarballUrl);
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download tarball: ${res.status}`);
    }

    const prefix = `vibedgames-${BRANCH}/plugins/`;
    await pipeline(
      Readable.fromWeb(res.body),
      extract({
        cwd: tmpDir,
        strip: 1,
        filter: (path) => path.startsWith(prefix),
      }),
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
        cpSync(join(skillsDir, skill), dest, { recursive: true });
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
