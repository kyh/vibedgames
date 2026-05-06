#!/usr/bin/env tsx
/**
 * Dogfood: link the local vg CLI and symlink local plugin skills into
 * .claude/skills/. Lets you build games in ./games using the same CLI/skills
 * end users get, with edits to plugins/* reflected live.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = join(ROOT, "plugins");
const SKILLS_DIR = join(ROOT, ".claude/skills");

const run = (cmd: string, args: string[], cwd = ROOT) => {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

console.log("→ building vg CLI");
run("pnpm", ["--filter", "vibedgames", "build"]);

console.log("→ linking vg globally (points at apps/cli/dist)");
// pnpm link --global needs PNPM_HOME setup; npm link works everywhere.
run("npm", ["link"], join(ROOT, "apps/cli"));

console.log("→ syncing .claude/skills/ with plugins/");
mkdirSync(SKILLS_DIR, { recursive: true });

const expected = new Map<string, string>(); // skill name → plugin source
for (const plugin of readdirSync(PLUGINS)) {
  const skillsRoot = join(PLUGINS, plugin, "skills");
  if (!existsSync(skillsRoot)) continue;
  for (const skill of readdirSync(skillsRoot)) {
    expected.set(skill, join(skillsRoot, skill));
  }
}

// Remove orphaned symlinks (point into ./plugins but the source is gone, or the
// target name doesn't match any current skill).
for (const name of readdirSync(SKILLS_DIR)) {
  const entry = join(SKILLS_DIR, name);
  if (!lstatSync(entry).isSymbolicLink()) continue;
  const target = readlinkSync(entry);
  const absTarget = resolve(SKILLS_DIR, target);
  const intoPlugins = absTarget.startsWith(PLUGINS + "/");
  if (!intoPlugins) continue;
  if (!expected.has(name) || expected.get(name) !== absTarget) {
    rmSync(entry);
    console.log(`  removed stale ${name}`);
  }
}

let linked = 0;
for (const [skill, src] of expected) {
  const dest = join(SKILLS_DIR, skill);
  const stat = lstatSync(dest, { throwIfNoEntry: false });
  if (stat) {
    if (stat.isSymbolicLink()) {
      rmSync(dest);
    } else {
      console.log(`  skip ${skill} (non-symlink already exists; remove manually if you want to replace)`);
      continue;
    }
  }
  // Use relative paths so symlinks work for anyone who clones the repo.
  symlinkSync(relative(SKILLS_DIR, src), dest);
  linked++;
}
console.log(`  ${linked} skills linked`);

const which = spawnSync("sh", ["-c", "command -v vg"], { encoding: "utf8" });
const vgPath = which.stdout?.trim() || "not on PATH";

console.log();
console.log("✓ done.");
console.log(`  vg               → ${vgPath}`);
console.log(`  skills symlinked → ${linked} into .claude/skills/`);
console.log();
console.log("Edits to plugins/*/skills/* and apps/cli/src/* are live (rebuild CLI with 'pnpm dev:cli').");
