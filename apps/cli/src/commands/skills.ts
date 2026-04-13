import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

const REPO = "kyh/vibedgames";
const SKILLS_PATH = ".claude/skills";
const BRANCH = "main";

export const skillsCommand = defineCommand({
  meta: {
    name: "skills",
    description: "Install vibedgames Claude Code skills into your project",
  },
  args: {
    dir: {
      type: "positional",
      description: "Project directory",
      required: false,
      default: ".",
    },
  },
  run: async ({ args }) => {
    const projectDir = args.dir;
    const targetDir = join(projectDir, SKILLS_PATH);
    const tarballUrl = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`;
    const tmpDir = join(projectDir, ".vg-skills-tmp");

    consola.start("Fetching skills from vibedgames...");

    try {
      // Download and extract just the skills directory
      mkdirSync(tmpDir, { recursive: true });

      execSync(
        `curl -sL "${tarballUrl}" | tar xz --strip-components=3 -C "${tmpDir}" "vibedgames-${BRANCH}/${SKILLS_PATH}"`,
        { stdio: "pipe" },
      );

      // Copy to target
      mkdirSync(targetDir, { recursive: true });
      execSync(`cp -r "${tmpDir}"/* "${targetDir}"/`, { stdio: "pipe" });

      // Count skills
      const skills = execSync(`ls "${targetDir}"`, { encoding: "utf-8" })
        .trim()
        .split("\n")
        .filter(Boolean);

      consola.success(`Installed ${skills.length} skills to ${targetDir}`);
      consola.log(`  ${skills.join(", ")}`);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true });
      }
    }
  },
});
