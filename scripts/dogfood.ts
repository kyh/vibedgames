#!/usr/bin/env tsx
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
import path from "node:path";
import { checkSkillRefs, reportSkillRefs } from "./check-skill-refs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PLUGINS = path.join(ROOT, "plugins");
const SKILLS_DIR = path.join(ROOT, ".claude/skills");

const run = (cmd: string, args: string[], cwd = ROOT) => {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

console.log("→ bundling asset-tools into skill scripts/_lib/");

run("pnpm", ["--filter", "@repo/asset-tools", "build"]);

console.log("→ building vg CLI");

run("pnpm", ["--filter", "vibedgames", "build"]);

console.log("→ linking vg globally (points at apps/cli/dist)");

run("npm", ["link"], path.join(ROOT, "apps/cli"));

console.log("→ syncing .claude/skills/ with plugins/");

mkdirSync(SKILLS_DIR, { recursive: true });

const expected = new Map<string, string>();

for (const plugin of readdirSync(PLUGINS)) {
  const skillsRoot = path.join(PLUGINS, plugin, "skills");

  if (!existsSync(skillsRoot)) {
    continue;
  }

  for (const skill of readdirSync(skillsRoot)) {
    expected.set(skill, path.join(skillsRoot, skill));
  }
}

for (const name of readdirSync(SKILLS_DIR)) {
  const entry = path.join(SKILLS_DIR, name);

  if (!lstatSync(entry).isSymbolicLink()) {
    continue;
  }

  const target = readlinkSync(entry);
  const absTarget = path.resolve(SKILLS_DIR, target);
  const intoPlugins = absTarget.startsWith(`${PLUGINS}/`);

  if (!intoPlugins) {
    continue;
  }

  if (!expected.has(name) || expected.get(name) !== absTarget) {
    rmSync(entry);
    console.log(`  removed stale ${name}`);
  }
}

let linked = 0;

for (const [skill, src] of expected) {
  const dest = path.join(SKILLS_DIR, skill);
  const stat = lstatSync(dest, { throwIfNoEntry: false });

  if (stat) {
    if (stat.isSymbolicLink()) {
      rmSync(dest);
    } else {
      console.log(
        `  skip ${skill} (non-symlink already exists; remove manually if you want to replace)`,
      );
      continue;
    }
  }

  symlinkSync(path.relative(SKILLS_DIR, src), dest);
  linked += 1;
}

console.log(`  ${linked} skills linked`);

console.log();

const refs = checkSkillRefs(ROOT);

if (!reportSkillRefs(refs, ROOT)) {
  console.log("  ⚠ skill references above are broken — fix before committing.");
}

const which = spawnSync("sh", ["-c", "command -v vg"], { encoding: "utf-8" });
const vgPath = which.stdout?.trim();

console.log();

console.log("✓ done.");

console.log(
  `  vg               → ${vgPath || "not on PATH — run it as 'node apps/cli/dist/index.js'"}`,
);

console.log(`  skills symlinked → ${linked} into .claude/skills/`);

console.log();

console.log(
  "Edits to plugins/*/skills/* and apps/cli/src/* are live (rebuild CLI with 'pnpm dev:cli').",
);
